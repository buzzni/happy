import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ failRead: false }));
vi.mock('@/daemon/stagedCredentialRoot', () => ({ stagingParent: () => join(process.env.HAPPY_HOME_DIR!, 'staging-fixture') }));
vi.mock('@/utils/windowsPrivateFile', () => {
    class WindowsPrivateFileError extends Error {}
    return { WindowsPrivateFileError, windowsPrivateFile: {
        encode: (value: string, path: string) => JSON.stringify({ protectedFixture: Buffer.from(JSON.stringify({ value, path })).toString('base64') }),
        decode: (value: string, path: string) => {
            if (state.failRead) throw new WindowsPrivateFileError('WINDOWS_SECRET_READ_FAILED');
            const record = JSON.parse(Buffer.from(JSON.parse(value).protectedFixture, 'base64').toString());
            if (record.path !== path) throw new WindowsPrivateFileError('WINDOWS_SECRET_READ_FAILED');
            return record.value;
        },
    } };
});
import { configuration } from '@/configuration';
import {
    readCredentials, writeCredentialsDataKey, replaceCredentialsDataKey,
    readMachineIdentity, writeMachineIdentity, machineIdentityFile,
    readDaemonStateSnapshot, writeDaemonState, writeDaemonStateIfUnchanged, clearDaemonState,
    persistSession, readPersistedSessions,
    readSettings, writeSettings,
} from '@/persistence';
import { createMachineControlIo, pendingMachineKeyRotationFile } from '@/datakey/machineControlIo';
import { readStagedTokenFromHomeDir } from '@/daemon/resumeCredentials';
import { loadOrCreateMachineAutomationKey, readMachineAutomationKey } from '@/daemon/automations/machineAutomationKey';
import { stageUserCredentials } from '@/daemon/stageUserCredentials';
import { stagingParent } from '@/daemon/stagedCredentialRoot';

const key = new Uint8Array(32).fill(7), publicKey = new Uint8Array(32).fill(2);
const token = 'fixture-sensitive-token';
beforeEach(() => { state.failRead = false; });
describe('protected Windows private files across real consumers', () => {
    it('protects authoritative settings and refuses unreadable settings instead of resetting machine control', async () => {
        await writeSettings({ schemaVersion: 2, onboardingCompleted: true, machineId: 'same-machine', machineControl: 'strict' });
        expect(readFileSync(configuration.settingsFile, 'utf8')).not.toContain('same-machine');
        expect((await readSettings()).machineControl).toBe('strict');
        state.failRead = true;
        await expect(readSettings()).rejects.toThrow('WINDOWS_SECRET_READ_FAILED');
    });
    it('protects automation private keys and refuses unreadable keys without generating replacements', () => {
        const file = join(configuration.happyHomeDir, 'fixture-automation-key.json');
        const key = loadOrCreateMachineAutomationKey(file);
        expect(readFileSync(file, 'utf8')).not.toContain(Buffer.from(key.secretKey).toString('base64'));
        expect(readMachineAutomationKey(file)).toEqual(key);
        state.failRead = true;
        expect(() => loadOrCreateMachineAutomationKey(file)).toThrow('WINDOWS_SECRET_READ_FAILED');
        expect(() => readMachineAutomationKey(file)).toThrow('WINDOWS_SECRET_READ_FAILED');
    });
    it('removes a newly staged credential directory when the daemon control secret cannot be read', async () => {
        const parent = stagingParent(); mkdirSync(parent, { recursive: true });
        const before = readdirSync(parent).sort();
        writeDaemonState({ pid: 123, httpPort: 4567, startTime: 'fixture', startedWithCliVersion: 'fixture', controlSecret: token });
        state.failRead = true;
        await expect(stageUserCredentials(token, 'fixture-secret', configuration.daemonStateFile)).rejects.toThrow('WINDOWS_SECRET_READ_FAILED');
        expect(readdirSync(parent).sort()).toEqual(before);
    });
    it('round-trips credentials and atomic key replacement without plaintext on disk', async () => {
        await writeCredentialsDataKey({ token, publicKey, machineKey: key });
        expect(readFileSync(configuration.privateKeyFile, 'utf8')).not.toContain(token);
        expect((await readCredentials())?.token).toBe(token);
        await replaceCredentialsDataKey({ token: token + '-new', publicKey, machineKey: key });
        expect((await readCredentials())?.token).toBe(token + '-new');
        expect(await readStagedTokenFromHomeDir(configuration.happyHomeDir)).toBe(token + '-new');
    });
    it('never treats a decryption failure as absent credentials', async () => {
        await writeCredentialsDataKey({ token, publicKey, machineKey: key });
        const before = readFileSync(configuration.privateKeyFile);
        state.failRead = true;
        await expect(readCredentials()).rejects.toThrow('WINDOWS_SECRET_READ_FAILED');
        expect(readFileSync(configuration.privateKeyFile)).toEqual(before);
    });
    it('preserves the same machine ID/key and refuses unreadable identity', () => {
        const identity = { machineId: 'fixture-machine', machineKey: Buffer.from(key).toString('base64') };
        writeMachineIdentity(identity);
        expect(readFileSync(machineIdentityFile(), 'utf8')).not.toContain(identity.machineKey);
        expect(readMachineIdentity()).toEqual(identity);
        state.failRead = true;
        expect(() => readMachineIdentity()).toThrow('WINDOWS_SECRET_READ_FAILED');
    });
    it('uses the same protected codec for a pending key rotation', async () => {
        const io = createMachineControlIo({ token, machineId: 'fixture-machine' });
        const pending = { version: 1 as const, machineId: 'fixture-machine', fromKeySha256: 'a'.repeat(64), machineKey: Buffer.from(key).toString('base64'), dataEncryptionKey: 'fixture-envelope', serverRpcKeyEnvelope: null };
        await io.writePending(pending);
        expect(readFileSync(pendingMachineKeyRotationFile(), 'utf8')).not.toContain(pending.machineKey);
        expect(await io.readPending()).toEqual(pending);
    });
    it('keeps daemon control secrets private without losing compare-and-set or stopped state', async () => {
        const daemon = { pid: 123, httpPort: 4567, startTime: 'fixture-start', startedWithCliVersion: 'fixture', controlSecret: token };
        writeDaemonState(daemon);
        expect(readFileSync(configuration.daemonStateFile, 'utf8')).not.toContain(token);
        const snap = await readDaemonStateSnapshot();
        expect(snap.state?.controlSecret).toBe(token);
        expect(writeDaemonStateIfUnchanged(snap.raw, { ...daemon, state: 'stopped' })).toBe(true);
        expect(writeDaemonStateIfUnchanged(snap.raw, daemon)).toBe(false);
        await clearDaemonState();
        expect((await readDaemonStateSnapshot()).state?.state).toBe('stopped');
    });
    it('round-trips session keys through the final path after an atomic rename', () => {
        persistSession('fixture-session', { encryptionKey: token, encryptionVariant: 'dataKey', seq: 1, metadataVersion: 1, agentStateVersion: 1, metadata: {} as never, savedAt: 1 });
        expect(readFileSync(configuration.sessionsFile, 'utf8')).not.toContain(token);
        expect(readPersistedSessions()['fixture-session'].encryptionKey).toBe(token);
        state.failRead = true;
        expect(() => readPersistedSessions()).toThrow('WINDOWS_SECRET_READ_FAILED');
    });
});

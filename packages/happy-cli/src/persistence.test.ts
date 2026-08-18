import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from './configuration';
import {
    persistSession,
    readDaemonStateSnapshot,
    readPersistedSessions,
    SandboxConfigSchema,
    writeDaemonState,
    writeDaemonStateIfUnchanged,
    type DaemonLocallyPersistedState,
    type PersistedSession,
} from './persistence';

describe('SandboxConfigSchema', () => {
    it('applies defaults when values are omitted', () => {
        const parsed = SandboxConfigSchema.parse({});

        expect(parsed).toEqual({
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
            extraWritePaths: ['/tmp'],
            denyWritePaths: ['.env'],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        });
    });

    it('accepts a fully custom valid sandbox config', () => {
        const parsed = SandboxConfigSchema.parse({
            enabled: true,
            workspaceRoot: '~/projects',
            sessionIsolation: 'custom',
            customWritePaths: ['~/projects/foo', '/var/tmp'],
            denyReadPaths: ['~/.ssh'],
            extraWritePaths: ['/tmp', '/private/tmp'],
            denyWritePaths: ['.env', '.secrets'],
            networkMode: 'custom',
            allowedDomains: ['api.openai.com', '*.github.com'],
            deniedDomains: ['tracking.example.com'],
            allowLocalBinding: false,
        });

        expect(parsed.enabled).toBe(true);
        expect(parsed.workspaceRoot).toBe('~/projects');
        expect(parsed.sessionIsolation).toBe('custom');
        expect(parsed.networkMode).toBe('custom');
        expect(parsed.allowedDomains).toEqual(['api.openai.com', '*.github.com']);
        expect(parsed.allowLocalBinding).toBe(false);
    });

    it('rejects invalid enum values', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                sessionIsolation: 'invalid',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                networkMode: 'invalid',
            }),
        ).toThrow();
    });

    it('rejects invalid field types', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                allowLocalBinding: 'yes',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                denyReadPaths: [123],
            }),
        ).toThrow();
    });
});

describe('session persistence retention', () => {
    const originalSessionsFile = configuration.sessionsFile;
    let testDirectory: string;

    beforeEach(() => {
        testDirectory = mkdtempSync(join(tmpdir(), 'happy-persistence-'));
        Object.defineProperty(configuration, 'sessionsFile', {
            configurable: true,
            value: join(testDirectory, 'sessions.json'),
        });
    });

    afterEach(() => {
        Object.defineProperty(configuration, 'sessionsFile', {
            configurable: true,
            value: originalSessionsFile,
        });
        rmSync(testDirectory, { recursive: true, force: true });
    });

    function session(savedAt: number): PersistedSession {
        return {
            encryptionKey: Buffer.alloc(32, 1).toString('base64'),
            encryptionVariant: 'dataKey',
            seq: 7,
            metadataVersion: 3,
            agentStateVersion: 2,
            metadata: {
                path: '/tmp/project',
                host: 'test-host',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/.happy/lib',
                happyToolsDir: '/tmp/.happy/tools',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
            savedAt,
            lastProcessedSeq: 6,
        };
    }

    it('reads a valid session saved more than 15 days ago', () => {
        const oldSession = session(Date.now() - 15 * 24 * 60 * 60 * 1000);
        writeFileSync(
            configuration.sessionsFile,
            JSON.stringify({ sessions: { old: oldSession } }),
            'utf8',
        );

        expect(readPersistedSessions()).toEqual({ old: oldSession });
    });

    it('keeps an old session when persisting another session', () => {
        const oldSession = session(Date.now() - 15 * 24 * 60 * 60 * 1000);
        writeFileSync(
            configuration.sessionsFile,
            JSON.stringify({ sessions: { old: oldSession } }),
            'utf8',
        );

        persistSession('new', session(Date.now()));

        const persisted = JSON.parse(readFileSync(configuration.sessionsFile, 'utf8')) as {
            sessions: Record<string, PersistedSession>;
        };
        expect(persisted.sessions).toEqual({
            old: oldSession,
            new: expect.objectContaining({ savedAt: expect.any(Number) }),
        });
    });
});

describe('daemon state compare-and-set', () => {
    const originalDaemonStateFile = configuration.daemonStateFile;
    let testDirectory: string;

    beforeEach(() => {
        testDirectory = mkdtempSync(join(tmpdir(), 'happy-daemon-state-'));
        Object.defineProperty(configuration, 'daemonStateFile', {
            configurable: true,
            value: join(testDirectory, 'daemon.state.json'),
        });
    });

    afterEach(() => {
        Object.defineProperty(configuration, 'daemonStateFile', {
            configurable: true,
            value: originalDaemonStateFile,
        });
        rmSync(testDirectory, { recursive: true, force: true });
    });

    function daemonState(pid: number): DaemonLocallyPersistedState {
        return {
            pid,
            httpPort: 33417,
            startTime: '8/17/2026, 12:05:29 PM',
            startedWithCliVersion: '1.1.10',
            daemonLogPath: join(testDirectory, 'daemon.log'),
            state: 'running',
            trackedSessions: [],
        };
    }

    it('writes when the file still holds the contents the caller read', async () => {
        writeDaemonState(daemonState(111));
        const { raw } = await readDaemonStateSnapshot();

        expect(writeDaemonStateIfUnchanged(raw, daemonState(222))).toBe(true);
        expect((await readDaemonStateSnapshot()).state?.pid).toBe(222);
    });

    it('refuses to write when another process rewrote the file first', async () => {
        writeDaemonState(daemonState(111));
        const { raw } = await readDaemonStateSnapshot();

        // A daemon starts and claims the file between our read and our write.
        writeDaemonState(daemonState(999));

        expect(writeDaemonStateIfUnchanged(raw, daemonState(222))).toBe(false);
        expect((await readDaemonStateSnapshot()).state?.pid).toBe(999);
    });

    it('writes when the caller read an absent file that is still absent', async () => {
        const { state, raw } = await readDaemonStateSnapshot();

        expect(state).toBeNull();
        expect(writeDaemonStateIfUnchanged(raw, daemonState(222))).toBe(true);
        expect((await readDaemonStateSnapshot()).state?.pid).toBe(222);
    });
});

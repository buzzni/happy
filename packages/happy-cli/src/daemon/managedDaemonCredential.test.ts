/**
 * The credential a managed daemon runs as, and every way it may not be used.
 *
 * The failure this file exists to prevent is not "the daemon does not start".
 * It is a cloud runtime that, having failed to find its own credential, falls
 * back to the ordinary path and ends up holding an account bearer — one that
 * reaches every session on that account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import ts from 'typescript';
import { createManagedReceiptStore } from './managedReceiptStore';
import { createManagedRpcHandlers, type ManagedRuntime } from './managedRpcHandlers';
import { canonicalManagedPayloadDigest } from './managedDispatchToken';

import {
    MANAGED_DAEMON_CREDENTIAL_VERSION,
    createManagedCredentialReceiver,
    managedDaemonCredentialPath,
    readManagedDaemonCredential,
    replaceManagedDaemonCredential,
    writeManagedDaemonCredential,
} from '@/daemon/managedDaemonCredential';
import { probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const NOW = 1_800_000_000_000;
const MACHINE_KEY = Buffer.alloc(32, 9);
const ACCOUNT_KEY = Buffer.alloc(32, 3);
const MACHINE = 'machine-1';

function deps(over: Partial<ManagedProvisioningDeps> = {}): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: (path) => {
            if (!path.startsWith(base) || path === base) {
                return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
            }
            const stat = lstatSync(path);
            return {
                uid: 0,
                mode: stat.mode,
                isDirectory: stat.isDirectory(),
                isSymbolicLink: stat.isSymbolicLink(),
            };
        },
        statGate: () => null,
        probeIsolationBackend: probeIsolationBackendUnavailable,
        ...over,
    };
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: MANAGED_DAEMON_CREDENTIAL_VERSION,
        machineId: MACHINE,
        token: 'daemon.scoped.bearer',
        machineKey: MACHINE_KEY.toString('base64'),
        accountPublicKey: ACCOUNT_KEY.toString('base64'),
        expiresAt: NOW + 60_000,
        serverOrigin: 'https://happy.example.test',
        ...over,
    };
}

function credentialFor(over: Record<string, unknown> = {}) {
    return {
        machineId: MACHINE,
        token: 'daemon.scoped.bearer',
        machineKey: new Uint8Array(MACHINE_KEY),
        accountPublicKey: new Uint8Array(ACCOUNT_KEY),
        expiresAt: NOW + 60_000,
        serverOrigin: 'https://happy.example.test',
        ...over,
    };
}

function write(value: unknown): void {
    writeFileSync(managedDaemonCredentialPath(stateDir), JSON.stringify(value), { mode: 0o600 });
}

function read(over: { expectedMachineId?: string; now?: number } = {}) {
    return readManagedDaemonCredential({
        stateDir,
        expectedMachineId: over.expectedMachineId ?? MACHINE,
        now: over.now ?? NOW,
        deps: deps(),
    });
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'daemon-credential-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { mode: 0o700, recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('reading the credential a managed daemon runs as', () => {
    it('accepts the record the parent issued', () => {
        write(record());
        const outcome = read();
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.credential).toEqual({
            machineId: MACHINE,
            token: 'daemon.scoped.bearer',
            machineKey: new Uint8Array(MACHINE_KEY),
            accountPublicKey: new Uint8Array(ACCOUNT_KEY),
            expiresAt: NOW + 60_000,
            serverOrigin: 'https://happy.example.test',
        });
    });

    it('separates absent, unusable and expired', () => {
        // Three different answers for the caller: nothing was issued yet, what
        // was issued cannot be trusted, and renewal would fix it.
        expect(read()).toEqual({ ok: false, reason: 'absent' });
        write(record({ version: 99 }));
        expect(read()).toEqual({ ok: false, reason: 'unusable' });
        write(record({ expiresAt: NOW }));
        expect(read()).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses a credential issued for another Machine', () => {
        // Using it would publish this runtime's readiness on somebody else's
        // address — and the marker, not this file, says which Machine we are.
        write(record({ machineId: 'machine-2' }));
        expect(read()).toEqual({ ok: false, reason: 'wrong-machine' });
    });

    it('refuses a record the agent could have written', () => {
        write(record());
        expect(readManagedDaemonCredential({
            stateDir,
            expectedMachineId: MACHINE,
            now: NOW,
            deps: deps({ statGate: () => ({ reason: 'not-root-owned' }) }),
        })).toEqual({ ok: false, reason: 'unusable' });
    });

    it.each([
        ['a machine key of the wrong length', { machineKey: Buffer.alloc(16, 9).toString('base64') }],
        ['a machine key that is not canonical base64', { machineKey: 'AAAA*AAA' }],
        ['an account key of the wrong length', { accountPublicKey: Buffer.alloc(31, 3).toString('base64') }],
        ['no account key', { accountPublicKey: '' }],
        ['no token', { token: '   ' }],
        ['an expiry that is not a number', { expiresAt: 'soon' }],
        ['no server origin', { serverOrigin: '' }],
        ['a server origin that is not a URL', { serverOrigin: 'happy.example.test' }],
        ['a server origin with a non-http scheme', { serverOrigin: 'file:///etc/passwd' }],
    ])('refuses %s', (_name, over) => {
        write(record(over));
        expect(read()).toEqual({ ok: false, reason: 'unusable' });
    });

    it('refuses a record that is not JSON', () => {
        writeFileSync(managedDaemonCredentialPath(stateDir), 'nope', { mode: 0o600 });
        expect(read()).toEqual({ ok: false, reason: 'unusable' });
    });
});

describe('writing the credential', () => {
    const credential = {
        machineId: MACHINE,
        token: 'daemon.scoped.bearer',
        machineKey: new Uint8Array(MACHINE_KEY),
        accountPublicKey: new Uint8Array(ACCOUNT_KEY),
        expiresAt: NOW + 60_000,
        serverOrigin: 'https://happy.example.test',
    };

    it('round-trips through the reader', async () => {
        await writeManagedDaemonCredential({ stateDir, credential });
        expect(read()).toEqual({ ok: true, credential });
    });

    it('replaces an earlier credential for the same Machine', async () => {
        // Renewal issues a new bearer. A record that could not be replaced would
        // stop the runtime working the moment the first one expired.
        await writeManagedDaemonCredential({ stateDir, credential });
        await writeManagedDaemonCredential({
            stateDir,
            credential: { ...credential, token: 'renewed.bearer', expiresAt: NOW + 120_000 },
        });
        const outcome = read();
        expect(outcome.ok).toBe(true);
        if (outcome.ok) expect(outcome.credential.token).toBe('renewed.bearer');
    });

    it('leaves no readable file at a temporary name', async () => {
        // The write is a rename, so a crash leaves the old credential or the
        // new one — never a half-written record that reads as unusable.
        await writeManagedDaemonCredential({ stateDir, credential });
        expect(() => readFileSync(`${managedDaemonCredentialPath(stateDir)}.new`)).toThrow();
    });

    it('writes it readable only by its owner', async () => {
        await writeManagedDaemonCredential({ stateDir, credential });
        const mode = lstatSync(managedDaemonCredentialPath(stateDir)).mode & 0o777;
        expect(mode & 0o077).toBe(0);
    });

    it('flushes the directory entry', async () => {
        const synced: string[] = [];
        await writeManagedDaemonCredential({
            stateDir, credential, syncDirectory: async (path) => { synced.push(path); },
        });
        expect(synced).toEqual([stateDir]);
    });

    it('does not keep the key anywhere a later process inherits', async () => {
        // The machine key is a secret. It belongs in this file and in memory,
        // and nowhere a provider started later can read it.
        await writeManagedDaemonCredential({ stateDir, credential });
        const encoded = Buffer.from(MACHINE_KEY).toString('base64');
        expect(Object.values(process.env).some((value) => value?.includes(encoded))).toBe(false);
        chmodSync(managedDaemonCredentialPath(stateDir), 0o600);
    });
});

describe('two refreshers writing at the same time', () => {
    /*
     * The credential is refreshed by whoever notices it is close to expiry, and
     * "whoever" can be two callers at once — a heartbeat and a reconnect, or
     * two daemons briefly overlapping across a restart.
     *
     * With one shared temporary name they open the *same inode*: the first
     * renames it into place while the second is still writing, and the second's
     * bytes land inside the file that is already published. What comes back out
     * is neither credential.
     */
    it('never lets one writer land inside the other\'s published file', async () => {
        const first = credentialFor({ machineId: 'machine-first', token: 'token-first' });
        const second = credentialFor({ machineId: 'machine-first', token: 'token-second' });

        // Hold both fully written files before publication, then publish in a
        // known order. Each publication must expose that writer's entire value.
        const firstEntered = deferred();
        const secondEntered = deferred();
        const releaseFirst = deferred();
        const releaseSecond = deferred();
        const slow = writeManagedDaemonCredential({
            stateDir, credential: first,
            syncFile: async (handle) => {
                firstEntered.resolve();
                await releaseFirst.promise;
                await handle.sync();
            },
        });
        const other = writeManagedDaemonCredential({
            stateDir, credential: second,
            syncFile: async (handle) => {
                secondEntered.resolve();
                await releaseSecond.promise;
                await handle.sync();
            },
        });
        try {
            await Promise.all([firstEntered.promise, secondEntered.promise]);
            releaseFirst.resolve();
            await slow;
            const firstRead = read({ expectedMachineId: 'machine-first' });
            expect(firstRead).toMatchObject({ ok: true, credential: { token: first.token } });
            releaseSecond.resolve();
            await other;
            const secondRead = read({ expectedMachineId: 'machine-first' });
            expect(secondRead).toMatchObject({ ok: true, credential: { token: second.token } });
        } finally {
            releaseFirst.resolve();
            releaseSecond.resolve();
            await Promise.allSettled([slow, other]);
        }

        const readBack = read({ expectedMachineId: 'machine-first' });
        expect(readBack.ok).toBe(true);
        if (!readBack.ok) return;
        const credential = readBack.credential;
        // Whichever won, it is *one* of them in full — not a mixture.
        expect([first.token, second.token]).toContain(credential.token);
        expect(credential.machineId).toBe('machine-first');
        // And no temporary of either writer is left in the state directory.
        expect(readdirSync(stateDir).filter((name) => name.includes('tmp') || name.endsWith('.new')))
            .toEqual([]);
    });

    it('removes its own temporary when the write fails, and nobody else\'s', async () => {
        const other = join(stateDir, 'daemon-credential.json.someone-elses.tmp');
        writeFileSync(other, 'not mine', { mode: 0o600 });
        await expect(writeManagedDaemonCredential({
            stateDir,
            credential: credentialFor(),
            syncFile: async () => { throw new Error('injected file fsync failure'); },
        })).rejects.toThrow();
        // The other writer's file is untouched: cleaning up "temporaries" as a
        // class would delete the file a concurrent writer is about to publish.
        expect(readFileSync(other, 'utf8')).toBe('not mine');
        expect(readdirSync(stateDir).filter((name) => name.endsWith('.tmp')))
            .toEqual(['daemon-credential.json.someone-elses.tmp']);
    });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

/*
 * Replacing the bearer of a running runtime.
 *
 * A renewal extends *this* Machine's identity. Everything that says which
 * Machine it is — the key, the account it is wrapped for, the origin that
 * issued it — is carried from the stored record and never taken from the
 * replacement, because the replacement is a bearer and a bearer names nothing
 * on its own.
 */
describe('replacing the credential a managed daemon runs as', () => {
    const replacement = (over: Record<string, unknown> = {}) => ({
        token: 'daemon.renewed.bearer',
        expiresAt: NOW + 600_000,
        machineId: MACHINE,
        serverOrigin: 'https://happy.example.test',
        ...over,
    });

    const replace = (over: Record<string, unknown> = {}, now = NOW) => replaceManagedDaemonCredential({
        stateDir,
        expectedMachineId: MACHINE,
        replacement: replacement(over) as never,
        now,
        deps: deps(),
    });

    it('extends the bearer and keeps every identity axis', async () => {
        write(record());
        const outcome = await replace();
        expect(outcome).toEqual({ ok: true, expiresAt: NOW + 600_000 });

        const stored = read();
        expect(stored.ok).toBe(true);
        if (!stored.ok) return;
        expect(stored.credential.token).toBe('daemon.renewed.bearer');
        expect(stored.credential.expiresAt).toBe(NOW + 600_000);
        // The write-once half is exactly what it was.
        expect(stored.credential.machineKey).toEqual(new Uint8Array(MACHINE_KEY));
        expect(stored.credential.accountPublicKey).toEqual(new Uint8Array(ACCOUNT_KEY));
        expect(stored.credential.serverOrigin).toBe('https://happy.example.test');
        // And it is still 0600 — the file holds the machine key.
        expect(lstatSync(managedDaemonCredentialPath(stateDir)).mode & 0o777).toBe(0o600);
    });

    it('rescues a credential that has already expired', async () => {
        // This is when a renewal is most needed. Expiry is a property of the
        // bearer; the identity in the record does not expire with it.
        write(record({ expiresAt: NOW - 1 }));
        const outcome = await replace({}, NOW);
        expect(outcome).toEqual({ ok: true, expiresAt: NOW + 600_000 });
    });

    it('refuses one that does not outlive what is stored', async () => {
        write(record({ expiresAt: NOW + 600_000 }));
        // A replay of an earlier renewal would walk the window backwards.
        expect(await replace({ expiresAt: NOW + 600_000 })).toEqual({
            ok: false, reason: 'credential-not-newer',
        });
        expect(read().ok && readFileSync(managedDaemonCredentialPath(stateDir), 'utf8'))
            .toContain('daemon.scoped.bearer');
    });

    it.each([
        ['another Machine', { machineId: 'machine-2' }],
        ['another server', { serverOrigin: 'https://happy.other.test' }],
    ])('refuses one issued for %s', async (_name, over) => {
        write(record());
        expect(await replace(over)).toEqual({ ok: false, reason: 'credential-not-mine' });
        expect(readFileSync(managedDaemonCredentialPath(stateDir), 'utf8'))
            .toContain('daemon.scoped.bearer');
    });

    it('refuses when there is no usable record to extend', async () => {
        // Nothing to carry the identity axes from. Writing one from the
        // replacement alone would invent a Machine.
        expect(await replace()).toEqual({ ok: false, reason: 'credential-unreadable' });
    });

    it('reports a failed write rather than claiming the renewal took', async () => {
        write(record());
        const outcome = await replaceManagedDaemonCredential({
            stateDir,
            expectedMachineId: MACHINE,
            replacement: replacement() as never,
            now: NOW,
            deps: deps(),
            write: async () => { throw new Error('disk'); },
        });
        expect(outcome).toEqual({ ok: false, reason: 'credential-unwritable' });
    });
});


describe('credential publication durability', () => {
    it.each(['file', 'directory'] as const)('reports the %s sync failure without claiming rollback or success', async (stage) => {
        write(record());
        const outcome = await replaceManagedDaemonCredential({
            stateDir, expectedMachineId: MACHINE, now: NOW, deps: deps(),
            replacement: { token: 'new.bearer', expiresAt: NOW + 120_000, machineId: MACHINE, serverOrigin: 'https://happy.example.test' },
            write: (input) => writeManagedDaemonCredential({ ...input,
                ...(stage === 'file' ? { syncFile: async () => { throw new Error('private path'); } }
                    : { syncDirectory: async () => { throw new Error('private path'); } }),
            }),
        });
        expect(outcome).toEqual({ ok: false, reason: stage === 'file' ? 'credential-unwritable' : 'credential-durability-unknown' });
        expect(read()).toMatchObject({ ok: true, credential: { token: stage === 'file' ? 'daemon.scoped.bearer' : 'new.bearer' } });
        expect(readdirSync(stateDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
});


const receiverKeys = generateKeyPairSync('ed25519');
function receiverOptions() {
    return { runtimeId: 'runtime-1', workspaceId: 'ws-1', projectId: 'proj-1', keyId: 'kid-1',
        provisioningOperationId: 'op-1', happyMachineId: MACHINE, stateDir,
        verifier: receiverKeys.publicKey, now: () => NOW, deps: deps() };
}
function renewed(over: Record<string, unknown> = {}) {
    return { token: 'renewed.bearer', machineId: MACHINE, serverOrigin: 'https://happy.example.test', expiresAt: NOW + 120_000, ...over };
}
function signedCredential(params: unknown, over: Record<string, unknown> = {}, key = receiverKeys.privateKey) {
    const body = { v: 1, kid: 'kid-1', aud: 'runtime-1', op: 'credential', workspaceId: 'ws-1', projectId: 'proj-1',
        provisioningOperationId: 'op-1', epoch: 0, requestKey: 'request-1',
        payloadDigest: canonicalManagedPayloadDigest(params ?? {}), iat: NOW, exp: NOW + 60_000, ...over };
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
    return { token: `${encoded}.${sign(null, Buffer.from(encoded), key).toString('base64url')}`, params };
}

describe('signed credential receiver', () => {
    it('authenticates original material, trims only after digest, and preserves the stored identity', async () => {
        write(record({ expiresAt: NOW - 1 }));
        const receiver = createManagedCredentialReceiver(receiverOptions());
        const request = signedCredential(renewed({ token: '  renewed.bearer  ', machineId: ` ${MACHINE} `,
            serverOrigin: ' https://happy.example.test ', signedUnknown: { retainedInDigest: true } }), { epoch: 900 });
        expect(await receiver.replace(request)).toEqual({ ok: true, expiresAt: NOW + 120_000 });
        expect(read()).toEqual({ ok: true, credential: credentialFor({ token: 'renewed.bearer', expiresAt: NOW + 120_000 }) });
        // No iat floor and no lease epoch: a later bearer with the same iat still renews.
        expect(await receiver.replace(signedCredential(renewed({ expiresAt: NOW + 180_000 }), { epoch: 0 })))
            .toEqual({ ok: true, expiresAt: NOW + 180_000 });
    });
});

describe('receiver refusals and owned single-flight state', () => {
    it.each([
        [{ aud: 'other' }, 'token-wrong-audience'],
        [{ workspaceId: 'other' }, 'token-wrong-workspace'],
        [{ projectId: 'other' }, 'token-wrong-project'],
        [{ kid: 'other' }, 'token-unknown-key'],
        [{ provisioningOperationId: 'other' }, 'token-wrong-operation'],
        [{ op: 'status' }, 'token-wrong-op'],
        [{ exp: NOW }, 'token-expired'],
        [{ iat: NOW + 60_001, exp: NOW + 90_000 }, 'token-clock-skew'],
        [{ exp: NOW + 600_001 }, 'token-ttl-too-long'],
        [{ payloadDigest: 'not-original' }, 'token-payload-mismatch'],
    ])('refuses signed claim change %j without writing', async (over, reason) => {
        write(record());
        const writer = vi.fn(writeManagedDaemonCredential);
        const receiver = createManagedCredentialReceiver({ ...receiverOptions(), write: writer });
        expect(await receiver.replace(signedCredential(renewed(), over))).toEqual({ ok: false, reason });
        expect(writer).not.toHaveBeenCalled();
        expect(read()).toMatchObject({ ok: true, credential: { token: 'daemon.scoped.bearer' } });
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: true, expiresAt: NOW + 120_000 });
    });

    it('refuses wrong signatures and changed signed unknown fields', async () => {
        write(record());
        const writer = vi.fn(writeManagedDaemonCredential);
        const receiver = createManagedCredentialReceiver({ ...receiverOptions(), write: writer });
        expect(await receiver.replace(signedCredential(renewed(), {}, generateKeyPairSync('ed25519').privateKey)))
            .toEqual({ ok: false, reason: 'token-bad-signature' });
        const params = { ...renewed(), extra: 'signed' };
        const request = signedCredential(params);
        params.extra = 'changed';
        expect(await receiver.replace(request)).toEqual({ ok: false, reason: 'token-payload-mismatch' });
        expect(writer).not.toHaveBeenCalled();
    });

    it.each([null, undefined, [], 'string', 3, {}, { token: '' }, { token: 3 },
        { token: 'x', machineId: MACHINE, serverOrigin: 'https://happy.example.test', expiresAt: 1.5 },
        renewed({ token: '  ' }), renewed({ machineId: false }), renewed({ serverOrigin: [] }),
    ])('rejects signed malformed params %j after authentication', async (params) => {
        const writer = vi.fn(writeManagedDaemonCredential);
        const receiver = createManagedCredentialReceiver({ ...receiverOptions(), write: writer });
        expect(await receiver.replace(signedCredential(params))).toEqual({ ok: false, reason: 'malformed-request' });
        expect(writer).not.toHaveBeenCalled();
    });

    it.each([null, undefined, [], 'string', {}, { token: 1 }])('rejects malformed envelope %j', async (request) => {
        expect(await createManagedCredentialReceiver(receiverOptions()).replace(request)).toEqual({ ok: false, reason: 'malformed-request' });
    });

    it.each([NaN, Infinity, -1, 0.5])('refuses invalid own clock %s and releases busy', async (badClock) => {
        write(record());
        let clock = badClock;
        const receiver = createManagedCredentialReceiver({ ...receiverOptions(), now: () => clock });
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-clock-invalid' });
        clock = NOW;
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: true, expiresAt: NOW + 120_000 });
    });

    it('takes a fresh own clock for replacement expiry and closes a throwing clock', async () => {
        const now = vi.fn().mockReturnValueOnce(NOW).mockReturnValueOnce(NOW + 120_000);
        const receiver = createManagedCredentialReceiver({ ...receiverOptions(), now });
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-expired' });
        now.mockImplementationOnce(() => { throw new Error('private'); });
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-clock-invalid' });
        now.mockReturnValue(NOW);
        write(record());
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: true, expiresAt: NOW + 120_000 });
    });

    it.each([
        [renewed({ expiresAt: NOW }), 'credential-expired'],
        [renewed({ expiresAt: NOW + 60_000 }), 'credential-not-newer'],
        [renewed({ expiresAt: NOW + 59_999 }), 'credential-not-newer'],
        [renewed({ machineId: 'other' }), 'credential-not-mine'],
        [renewed({ serverOrigin: 'https://happy.example.test/' }), 'credential-not-mine'],
    ])('preserves replacement policy %j', async (params, reason) => {
        write(record());
        const writer = vi.fn(writeManagedDaemonCredential);
        expect(await createManagedCredentialReceiver({ ...receiverOptions(), write: writer }).replace(signedCredential(params)))
            .toEqual({ ok: false, reason });
        expect(writer).not.toHaveBeenCalled();
    });

    it('holds busy through real file and directory sync and owns input scalars', async () => {
        write(record());
        const fileEntered = deferred(), fileRelease = deferred(), dirEntered = deferred(), dirRelease = deferred();
        const options = receiverOptions();
        const statGate = vi.fn(options.deps.statGate!);
        options.deps.statGate = statGate;
        const writer = vi.fn((input: Parameters<typeof writeManagedDaemonCredential>[0]) => writeManagedDaemonCredential({ ...input,
            syncFile: async (handle) => { fileEntered.resolve(); await fileRelease.promise; await handle.sync(); },
            syncDirectory: async (path) => {
                dirEntered.resolve(); await dirRelease.promise;
                const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'));
                try { await handle.sync(); } finally { await handle.close(); }
            },
        }));
        const construction = { ...options, write: writer };
        const receiver = createManagedCredentialReceiver(construction);
        const overlaps: Array<ReturnType<typeof receiver.replace>> = [];
        const observeOverlap = async () => {
            const result = receiver.replace(signedCredential(renewed()));
            overlaps.push(result);
            return await Promise.race([result, new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))]);
        };
        const params = renewed();
        const first = receiver.replace(signedCredential(params));
        try {
            await fileEntered.promise;
            const reads = statGate.mock.calls.length;
            expect(await observeOverlap()).toEqual({ ok: false, reason: 'credential-busy' });
            expect(statGate).toHaveBeenCalledTimes(reads);
            params.token = 'mutated'; params.expiresAt = NOW + 999_000;
            construction.runtimeId = 'mutated'; construction.stateDir = '/invalid'; construction.happyMachineId = 'mutated';
            construction.now = () => NaN; construction.verifier = generateKeyPairSync('ed25519').publicKey;
            fileRelease.resolve(); await dirEntered.promise;
            expect(await observeOverlap()).toEqual({ ok: false, reason: 'credential-busy' });
            expect(writer).toHaveBeenCalledOnce();
            expect(statGate).toHaveBeenCalledTimes(reads);
            dirRelease.resolve();
            expect(await first).toEqual({ ok: true, expiresAt: NOW + 120_000 });
        } finally { fileRelease.resolve(); dirRelease.resolve(); await Promise.allSettled([first, ...overlaps]); }
        expect(read()).toMatchObject({ ok: true, credential: { token: 'renewed.bearer', expiresAt: NOW + 120_000 } });
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-not-newer' });
        expect(await receiver.replace(signedCredential(renewed({ expiresAt: NOW + 180_000 }))))
            .toEqual({ ok: true, expiresAt: NOW + 180_000 });
    });

    it('closes digest/read/write exceptions and frees the same receiver for a later request', async () => {
        const options = receiverOptions();
        let readThrows = true, writeThrows = true;
        options.deps.getuid = () => { if (readThrows) throw new Error('private read'); return DAEMON_UID; };
        const receiver = createManagedCredentialReceiver({ ...options,
            write: async (input) => { if (writeThrows) throw new Error('private write'); await writeManagedDaemonCredential(input); },
        });
        const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
        expect(await receiver.replace({ token: 'any', params: cyclic })).toEqual({ ok: false, reason: 'malformed-request' });
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-unreadable' });
        readThrows = false;
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-unreadable' });
        write(record({ version: 99 }));
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-unreadable' });
        write(record());
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-unwritable' });
        writeThrows = false;
        expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: true, expiresAt: NOW + 120_000 });
    });
});

it('the actual daemon replacement callback does not adopt a token after directory durability becomes unknown', async () => {
    // Execute the real AST-selected callback, without importing run.ts and its CLI startup side effects.
    const source = readFileSync(join(import.meta.dirname, 'run.ts'), 'utf8');
    const parsed = ts.createSourceFile('run.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const callbacks: ts.ArrowFunction[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'replaceCredential'
            && ts.isArrowFunction(node.initializer) && node.initializer.getText(parsed).includes('replaceManagedDaemonCredential')) {
            callbacks.push(node.initializer);
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(callbacks).toHaveLength(1);
    const js = ts.transpileModule(`(${callbacks[0].getText(parsed)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const replaceToken = vi.fn();
    const callback = new Function('replaceManagedDaemonCredential', 'identity', 'defaultProvisioningDeps', 'apiMachine', `return ${js}`)(
        (input: Parameters<typeof replaceManagedDaemonCredential>[0]) => replaceManagedDaemonCredential({ ...input,
            write: (args) => writeManagedDaemonCredential({ ...args, syncDirectory: async () => { throw new Error('private disk detail'); } }),
        }),
        { stateDir, happyMachineId: MACHINE }, deps(), { replaceToken },
    ) as (replacement: Parameters<typeof replaceManagedDaemonCredential>[0]['replacement']) => ReturnType<typeof replaceManagedDaemonCredential>;
    write(record());
    const outcome = await callback(renewed());
    expect(outcome).toEqual({ ok: false, reason: 'credential-durability-unknown' });
    expect(replaceToken).not.toHaveBeenCalled();
    const handlers = credentialHandlers(callback);
    await expect(handlers.credential(signedCredential(renewed({ expiresAt: NOW + 180_000 }), { epoch: 999 })))
        .rejects.toMatchObject({ code: 'credential-durability-unknown' });
    expect(replaceToken).not.toHaveBeenCalled();
    expect(read()).toMatchObject({ ok: true, credential: { token: 'renewed.bearer' } });
});


function credentialHandlers(replaceCredential: ManagedRuntime['replaceCredential']) {
    const admitted = receiverOptions();
    return createManagedRpcHandlers({
        identity: { runtimeId: admitted.runtimeId, workspaceId: admitted.workspaceId, projectId: admitted.projectId,
            keyId: admitted.keyId, provisioningOperationId: admitted.provisioningOperationId, happyMachineId: MACHINE,
            stateDir, verifier: admitted.verifier, configDigest: 'digest', providerMachineId: 'provider',
            providerInstanceId: 'instance', providerVolumeId: 'volume',
            isolation: { backend: 'privileged-launch-supervisor', provider: { uid: 901, gid: 901 }, executor: { uid: 902, gid: 901 }, cgroupRoot: '/unused' },
            toolPolicy: { grantTtlMs: 600_000, callTimeoutMs: 120_000 }, checkpoint: { drainBudgetMs: 15_000 },
            tenant: 'company:fixture', checkpointSchedule: { periodMs: 900_000, onTurnBoundary: true },
        },
        store: createManagedReceiptStore(join(base, 'receipts'), { assertHeld: () => {} }),
        now: () => NOW, monotonicNow: () => 0, spawn: async () => { throw new Error('unused'); }, isPidAlive: () => false,
        replaceCredential,
    });
}

it('matches current handler normalization while authenticating the original whitespace and extra fields', async () => {
    const normalized: unknown[] = [];
    const handlers = credentialHandlers(async (replacement) => { normalized.push(replacement); return { ok: true, expiresAt: replacement.expiresAt }; });
    const params = renewed({ token: '  token  ', machineId: ` ${MACHINE} `, serverOrigin: ' https://happy.example.test ', extra: 'signed' });
    expect(await handlers.credential(signedCredential(params))).toEqual({ accepted: true, expiresAt: NOW + 120_000 });
    write(record());
    expect(await createManagedCredentialReceiver(receiverOptions()).replace(signedCredential(params)))
        .toEqual({ ok: true, expiresAt: NOW + 120_000 });
    expect(normalized).toEqual([renewed({ token: 'token' })]);
    expect(read()).toMatchObject({ ok: true, credential: { token: 'token', machineId: MACHINE, serverOrigin: 'https://happy.example.test' } });
});


it('reports uncertain publication without equal-expiry retry success and releases the receiver slot', async () => {
    write(record());
    let failDirectory = true;
    const writer = vi.fn((input: Parameters<typeof writeManagedDaemonCredential>[0]) => writeManagedDaemonCredential({ ...input,
        ...(failDirectory ? { syncDirectory: async () => { throw new Error('private'); } } : {}),
    }));
    const receiver = createManagedCredentialReceiver({ ...receiverOptions(), write: writer });
    expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-durability-unknown' });
    expect(read()).toMatchObject({ ok: true, credential: { expiresAt: NOW + 120_000 } });
    failDirectory = false;
    expect(await receiver.replace(signedCredential(renewed()))).toEqual({ ok: false, reason: 'credential-not-newer' });
    expect(writer).toHaveBeenCalledOnce();
    expect(await receiver.replace(signedCredential(renewed({ expiresAt: NOW + 180_000 }))))
        .toEqual({ ok: true, expiresAt: NOW + 180_000 });
});

import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderUsageSpool } from './providerUsageSpool';
import { ProviderUsageRecovery } from './providerUsageRecovery';
import { createClaudeUsageEvent } from './providerUsageAdapters';
vi.mock('@/api/apiSession', () => ({ ApiSessionClient: vi.fn(function () {}) }));
vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'usage-recovery-')); roots.push(root);
    const recoveryKey = new Uint8Array(32).fill(9);
    const scope = { root, server: 'https://server.test', sessionId: 'never-resumed', key: new Uint8Array(32).fill(7), variant: 'legacy' as const, recoveryKey };
    const event = createClaudeUsageEvent({ sessionId: scope.sessionId, occurredAt: 123456, messageId: 'message', transcriptUuid: 'uuid', model: 'claude', usage: { input_tokens: 10, output_tokens: 5 } });
    const spool = new ProviderUsageSpool(scope);
    const send = vi.fn(async () => true);
    const resolve = vi.fn(async () => scope);
    const worker = new ProviderUsageRecovery({ root, server: scope.server, recoveryKey, resolve, send });
    return { root, scope, event, spool, send, resolve, worker };
}
it('replays a never-resumed session using authorized keys, removes only successful ACKs', async () => {
    const f = fixture(); f.spool.put(f.event);
    f.send.mockResolvedValueOnce(false);
    await f.worker.runOnce();
    expect(f.send).toHaveBeenCalledWith(f.event);
    expect(f.spool.load()).toEqual([f.event]);
    await f.worker.stop();
    const retry = new ProviderUsageRecovery({ ...f.scope, resolve: f.resolve, send: f.send });
    await retry.runOnce(); await retry.stop();
    expect(f.spool.load()).toEqual([]);
});
it('keeps unavailable credentials and other server/account data without sending', async () => {
    const f = fixture(); f.spool.put(f.event);
    for (const change of [{ resolve: async () => null }, { server: 'https://other.test' }, { recoveryKey: new Uint8Array(32).fill(5) }]) {
        const worker = new ProviderUsageRecovery({ ...f.scope, resolve: f.resolve, send: f.send, ...change });
        await worker.runOnce(); await worker.stop();
    }
    expect(f.send).not.toHaveBeenCalled(); expect(f.spool.load()).toEqual([f.event]);
});
it('migrates discoverable old-format directories and retains pending on failure', async () => {
    const f = fixture(); new ProviderUsageSpool({ ...f.scope, recoveryKey: undefined }).put(f.event);
    const worker = new ProviderUsageRecovery({ ...f.scope, resolve: f.resolve, send: async () => false,
        legacyPage: async () => [f.scope] });
    await worker.runOnce(); await worker.stop();
    expect(f.spool.load()).toEqual([f.event]);
    expect(readdirSync(f.root, { recursive: true }).map(String).some(p => p.endsWith('identity.enc'))).toBe(true);
});
it('isolates corrupt files, keeps original bytes and accepts duplicate delivery ACK', async () => {
    const f = fixture(); f.spool.put(f.event);
    const dir = join(f.root, readdirSync(f.root)[0]);
    writeFileSync(join(dir, 'bad.json'), 'broken');
    await Promise.all([f.worker.runOnce(), f.worker.runOnce()]); await f.worker.stop();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.spool.load()).toEqual([]);
    expect(readFileSync(join(dir, 'bad.json'), 'utf8')).toBe('broken');
});
it('encrypts identity without plaintext secrets and bounds each event batch', async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) f.spool.put({ ...f.event, sourceEventId: `event-${i}` });
    const dir = join(f.root, readdirSync(f.root)[0]);
    expect(readFileSync(join(dir, 'identity.enc'), 'utf8')).not.toContain(f.scope.sessionId);
    const worker = new ProviderUsageRecovery({ ...f.scope, resolve: f.resolve, send: f.send, batchSize: 2 });
    await worker.runOnce(); await worker.stop();
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.spool.load()).toHaveLength(3);
});

it('continues replay of known identities if legacy enumeration fails', async () => {
    const f = fixture(); f.spool.put(f.event);
    const worker = new ProviderUsageRecovery({ ...f.scope, resolve: f.resolve, send: f.send,
        legacyPage: async () => { throw new Error('unavailable'); } });
    await worker.runOnce(); await worker.stop();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.spool.load()).toEqual([]);
});
it('rejects an authorized lookup whose key does not match the directory', async () => {
    const f = fixture(); f.spool.put(f.event);
    const worker = new ProviderUsageRecovery({ ...f.scope, send: f.send,
        resolve: async () => ({ ...f.scope, key: new Uint8Array(32).fill(8) }) });
    await worker.runOnce(); await worker.stop();
    expect(f.send).not.toHaveBeenCalled(); expect(f.spool.load()).toEqual([f.event]);
});
it('recovers dataKey from the encrypted manifest only after an authorized lookup', async () => {
    const f = fixture(); const scope = { ...f.scope, variant: 'dataKey' as const };
    const spool = new ProviderUsageSpool(scope); spool.put(f.event);
    const resolve = vi.fn(async (_id, sealedSession) => sealedSession);
    const worker = new ProviderUsageRecovery({ ...scope, resolve, send: f.send });
    await worker.runOnce(); await worker.stop();
    expect(resolve).toHaveBeenCalledWith(scope.sessionId, { sessionId: scope.sessionId, key: Buffer.from(scope.key), variant: 'dataKey' });
    expect(f.send).toHaveBeenCalledOnce(); expect(spool.load()).toEqual([]);
});

const socketFactory = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketFactory }));
it.each([false, true])('production dataKey recovery authorizes the owner (old-format=%s) and handles duplicate ACKs', async oldFormat => {
    const { ApiClient } = await import('@/api/api');
    const { configuration } = await import('@/configuration');
    const { createHash } = await import('node:crypto');
    const { encrypt } = await import('@/api/encryption');
    const axios = (await import('axios')).default;
    const f = fixture();
    const previous = { happyHomeDir: configuration.happyHomeDir, serverUrl: configuration.serverUrl };
    Object.assign(configuration, { happyHomeDir: f.root, serverUrl: f.scope.server });
    const machineKey = new Uint8Array(32).fill(11);
    const recoveryKey = new Uint8Array(createHash('sha256').update('happy-usage-recovery-v1').update(machineKey).digest());
    const scope = { ...f.scope, root: join(f.root, 'usage-spool'), variant: 'dataKey' as const, recoveryKey };
    const spool = new ProviderUsageSpool({ ...scope, recoveryKey: oldFormat ? undefined : recoveryKey }); spool.put(f.event);
    const metadata = Buffer.from(encrypt(scope.key, 'dataKey', { path: '/workspace' })).toString('base64');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { sessions: oldFormat ? [{ id: scope.sessionId, metadata, dataEncryptionKey: 'account-envelope' }] : [], hasNext: false } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { sessions: [{ id: scope.sessionId, metadata, dataEncryptionKey: 'account-envelope' }] } });
    const sent = vi.fn();
    socketFactory.mockImplementation(() => {
        const listeners = new Map<string, (...args: any[]) => void>();
        const socket = { once: (name: string, handler: (...args: any[]) => void) => { listeners.set(name, handler); return socket; },
            connect: () => listeners.get('connect')?.(), disconnect: vi.fn(),
            emit: (_name: string, event: unknown, ack: (value: unknown) => void) => { sent(event); ack({ success: true }); ack({ success: true }); } };
        return socket;
    });
    vi.useFakeTimers();
    let stop: (() => Promise<void>) | undefined;
    try {
        let currentCredentials: import('@/persistence').Credentials = { token: 'account-token', encryption: { type: 'dataKey', machineKey, publicKey: new Uint8Array(32).fill(5) } };
        const api = await ApiClient.create(currentCredentials);
        stop = api.startUsageRecovery(async () => true, id => oldFormat && id === scope.sessionId ? scope : null, undefined, async () => currentCredentials);
        await vi.advanceTimersByTimeAsync(0);
        expect(post).toHaveBeenCalledWith(`${scope.server}/v2/sessions/lookup`, { ids: [scope.sessionId] }, expect.objectContaining({ maxRedirects: 0, headers: { Authorization: 'Bearer account-token' } }));
        expect(socketFactory).toHaveBeenCalledWith(scope.server, expect.objectContaining({ path: '/v1/updates', auth: expect.objectContaining({ token: 'account-token', sessionId: scope.sessionId }) }));
        expect(sent).toHaveBeenCalledExactlyOnceWith(f.event);
        expect(spool.load()).toEqual([]);
        // A later ownership refusal must not use the previously recovered key as authorization.
        post.mockResolvedValue({ data: { sessions: [] } });
        spool.put(f.event);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(sent).toHaveBeenCalledTimes(1);
        expect(spool.load()).toEqual([f.event]);
        const { rewrapUsageRecoveryKey } = await import('./providerUsageRecoveryKey');
        const rotated: import('@/persistence').Credentials = { token: 'account-token', encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(6), machineKey: new Uint8Array(32).fill(13) } };
        await rewrapUsageRecoveryKey(scope.root, currentCredentials, rotated);
        currentCredentials = { ...rotated, token: 'refreshed-account-token' };
        post.mockResolvedValue({ data: { sessions: [{ id: scope.sessionId, metadata, dataEncryptionKey: 'new-envelope' }] } });
        await vi.advanceTimersByTimeAsync(61_000);
        expect(sent).toHaveBeenCalledTimes(2); expect(spool.load()).toEqual([]);
        expect(socketFactory).toHaveBeenLastCalledWith(scope.server, expect.objectContaining({ auth: expect.objectContaining({ token: 'refreshed-account-token' }) }));
        await api.postSessionEvent('synthetic-global-session', 'synthetic', '');
        expect(post).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer account-token' }) }));
    } finally { await stop?.(); vi.useRealTimers(); get.mockRestore(); post.mockRestore(); Object.assign(configuration, previous); }
});
it('managed-machine never sends its machine bearer to account/session recovery routes', async () => {
    const { ApiClient } = await import('@/api/api');
    const { configuration } = await import('@/configuration');
    const axios = (await import('axios')).default;
    const get = vi.spyOn(axios, 'get'); const post = vi.spyOn(axios, 'post');
    socketFactory.mockClear();
    try {
        const api = ApiClient.managedMachine({ machineId: 'machine', token: 'machine-token', machineKey: new Uint8Array(32), serverOrigin: configuration.serverUrl });
        await api.startUsageRecovery()();
        expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); expect(socketFactory).not.toHaveBeenCalled();
    } finally { get.mockRestore(); post.mockRestore(); }
});
it('retains old dataKey queues that have neither a recovery manifest nor an authorized usable key', async () => {
    const f = fixture();
    const scope = { ...f.scope, variant: 'dataKey' as const, recoveryKey: undefined };
    const spool = new ProviderUsageSpool(scope); spool.put(f.event);
    const worker = new ProviderUsageRecovery({ ...f.scope, resolve: f.resolve, send: f.send, legacyPage: async () => [] });
    await worker.runOnce(); await worker.stop();
    expect(f.send).not.toHaveBeenCalled(); expect(spool.load()).toEqual([f.event]);
});
it('stops new network calls if daemon credentials are unavailable', async () => {
    const f = fixture();
    const { configuration } = await import('@/configuration');
    const previousHome = configuration.happyHomeDir;
    Object.assign(configuration, { happyHomeDir: f.root });
    const { ApiClient } = await import('@/api/api');
    const axios = (await import('axios')).default;
    const get = vi.spyOn(axios, 'get'); const post = vi.spyOn(axios, 'post');
    vi.useFakeTimers();
    let stop: (() => Promise<void>) | undefined;
    try {
        const api = await ApiClient.create({ token: 'account-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
        stop = api.startUsageRecovery(async () => false);
        await vi.advanceTimersByTimeAsync(0);
        expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    } finally { await stop?.(); vi.useRealTimers(); get.mockRestore(); post.mockRestore(); Object.assign(configuration, { happyHomeDir: previousHome }); }
});
it('does no server work for absent or ACK-empty spool directories, including repeated timer scans', async () => {
    const f = fixture(); f.spool.put(f.event); f.spool.remove(f.event.sourceEventId);
    const legacyPage = vi.fn(async () => []);
    const worker = new ProviderUsageRecovery({ ...f.scope, resolve: f.resolve, send: f.send, legacyPage });
    vi.useFakeTimers();
    try {
        worker.start(); await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(120_000);
        expect(f.resolve).not.toHaveBeenCalled(); expect(legacyPage).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
    } finally { await worker.stop(); vi.useRealTimers(); }
});
it('does not provision manifests for authorized server sessions without a pending local spool', async () => {
    const f = fixture();
    const legacyPage = vi.fn(async () => Array.from({ length: 20 }, (_, i) => ({ ...f.scope, sessionId: `empty-${i}` })));
    const worker = new ProviderUsageRecovery({ ...f.scope, resolve: f.resolve, send: f.send, legacyPage });
    await worker.runOnce(); await worker.stop();
    expect(legacyPage).not.toHaveBeenCalled(); expect(readdirSync(f.root)).toEqual([]);
});

const managedCiphertext = vi.hoisted(() => ({ root: '/workspace/.saycode-usage-spool' }));
vi.mock('@/usage/managedUsageSpool', async importOriginal => ({ ...await importOriginal<typeof import('./managedUsageSpool')>(), get MANAGED_USAGE_SPOOL_ROOT() { return managedCiphertext.root; } }));
it('managed parent provisions recovery before launch, uses fresh daemon authority and durably ACKs a never-resumed child', async () => {
    const { ApiClient } = await import('@/api/api');
    const { configuration } = await import('@/configuration');
    const axios = (await import('axios')).default;
    const f = fixture();
    const previous = { happyHomeDir: configuration.happyHomeDir, serverUrl: configuration.serverUrl };
    Object.assign(configuration, { happyHomeDir: f.root, serverUrl: f.scope.server });
    managedCiphertext.root = join(f.root, 'ciphertext');
    const api = ApiClient.managedMachine({ machineId: 'machine', token: 'initial-daemon', machineKey: new Uint8Array(32).fill(11), serverOrigin: f.scope.server });
    api.provisionManagedUsageRecovery({ sessionId: f.scope.sessionId, key: f.scope.key, serverOrigin: f.scope.server });
    const child = new ProviderUsageSpool({ ...f.scope, root: managedCiphertext.root, variant: 'dataKey', recoveryKey: undefined, publicCiphertext: true });
    child.put(f.event);
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { success: false } }).mockResolvedValue({ data: { success: true } });
    let token = 'current-daemon';
    vi.useFakeTimers();
    let stop: (() => Promise<void>) | undefined;
    try {
        stop = api.startUsageRecovery(undefined, undefined, async () => token);
        await vi.advanceTimersByTimeAsync(0); await stop();
        expect(child.load()).toEqual([f.event]);
        expect(post).toHaveBeenLastCalledWith(`${f.scope.server}/v1/machines/machine/usage-replay`, f.event,
            expect.objectContaining({ headers: { Authorization: 'Bearer current-daemon' }, maxRedirects: 0 }));
        token = 'renewed-daemon';
        stop = api.startUsageRecovery(undefined, undefined, async () => token);
        await vi.advanceTimersByTimeAsync(0); await stop();
        expect(post).toHaveBeenCalledTimes(2);
        expect(post).toHaveBeenLastCalledWith(expect.any(String), f.event, expect.objectContaining({ headers: { Authorization: 'Bearer renewed-daemon' } }));
        // Ciphertext is retained when the daemon has read-only access to the provider-owned directory.
        // Its private durable ACK prevents replay even after daemon restart.
        stop = api.startUsageRecovery(undefined, undefined, async () => token);
        await vi.advanceTimersByTimeAsync(60_000); await stop();
        expect(post).toHaveBeenCalledTimes(2);
    } finally { await stop?.(); vi.useRealTimers(); post.mockRestore(); Object.assign(configuration, previous); }
});

it('corrupt recovery wrapper degrades telemetry recovery without blocking session or daemon factories', async () => {
    const { ApiClient } = await import('@/api/api');
    const { ApiSessionClient } = await import('@/api/apiSession');
    const { configuration } = await import('@/configuration');
    const { rewrapUsageRecoveryKey } = await import('./providerUsageRecoveryKey');
    const f = fixture(), root = join(f.root, 'usage-spool');
    const previous = { happyHomeDir: configuration.happyHomeDir, serverUrl: configuration.serverUrl };
    const credentials: import('@/persistence').Credentials = { token: 'synthetic', encryption: { type: 'dataKey', publicKey: new Uint8Array(32), machineKey: new Uint8Array(32).fill(5) } };
    await rewrapUsageRecoveryKey(root, credentials, credentials);
    writeFileSync(join(root, readdirSync(root).find(p => p.endsWith('.enc'))!), 'corrupt-wrapper');
    Object.assign(configuration, { happyHomeDir: f.root, serverUrl: f.scope.server });
    try {
        const api = await ApiClient.create(credentials);
        const session = { id: f.scope.sessionId, encryptionKey: f.scope.key, encryptionVariant: 'dataKey' } as any;
        expect(() => api.sessionSyncClient(session)).not.toThrow();
        const store = vi.mocked(ApiSessionClient).mock.calls.at(-1)?.[3]?.providerUsageStore!;
        store.put(f.event); expect(store.load()).toEqual([f.event]);
        const stop = api.startUsageRecovery(); await stop();
        expect(store.load()).toEqual([f.event]);
    } finally { Object.assign(configuration, previous); }
});
it('persists managed 403 holds per session, continues valid queues, and retries only after daemon credential changes', async () => {
    const { ApiClient } = await import('@/api/api'); const { configuration } = await import('@/configuration');
    const axios = (await import('axios')).default; const f = fixture();
    const previous = { happyHomeDir: configuration.happyHomeDir, serverUrl: configuration.serverUrl };
    Object.assign(configuration, { happyHomeDir: f.root, serverUrl: f.scope.server }); managedCiphertext.root = join(f.root, 'ciphertext');
    const api = ApiClient.managedMachine({ machineId: 'machine', token: 'unused-initial', machineKey: new Uint8Array(32).fill(11), serverOrigin: f.scope.server });
    for (const id of ['denied', 'valid']) {
        api.provisionManagedUsageRecovery({ sessionId: id, key: f.scope.key, serverOrigin: f.scope.server });
        new ProviderUsageSpool({ ...f.scope, root: managedCiphertext.root, sessionId: id, variant: 'dataKey', recoveryKey: undefined, publicCiphertext: true }).put({ ...f.event, sessionId: id });
    }
    const denied = vi.fn(), valid = vi.fn();
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, event: any) => {
        if (event.sessionId === 'denied') { denied(); throw Object.assign(new Error('Forbidden'), { isAxiosError: true, response: { status: 403 } }); }
        valid(); return { data: { success: true } };
    });
    let token = 'current-daemon'; let stop: (() => Promise<void>) | undefined; vi.useFakeTimers();
    try {
        stop = api.startUsageRecovery(undefined, undefined, async () => token); await vi.advanceTimersByTimeAsync(5_000); await stop();
        expect(denied).toHaveBeenCalledTimes(1); expect(valid).toHaveBeenCalledTimes(1);
        expect(readdirSync(join(f.root, 'usage-spool'), { recursive: true }).map(String).filter(p => p.endsWith('held.enc'))).toHaveLength(1);
        stop = api.startUsageRecovery(undefined, undefined, async () => token); await vi.advanceTimersByTimeAsync(120_000); await stop();
        expect(denied).toHaveBeenCalledTimes(1); expect(valid).toHaveBeenCalledTimes(1);
        token = 'renewed-daemon'; stop = api.startUsageRecovery(undefined, undefined, async () => token); await vi.advanceTimersByTimeAsync(5_000); await stop();
        expect(denied).toHaveBeenCalledTimes(2); expect(valid).toHaveBeenCalledTimes(1);
    } finally { await stop?.(); vi.useRealTimers(); post.mockRestore(); Object.assign(configuration, previous); }
});

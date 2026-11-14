import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, fsyncSync, fstatSync, readSync, openSync, closeSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderUsageSpool } from './providerUsageSpool';
import { ProviderUsageDelivery } from './providerUsageDelivery';
import { createClaudeUsageEvent } from './providerUsageAdapters';
import { logger } from '@/ui/logger';
vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs, writeFileSync: vi.fn(fs.writeFileSync), fsyncSync: vi.fn(fs.fsyncSync), fstatSync: vi.fn(fs.fstatSync), readSync: vi.fn(fs.readSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'usage-spool-')); roots.push(root);
    const scope = { root, server: 'https://server.test', sessionId: 'session', key: new Uint8Array(32).fill(7), variant: 'legacy' as const };
    const event = createClaudeUsageEvent({ sessionId: 'session', occurredAt: 123456, messageId: 'message', transcriptUuid: 'uuid', model: 'claude', usage: { input_tokens: 10, output_tokens: 5 } });
    return { root, scope, event, spool: new ProviderUsageSpool(scope) };
}
it('stores encrypted events before sending and recovers a lost ACK in a new client', () => {
    const { scope, spool, event, root } = fixture();
    new ProviderUsageDelivery({ isConnected: () => true, emit: () => {
        expect(new ProviderUsageSpool(scope).load()).toEqual([event]);
    } }, spool).send(event);
    const files = readdirSync(root, { recursive: true }).map(String).filter(p => p.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(root, files[0]), 'utf8')).not.toContain('message');
    const emit = vi.fn((_event, ack) => ack(null, { success: true }));
    new ProviderUsageDelivery({ isConnected: () => true, emit }, new ProviderUsageSpool(scope)).resume();
    expect(emit).toHaveBeenCalledWith(event, expect.any(Function));
    expect(new ProviderUsageSpool(scope).load()).toEqual([]);
});
it('isolates server, session and encryption key without using a rotating bearer', () => {
    const { spool, scope, event } = fixture(); spool.put(event);
    for (const change of [{ server: 'https://other.test' }, { sessionId: 'other' }, { key: new Uint8Array(32).fill(8) }]) {
        expect(new ProviderUsageSpool({ ...scope, ...change }).load()).toEqual([]);
    }
    expect(new ProviderUsageSpool(scope).load()).toEqual([event]);
});
it('keeps corrupt files, warns and recovers valid events', () => {
    const { spool, root, event } = fixture(); spool.put(event);
    const file = readdirSync(root, { recursive: true }).map(String).find(p => p.endsWith('.json'))!;
    writeFileSync(join(root, file).replace(/[^/]+$/, 'corrupt.json'), 'broken');
    expect(spool.load()).toEqual([event]);
    expect(logger.warn).toHaveBeenCalled();
    expect(readdirSync(root, { recursive: true }).map(String).filter(p => p.endsWith('.json'))).toHaveLength(2);
});
it('retains an event in memory without sending when persistence fails', async () => {
    const { event } = fixture();
    const emit = vi.fn();
    const store = { load: () => [], put: vi.fn(() => { throw new Error('disk full'); }), remove: vi.fn() };
    const delivery = new ProviderUsageDelivery({ isConnected: () => true, emit }, store);
    delivery.send(event);
    expect(emit).not.toHaveBeenCalled();
    expect(delivery.unconfirmedIds()).toEqual([event.sourceEventId]);
    expect(logger.warn).toHaveBeenCalled();
    await delivery.close();
});

it('recovers committed events after the writing process is killed', () => {
    const { root, event, spool } = fixture();
    const script = `import { ProviderUsageSpool } from './src/usage/providerUsageSpool.ts';
      const spool = new ProviderUsageSpool({ root: ${JSON.stringify(root)}, server: 'https://server.test',
        sessionId: 'session', key: new Uint8Array(32).fill(7), variant: 'legacy' });
      spool.put(${JSON.stringify(event)});
      process.kill(process.pid, 'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
    expect(child.stderr).toBe('');
    expect(child.signal).toBe('SIGKILL');
    expect(spool.load()).toEqual([event]);
});
it('persists while offline and keeps the event until an ACK even after close', async () => {
    const { scope, spool, event } = fixture();
    const delivery = new ProviderUsageDelivery({ isConnected: () => false, emit: vi.fn() }, spool);
    delivery.send(event);
    await delivery.close();
    expect(new ProviderUsageSpool(scope).load()).toEqual([event]);
});
it('roundtrips dataKey encryption and rejects events for another session', () => {
    const { scope, event } = fixture();
    const spool = new ProviderUsageSpool({ ...scope, variant: 'dataKey' });
    spool.put(event);
    expect(spool.load()).toEqual([event]);
    expect(() => spool.put({ ...event, sessionId: 'other' })).toThrow('session mismatch');
});

it('retains acknowledged events when local cleanup fails, then clears them after safe redelivery', async () => {
    const { event } = fixture();
    const remove = vi.fn().mockImplementationOnce(() => { throw new Error('readonly disk'); });
    const store = { load: () => [event], put: vi.fn(), remove };
    const emit = vi.fn((_event, ack) => ack(null, { success: true }));
    const delivery = new ProviderUsageDelivery({ isConnected: () => true, emit }, store);
    delivery.resume();
    expect(delivery.unconfirmedIds()).toEqual([event.sourceEventId]);
    delivery.resume();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(delivery.unconfirmedIds()).toEqual([]);
    await delivery.close();
});

it('never overwrites a committed event when concurrent writers disagree, and duplicate ACK cleanup is harmless', () => {
    const { scope, event, spool } = fixture();
    spool.put(event);
    const other = new ProviderUsageSpool(scope);
    other.put(event);
    expect(() => other.put({ ...event, model: 'conflicting-model' })).toThrow('conflicting event');
    expect(spool.load()).toEqual([event]);
    other.remove(event.sourceEventId); spool.remove(event.sourceEventId);
    expect(spool.load()).toEqual([]);
});

it.each(['write', 'fsync'])('cleans temporary files on %s failure and retains committed events', failure => {
    const { spool, event, root } = fixture(); spool.put(event);
    const failing = failure === 'write' ? vi.mocked(writeFileSync) : vi.mocked(fsyncSync);
    failing.mockImplementationOnce(() => { throw new Error('original I/O failure'); });
    expect(() => spool.put({ ...event, sourceEventId: 'next' })).toThrow('original I/O failure');
    expect(spool.load()).toEqual([event]);
    expect(readdirSync(root, { recursive: true }).map(String).filter(p => p.endsWith('.tmp'))).toEqual([]);
});
it('does not mask the write failure if temporary cleanup also fails', () => {
    const { spool, event } = fixture(); spool.put(event);
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('original write failure'); });
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error('cleanup failure'); });
    expect(() => spool.put({ ...event, sourceEventId: 'next' })).toThrow('original write failure');
    expect(spool.load()).toEqual([event]); expect(logger.warn).toHaveBeenCalled();
});

it('bounds the read even when the file grows after fstat', async () => {
    const { readBoundedUsageFd } = await import('./managedUsageSpool');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { root } = fixture(); const path = join(root, 'growing');
    actual.writeFileSync(path, 'x'); const fd = openSync(path, 'r');
    vi.mocked(fstatSync).mockImplementationOnce(((handle: number) => {
        const before = actual.fstatSync(handle); actual.writeFileSync(path, 'x'.repeat(10000)); return before;
    }) as typeof fstatSync);
    try {
        expect(() => readBoundedUsageFd(fd, 128)).toThrow('oversize');
        const read = vi.mocked(readSync).mock.calls.at(-1) as unknown[] | undefined;
        expect(read?.[3]).toBe(129);
    } finally { closeSync(fd); }
});
it('retains a public FIFO replacement without blocking spool recovery', () => {
    const { root, event } = fixture();
    const script = `import { ProviderUsageSpool } from './src/usage/providerUsageSpool.ts';
      import { unlinkSync, readdirSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
      import { join } from 'node:path'; import { strict as assert } from 'node:assert';
      const spool = new ProviderUsageSpool({root:${JSON.stringify(root)},server:'https://server.test',sessionId:'session',key:new Uint8Array(32).fill(7),variant:'legacy',publicCiphertext:true});
      spool.put(${JSON.stringify(event)}); const file=join(spool.directory,readdirSync(spool.directory).find(x=>x.endsWith('.json')));
      unlinkSync(file); execFileSync('mkfifo',[file]); assert.deepEqual(spool.load(),[]);`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
});

it('commits recoverable identity before a first dataKey event even if killed exactly at event commit', () => {
    const { root, event } = fixture();
    const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      import { dirname, join } from 'node:path'; import { strict as assert } from 'node:assert';
      const link = fs.linkSync;
      fs.linkSync = (from, to) => { link(from, to); if (String(to).endsWith('.json')) {
        assert(fs.readFileSync(join(dirname(to),'identity.enc'),'utf8').length > 0); process.kill(process.pid, 'SIGKILL'); } };
      syncBuiltinESMExports(); const {ProviderUsageSpool} = await import('./src/usage/providerUsageSpool.ts');
      new ProviderUsageSpool({root:${JSON.stringify(root)},server:'https://server.test',sessionId:'session',key:new Uint8Array(32).fill(7),variant:'dataKey',recoveryKey:new Uint8Array(32).fill(9)}).put(${JSON.stringify(event)});`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 10000, encoding: 'utf8' });
    expect(child.signal, child.stderr).toBe('SIGKILL');
    const identity = readdirSync(root, { recursive: true }).map(String).find(p => p.endsWith('identity.enc'));
    expect(identity).toBeDefined();
    expect(new ProviderUsageSpool({root,server:'https://server.test',sessionId:'session',key:new Uint8Array(32).fill(7),variant:'dataKey'}).load()).toEqual([event]);
});

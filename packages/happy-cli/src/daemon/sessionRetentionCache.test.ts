import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRetention, type RetentionRecord } from './sessionRetention';

const homes: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function fixture() {
    const home = fs.mkdtempSync(join(tmpdir(), 'retention-cache-'));
    homes.push(home);
    const file = join(home, 'session-retention.v1.json');
    const open = () => createSessionRetention({ home, now: () => 1000, children: () => [{
        pid: 123, startedBy: 'daemon', happySessionId: 'a',
        runtime: { thinking: false, hasOpenToolCall: false, updatedAt: 1000 },
    }] });
    const write = (sessions: Record<string, RetentionRecord>) => {
        const temp = `${file}.replacement`;
        fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions }));
        fs.renameSync(temp, file);
    };
    return { file, open, write };
}
const kept: RetentionRecord = { policy: { mode: 'keep-alive' }, configuredAt: 1000, revision: 1 };

describe('retention store cache', () => {
    it('reads and parses one snapshot for a batch of idle candidates', () => {
        const h = fixture();
        h.write(Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`session-${i}`, kept])));
        const service = h.open();
        const contents = fs.readFileSync(h.file, 'utf8');
        const read = vi.spyOn(fs, 'readFileSync');
        const parse = vi.spyOn(JSON, 'parse');
        syncBuiltinESMExports();
        for (let i = 0; i < 100; i++) expect(service.record(`session-${i}`)).toEqual(kept);
        expect(read.mock.calls.filter(([file]) => file === h.file)).toHaveLength(1);
        expect(parse.mock.calls.filter(([input]) => input === contents)).toHaveLength(1);
    });

    it('invalidates after another service writes, replaces or deletes the file', async () => {
        const h = fixture(), service = h.open();
        expect(service.record('a')).toBeUndefined();
        await h.open().set({ sessionId: 'a', policy: kept.policy, expectedRevision: 0 });
        expect(service.record('a')).toEqual(kept);
        h.write({ a: { ...kept, configuredAt: 2000 } });
        expect(service.record('a')?.configuredAt).toBe(2000);
        fs.unlinkSync(h.file);
        expect(service.record('a')).toBeUndefined();
        h.write({ a: kept });
        expect(service.record('a')).toEqual(kept);
    });

    it('uses the newly committed policy for the next guard and checks revisions across services', async () => {
        const h = fixture(), service = h.open();
        h.write({ a: kept });
        expect(service.record('a')).toEqual(kept);
        await service.set({ sessionId: 'a', policy: { mode: 'default' }, expectedRevision: 1 });
        expect(service.record('a')).toMatchObject({ policy: { mode: 'default' }, revision: 2 });
        await h.open().set({ sessionId: 'a', policy: kept.policy, expectedRevision: 2 });
        await expect(service.set({ sessionId: 'a', policy: { mode: 'default' }, expectedRevision: 2 })).rejects.toThrow('RETENTION_CONFLICT');
        expect(service.record('a')).toMatchObject({ policy: kept.policy, revision: 3 });
    });

    it('keeps caller mutations out of the cached snapshot', async () => {
        const h = fixture(), service = h.open();
        const saved = await service.set({ sessionId: 'a', policy: { mode: 'idle', durationMs: 3600000 }, expectedRevision: 0 });
        const record = service.record('a')!;
        record.revision = 99;
        if (record.policy.mode === 'idle') record.policy.durationMs = 86400000;
        if (saved.policy.mode === 'idle') saved.policy.durationMs = 86400000;
        const snapshot = await service.get({ sessionId: 'a' });
        if (snapshot.policy.mode === 'idle') snapshot.policy.durationMs = 86400000;
        expect(service.record('a')).toMatchObject({ policy: { mode: 'idle', durationMs: 3600000 }, revision: 1 });
    });

    it('fails closed on a changed malformed store and recovers when it is replaced', async () => {
        const h = fixture(), service = h.open();
        h.write({ a: kept });
        expect(service.record('a')).toEqual(kept);
        fs.writeFileSync(h.file, '{broken');
        const read = vi.spyOn(fs, 'readFileSync');
        syncBuiltinESMExports();
        for (let i = 0; i < 5; i++) expect(() => service.record('a')).toThrow('RETENTION_STORE_UNAVAILABLE');
        await expect(service.set({ sessionId: 'a', policy: { mode: 'default' }, expectedRevision: 1 })).rejects.toThrow('RETENTION_STORE_UNAVAILABLE');
        expect(read.mock.calls.filter(([file]) => file === h.file)).toHaveLength(1);
        h.write({ a: kept });
        expect(service.record('a')).toEqual(kept);
    });

    it('fails closed on metadata errors even with a warm cache', () => {
        const h = fixture(), service = h.open();
        h.write({ a: kept });
        expect(service.record('a')).toEqual(kept);
        const stat = vi.spyOn(fs, 'statSync').mockImplementationOnce(() => { throw Error('permission denied'); });
        syncBuiltinESMExports();
        expect(() => service.record('a')).toThrow('RETENTION_STORE_UNAVAILABLE');
        stat.mockRestore();
        syncBuiltinESMExports();
        expect(service.record('a')).toEqual(kept);
    });

    it('retries transient read errors without serving an older snapshot', () => {
        const h = fixture(), service = h.open();
        h.write({ a: kept });
        expect(service.record('a')).toEqual(kept);
        h.write({ a: { ...kept, configuredAt: 2000 } });
        const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Error('temporary read failure'); });
        syncBuiltinESMExports();
        expect(() => service.record('a')).toThrow('RETENTION_STORE_UNAVAILABLE');
        read.mockRestore();
        syncBuiltinESMExports();
        expect(service.record('a')?.configuredAt).toBe(2000);
    });
});

import { describe, expect, it, vi } from 'vitest';
import { createWriteFileAttemptStore, isValidWriteFileAttemptId } from './writeFileAttempts';

const fingerprint = { path: '/p/notes.md', expectedHash: 'h0', contentHash: 'h1' };
const ok = { success: true, hash: 'h1' };

describe('write file attempt store', () => {
    it('runs a resend within the window as a replay of the first answer', async () => {
        const store = createWriteFileAttemptStore<typeof ok>({ ttlMs: 1000, now: () => 0 });
        const write = vi.fn(async () => ok);

        expect(store.run('attempt-1', fingerprint, write).kind).toBe('first');
        const resent = store.run('attempt-1', fingerprint, write);
        expect(resent.kind).toBe('replay');
        await expect(resent.kind === 'replay' ? resent.result : null).resolves.toBe(ok);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('refuses the same id for another path, base or content', () => {
        const store = createWriteFileAttemptStore<typeof ok>({ now: () => 0 });
        store.run('attempt-1', fingerprint, async () => ok);

        for (const other of [{ path: '/p/other.md' }, { expectedHash: null }, { contentHash: 'h2' }]) {
            expect(store.run('attempt-1', { ...fingerprint, ...other }, async () => ok).kind).toBe('conflict');
        }
    });

    it('forgets an attempt after the window so a late resend is judged again', () => {
        let now = 0;
        const store = createWriteFileAttemptStore<typeof ok>({ ttlMs: 1000, now: () => now });
        store.run('attempt-1', fingerprint, async () => ok);

        now = 1000;
        expect(store.run('attempt-1', { ...fingerprint, contentHash: 'h2' }, async () => ok).kind).toBe('first');
    });

    it('does not keep a failed answer', async () => {
        const store = createWriteFileAttemptStore<{ success: boolean }>({ now: () => 0 });
        const first = store.run('attempt-1', fingerprint, async () => ({ success: false }));
        await (first.kind === 'first' ? first.result : null);

        expect(store.size()).toBe(0);
        expect(store.run('attempt-1', fingerprint, async () => ok).kind).toBe('first');
    });

    it('gives a resend that joined a failing first attempt the same failure, then forgets it', async () => {
        const store = createWriteFileAttemptStore<{ success: boolean }>({ now: () => 0 });
        let fail!: () => void;
        const first = store.run('attempt-1', fingerprint, () => new Promise((resolve) => { fail = () => resolve({ success: false }); }));
        const resent = store.run('attempt-1', fingerprint, async () => ok);
        expect(resent.kind).toBe('replay');

        fail();
        await expect(first.kind === 'first' ? first.result : null).resolves.toEqual({ success: false });
        await expect(resent.kind === 'replay' ? resent.result : null).resolves.toEqual({ success: false });
        expect(store.size()).toBe(0);
    });

    it('keeps at most the configured number of records, dropping the oldest', () => {
        const store = createWriteFileAttemptStore<typeof ok>({ maxEntries: 2, now: () => 0 });
        for (const id of ['attempt-1', 'attempt-2', 'attempt-3']) store.run(id, fingerprint, async () => ok);

        expect(store.size()).toBe(2);
        expect(store.run('attempt-1', { ...fingerprint, contentHash: 'h2' }, async () => ok).kind).toBe('first');
        expect(store.run('attempt-3', { ...fingerprint, contentHash: 'h2' }, async () => ok).kind).toBe('conflict');
    });

    it('accepts only short url-safe ids', () => {
        expect(isValidWriteFileAttemptId('0b3f1c2e-7a9d-4c51-9e2f-6d8a1b2c3d4e')).toBe(true);
        for (const bad of ['short', 'has space here', 'slash/inside-id', 'x'.repeat(129), 42, null]) {
            expect(isValidWriteFileAttemptId(bad)).toBe(false);
        }
    });
});

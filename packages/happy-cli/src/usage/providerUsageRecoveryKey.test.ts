import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { loadUsageRecoveryKey, rewrapUsageRecoveryKey } from './providerUsageRecoveryKey';
import type { Credentials } from '@/persistence';
it('preserves the manifest key across rotation, reseed, and interrupted commit retry without plaintext keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-key-'));
    const cred = (n: number): Credentials => ({ token: 'same-account-token', encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(n), machineKey: new Uint8Array(32).fill(n) } });
    try {
        const old = cred(1), rotated = cred(2), reseeded = cred(3);
        const expected = loadUsageRecoveryKey(root, (old.encryption as any).machineKey);
        await rewrapUsageRecoveryKey(root, old, rotated); await rewrapUsageRecoveryKey(root, old, rotated);
        await rewrapUsageRecoveryKey(root, rotated, reseeded);
        expect(loadUsageRecoveryKey(root, (reseeded.encryption as any).machineKey)).toEqual(expected);
        for (const name of readdirSync(root)) { const text = readFileSync(join(root, name), 'utf8'); expect(text).not.toContain('same-account-token'); expect(text).not.toContain(Buffer.from(expected).toString('base64')); }
        await expect(rewrapUsageRecoveryKey(root, old, { ...rotated, token: 'foreign-account' })).rejects.toThrow('same authorized account');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

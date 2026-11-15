import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareManagedUsageSpool } from './managedUsageSpool';
it('creates a sticky ciphertext root and tolerates restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-spool-')); const path = join(root, 'ciphertext');
    try { prepareManagedUsageSpool(path, process.getuid!()); prepareManagedUsageSpool(path, process.getuid!()); expect(statSync(path).mode & 0o7777).toBe(0o1777); }
    finally { rmSync(root, { recursive: true, force: true }); }
});
it('refuses a symlink or differently owned spool root', () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-spool-')); const path = join(root, 'ciphertext');
    try { mkdirSync(join(root, 'target')); symlinkSync(join(root, 'target'), path); expect(() => prepareManagedUsageSpool(path, process.getuid!())).toThrow();
        expect(() => prepareManagedUsageSpool(join(root, 'other'), process.getuid!() + 1)).toThrow('unsafe'); }
    finally { rmSync(root, { recursive: true, force: true }); }
});
it('bounds reads and refuses symlinks', async () => {
    const { readBoundedUsageFile } = await import('./managedUsageSpool');
    const { writeFileSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'managed-spool-'));
    try {
        writeFileSync(join(root, 'large'), 'x'.repeat(1025));
        expect(() => readBoundedUsageFile(join(root, 'large'), 1024)).toThrow('unsafe');
        symlinkSync(join(root, 'large'), join(root, 'link'));
        expect(() => readBoundedUsageFile(join(root, 'link'), 2048)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
});
it('FIFO ciphertext and ACK files cannot block the daemon or supervisor', async () => {
    const { spawnSync } = await import('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'managed-fifo-'));
    try {
        const script = `import { execFileSync } from 'node:child_process';
          import { writeFileSync } from 'node:fs';
          import { strict as assert } from 'node:assert';
          import { readBoundedUsageFile, isAcknowledgedCiphertext } from './src/usage/managedUsageSpool.ts';
          execFileSync('mkfifo', [${JSON.stringify(join(root, 'fifo'))}]);
          writeFileSync(${JSON.stringify(join(root, 'ack'))}, JSON.stringify({digest:'a'.repeat(64)}));
          assert.throws(() => readBoundedUsageFile(${JSON.stringify(join(root, 'fifo'))}, 1024));
          assert.equal(isAcknowledgedCiphertext(${JSON.stringify(join(root, 'ack'))}, ${JSON.stringify(join(root, 'fifo'))}), false);
          assert.equal(isAcknowledgedCiphertext(${JSON.stringify(join(root, 'fifo'))}, ${JSON.stringify(join(root, 'ack'))}), false);`;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' });
        expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

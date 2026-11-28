import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDiscovery } from './fileDiscovery';
const roots: string[] = [];
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'discovery-'))); roots.push(root); return root; }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
describe.skipIf(process.platform !== 'darwin')('fileDiscovery IO boundary', () => {
    it('searches literal option-like text and honors exclusions, binary and size limits', async () => {
        const root = fixture();
        writeFileSync(join(root, 'a.txt'), 'first\n--version\n');
        writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
        writeFileSync(join(root, 'ignored.txt'), '--version');
        writeFileSync(join(root, 'binary'), '\0--version');
        writeFileSync(join(root, 'large'), '--version'.repeat(150000));
        mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules/a'), '--version');
        const result = await fileDiscovery(root, { version: 1, operation: 'search', root, query: '--version' });
        expect(result).toMatchObject({ success: true, partial: true, reason: 'file-limit', matches: [{ path: 'a.txt', line: 2, text: '--version' }] });
        rmSync(join(root, 'a.txt'));
        expect(await fileDiscovery(root, { version: 1, operation: 'search', root, query: '--version' })).toMatchObject({ success: true, partial: true, reason: 'file-limit', matches: [] });
    });
    it('rejects traversal, outside roots, leaf and ancestor symlinks for stat/read/search', async () => {
        const root = fixture(), outside = fixture();
        writeFileSync(join(outside, 'secret'), 'private'); symlinkSync(outside, join(root, 'jump'));
        for (const operation of ['stat', 'read']) {
            expect(await fileDiscovery(root, { version: 1, operation, root, path: '../secret' })).toMatchObject({ success: false });
            expect(await fileDiscovery(root, { version: 1, operation, root, path: 'jump/secret', offset: 0, length: 100 })).toMatchObject({ success: false });
        }
        expect(await fileDiscovery(root, { version: 1, operation: 'search', root: outside, query: 'private' })).toMatchObject({ success: false });
        expect(await fileDiscovery(root, { version: 1, operation: 'search', root, query: 'private' })).toMatchObject({ matches: [] });
    });
    it('bounds results and reads, checks identity across chunks and rechecks replaced paths', async () => {
        const root = fixture(); writeFileSync(join(root, 'a'), 'hit\n'.repeat(250));
        const search = await fileDiscovery(root, { version: 1, operation: 'search', root, query: 'hit' });
        expect(search.matches).toHaveLength(200); expect(search.partial).toBe(true);
        const read = await fileDiscovery(root, { version: 1, operation: 'read', root, path: 'a', offset: 0, length: 10 });
        expect(Buffer.from(read.content as string, 'base64').length).toBe(10);
        writeFileSync(join(root, 'a'), 'changed');
        expect(await fileDiscovery(root, { version: 1, operation: 'read', root, path: 'a', offset: 0, length: 10, identity: read.identity })).toMatchObject({ success: false });
        rmSync(join(root, 'a')); symlinkSync('/etc/passwd', join(root, 'a'));
        expect(await fileDiscovery(root, { version: 1, operation: 'stat', root, path: 'a' })).toMatchObject({ success: false });
        expect(await fileDiscovery(root, { version: 1, operation: 'search', root, query: '' })).toMatchObject({ success: false });
    });
    it('preserves matches and continues siblings after unreadable directories, ignore files and files', async () => {
        const root = fixture();
        mkdirSync(join(root, 'a-ignored')); symlinkSync('/etc/hosts', join(root, 'a-ignored/.gitignore'));
        writeFileSync(join(root, 'a-ignored/private'), 'needle');
        mkdirSync(join(root, 'b-locked')); chmodSync(join(root, 'b-locked'), 0);
        writeFileSync(join(root, 'c-locked'), 'needle'); chmodSync(join(root, 'c-locked'), 0);
        mkdirSync(join(root, 'd\\dir'));
        writeFileSync(join(root, 'e-good.txt'), 'needle');
        try {
            const result = await fileDiscovery(root, { version: 1, operation: 'search', root, query: 'needle' });
            expect(result).toMatchObject({ success: true, partial: true, matches: [{ path: 'e-good.txt', line: 1, text: 'needle' }] });
        } finally { chmodSync(join(root, 'b-locked'), 0o700); chmodSync(join(root, 'c-locked'), 0o600); }
    });

    it('reads at most 256 KiB per response while keeping the serialized reply below 512 KiB', async () => {
        const root = fixture(); writeFileSync(join(root, 'large'), Buffer.alloc(1024 * 1024, 97));
        const result = await fileDiscovery(root, { version: 1, operation: 'read', root, path: 'large', offset: 0, length: 262144 });
        expect(result.success).toBe(true);
        expect(Buffer.from(result.content!, 'base64')).toHaveLength(262144);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024);
        expect(await fileDiscovery(root, { version: 1, operation: 'read', root, path: 'large', offset: 0, length: 262145 })).toMatchObject({ success: false });
    });

});

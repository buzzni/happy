import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import {
    installManagedMachineTool,
    managedMachineToolStatus,
    resolveManagedMachineToolExecutable,
    type ManagedMachineTool,
} from './managedMachineTool';

const directories: string[] = [];
const SCRIPT = '#!/bin/sh\necho managed\n';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function temporary(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
}

async function archive(entries: (root: string) => Promise<void>): Promise<Buffer> {
    const source = await temporary('managed-tool-source-');
    await mkdir(join(source, 'fake-tool-v1'));
    await entries(join(source, 'fake-tool-v1'));
    const file = join(source, 'out.tar.gz');
    await tar.c({ gzip: true, file, cwd: source, portable: true }, ['fake-tool-v1']);
    return readFile(file);
}

const goodArchive = () => archive(async (root) => {
    await writeFile(join(root, 'fake-tool'), SCRIPT);
    await chmod(join(root, 'fake-tool'), 0o755);
    await writeFile(join(root, 'README.md'), 'readme');
});

function tool(bytes: Buffer, overrides: Partial<ManagedMachineTool['artifacts']['darwin-arm64']> = {}): ManagedMachineTool {
    const artifact = {
        url: 'https://github.com/buzzni/fake/releases/download/v1.0.0/fake-tool-v1.tar.gz',
        sha256: sha256(bytes),
        archiveRoot: 'fake-tool-v1',
        executableSha256: sha256(SCRIPT),
        ...overrides,
    };
    return { id: 'buzzni.fake', version: '1.0.0', executable: 'fake-tool', artifacts: { 'darwin-arm64': artifact, 'linux-x64': artifact } };
}

function serve(bytes: Buffer, finalUrl?: string) {
    return vi.fn(async (url: string) => ({ ok: true, status: 200, url: finalUrl ?? url, headers: new Headers(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }) as unknown as Response);
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('managed machine tool installer', () => {
    it('installs a pinned artifact into a per-version directory and reuses it afterwards', async () => {
        const root = await temporary('managed-tool-root-');
        const bytes = await goodArchive();
        const fetch = serve(bytes);
        const definition = tool(bytes);
        await expect(managedMachineToolStatus(definition, root, 'darwin-arm64')).resolves.toMatchObject({ supported: true, installed: false });

        const installed = await installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch });
        expect(installed).toMatchObject({ toolId: 'buzzni.fake', version: '1.0.0', installed: true });
        const executable = await resolveManagedMachineToolExecutable(definition, root, 'darwin-arm64');
        expect(executable).toBe(join(root, 'buzzni.fake', '1.0.0', 'fake-tool'));
        expect((await stat(executable)).mode & 0o777).toBe(0o700);

        await installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect((await readdir(join(root, 'buzzni.fake'))).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it.each([
        ['archive digest', (bytes: Buffer) => tool(bytes, { sha256: 'a'.repeat(64) }), 'MANAGED_TOOL_ARTIFACT_HASH_MISMATCH'],
        ['executable digest', (bytes: Buffer) => tool(bytes, { executableSha256: 'b'.repeat(64) }), 'MANAGED_TOOL_EXECUTABLE_HASH_MISMATCH'],
    ])('installs nothing when the %s does not match the pin', async (_label, make, code) => {
        const root = await temporary('managed-tool-root-');
        const bytes = await goodArchive();
        const definition = make(bytes);
        await expect(installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch: serve(bytes) })).rejects.toThrow(code);
        await expect(managedMachineToolStatus(definition, root, 'darwin-arm64')).resolves.toMatchObject({ installed: false });
        expect(await readdir(join(root, 'buzzni.fake')).catch(() => [])).toEqual([]);
    });

    it('rejects archives with links or entries outside the archive root', async () => {
        const root = await temporary('managed-tool-root-');
        const linked = await archive(async (base) => {
            await writeFile(join(base, 'real'), SCRIPT);
            await symlink('real', join(base, 'fake-tool'));
        });
        await expect(installManagedMachineTool(tool(linked), { root, platform: 'darwin-arm64', fetch: serve(linked) })).rejects.toThrow('MANAGED_TOOL_UNSAFE_ARCHIVE');
    });

    it('refuses an unpinned download host and an off-allowlist redirect', async () => {
        const root = await temporary('managed-tool-root-');
        const bytes = await goodArchive();
        await expect(installManagedMachineTool(tool(bytes, { url: 'https://example.com/fake.tar.gz' }), { root, platform: 'darwin-arm64', fetch: serve(bytes) }))
            .rejects.toThrow('MANAGED_TOOL_UNSAFE_URL');
        await expect(installManagedMachineTool(tool(bytes), { root, platform: 'darwin-arm64', fetch: serve(bytes, 'https://evil.example/fake.tar.gz') }))
            .rejects.toThrow('MANAGED_TOOL_UNSAFE_URL');
    });

    it('stops resolving a tampered executable and repairs it on the next install', async () => {
        const root = await temporary('managed-tool-root-');
        const bytes = await goodArchive();
        const definition = tool(bytes);
        await installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch: serve(bytes) });
        const executable = join(root, 'buzzni.fake', '1.0.0', 'fake-tool');
        await writeFile(executable, '#!/bin/sh\necho tampered\n');

        await expect(resolveManagedMachineToolExecutable(definition, root, 'darwin-arm64')).rejects.toThrow('MACHINE_RUN_TOOL_NOT_INSTALLED');
        await expect(managedMachineToolStatus(definition, root, 'darwin-arm64')).resolves.toMatchObject({ installed: false });
        await installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch: serve(bytes) });
        await expect(readFile(executable, 'utf8')).resolves.toBe(SCRIPT);
    });

    it('reports a platform without a pinned artifact as unsupported', async () => {
        const root = await temporary('managed-tool-root-');
        const definition = { ...tool(await goodArchive()), artifacts: {} };
        await expect(managedMachineToolStatus(definition, root, 'linux-x64')).resolves.toMatchObject({ supported: false, installed: false });
        await expect(installManagedMachineTool(definition, { root, platform: 'linux-x64', fetch: serve(Buffer.alloc(0)) })).rejects.toThrow('MANAGED_TOOL_UNSUPPORTED_PLATFORM');
    });

    it('serializes concurrent installs of the same tool into one download', async () => {
        const root = await temporary('managed-tool-root-');
        const bytes = await goodArchive();
        const fetch = serve(bytes);
        const definition = tool(bytes);
        await Promise.all([1, 2, 3].map(() => installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch })));
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
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

const goodArchive = (script = SCRIPT) => archive(async (root) => {
    await writeFile(join(root, 'fake-tool'), script);
    await chmod(join(root, 'fake-tool'), 0o755);
    await writeFile(join(root, 'README.md'), 'readme');
});

function tool(bytes: Buffer, overrides: Partial<ManagedMachineTool['artifacts']['darwin-arm64']> = {}, version = '1.0.0'): ManagedMachineTool {
    const artifact = {
        url: 'https://github.com/buzzni/fake/releases/download/v1.0.0/fake-tool-v1.tar.gz',
        sha256: sha256(bytes),
        archiveRoot: 'fake-tool-v1',
        executableSha256: sha256(SCRIPT),
        ...overrides,
    };
    return { id: 'buzzni.fake', version, executable: 'fake-tool', artifacts: { 'darwin-arm64': artifact, 'linux-x64': artifact } };
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

describe('managed machine tool stable executable link', () => {
    const SCRIPT_V2 = '#!/bin/sh\necho managed-v2\n';
    const linkPath = (root: string) => join(root, 'buzzni.fake', 'bin', 'fake-tool');
    const versioned = (root: string, version: string) => join(root, 'buzzni.fake', version, 'fake-tool');

    it('links bin/<executable> to the verified versioned executable after install and on verified reuse', async () => {
        const root = await temporary('managed-tool-root-');
        const bytes = await goodArchive();
        const fetch = serve(bytes);
        const definition = tool(bytes);
        await installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch });
        expect((await lstat(linkPath(root))).isSymbolicLink()).toBe(true);
        expect(await realpath(linkPath(root))).toBe(await realpath(versioned(root, '1.0.0')));

        await unlink(linkPath(root));
        await installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(await realpath(linkPath(root))).toBe(await realpath(versioned(root, '1.0.0')));
        expect((await readdir(join(root, 'buzzni.fake', 'bin'))).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it('moves the link to a newly installed version', async () => {
        const root = await temporary('managed-tool-root-');
        const v1 = await goodArchive();
        const v2 = await goodArchive(SCRIPT_V2);
        await installManagedMachineTool(tool(v1), { root, platform: 'darwin-arm64', fetch: serve(v1) });
        await installManagedMachineTool(tool(v2, { executableSha256: sha256(SCRIPT_V2) }, '2.0.0'), { root, platform: 'darwin-arm64', fetch: serve(v2) });
        expect(await realpath(linkPath(root))).toBe(await realpath(versioned(root, '2.0.0')));
        await expect(readFile(linkPath(root), 'utf8')).resolves.toBe(SCRIPT_V2);
    });

    it('never creates or moves the link when executable verification fails', async () => {
        const root = await temporary('managed-tool-root-');
        const v1 = await goodArchive();
        const v2 = await goodArchive(SCRIPT_V2);
        await expect(installManagedMachineTool(tool(v1, { executableSha256: 'b'.repeat(64) }), { root, platform: 'darwin-arm64', fetch: serve(v1) }))
            .rejects.toThrow('MANAGED_TOOL_EXECUTABLE_HASH_MISMATCH');
        await expect(lstat(linkPath(root))).rejects.toThrow();

        await installManagedMachineTool(tool(v1), { root, platform: 'darwin-arm64', fetch: serve(v1) });
        await expect(installManagedMachineTool(tool(v2, { executableSha256: 'c'.repeat(64) }, '2.0.0'), { root, platform: 'darwin-arm64', fetch: serve(v2) }))
            .rejects.toThrow('MANAGED_TOOL_EXECUTABLE_HASH_MISMATCH');
        expect(await realpath(linkPath(root))).toBe(await realpath(versioned(root, '1.0.0')));
    });

    it('keeps the install but leaves a foreign file or linked bin directory untouched', async () => {
        const fileRoot = await temporary('managed-tool-root-');
        const bytes = await goodArchive();
        await mkdir(join(fileRoot, 'buzzni.fake', 'bin'), { recursive: true });
        await writeFile(linkPath(fileRoot), 'user file');
        await expect(installManagedMachineTool(tool(bytes), { root: fileRoot, platform: 'darwin-arm64', fetch: serve(bytes) })).resolves.toMatchObject({ installed: true });
        await expect(readFile(linkPath(fileRoot), 'utf8')).resolves.toBe('user file');
        expect(await managedMachineToolStatus(tool(bytes), fileRoot, 'darwin-arm64')).not.toHaveProperty('executablePath');

        const dirRoot = await temporary('managed-tool-root-');
        const elsewhere = await temporary('managed-tool-elsewhere-');
        await mkdir(join(dirRoot, 'buzzni.fake'), { recursive: true });
        await symlink(elsewhere, join(dirRoot, 'buzzni.fake', 'bin'));
        await expect(installManagedMachineTool(tool(bytes), { root: dirRoot, platform: 'darwin-arm64', fetch: serve(bytes) })).resolves.toMatchObject({ installed: true });
        expect(await readdir(elsewhere)).toEqual([]);
    });

    it('reports the stable path, version and pinned digest only for a verified install', async () => {
        const root = await temporary('managed-tool-root-');
        const bytes = await goodArchive();
        const definition = tool(bytes);
        const before = await managedMachineToolStatus(definition, root, 'darwin-arm64');
        for (const field of ['executablePath', 'resolvedVersion', 'executableSha256']) expect(before).not.toHaveProperty(field);

        await installManagedMachineTool(definition, { root, platform: 'darwin-arm64', fetch: serve(bytes) });
        await expect(managedMachineToolStatus(definition, root, 'darwin-arm64')).resolves.toEqual({
            toolId: 'buzzni.fake', version: '1.0.0', platform: 'darwin-arm64', supported: true, installed: true,
            executablePath: linkPath(root), resolvedVersion: '1.0.0', executableSha256: sha256(SCRIPT),
        });

        await writeFile(versioned(root, '1.0.0'), '#!/bin/sh\necho tampered\n');
        const tampered = await managedMachineToolStatus(definition, root, 'darwin-arm64');
        expect(tampered).toMatchObject({ installed: false });
        for (const field of ['executablePath', 'resolvedVersion', 'executableSha256']) expect(tampered).not.toHaveProperty(field);
    });
});

import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import * as tar from 'tar';
import { logger } from '@/ui/logger';

/**
 * Host-owned tools a machine.run profile may execute. The daemon downloads a
 * pinned release artifact itself, so an extension never chooses what binary
 * lands on the machine, and a profile for a managed tool runs only that
 * verified binary — never whatever happens to be on PATH.
 */
export type ManagedMachineToolPlatform = 'darwin-arm64' | 'linux-x64';

export interface ManagedMachineToolArtifact {
    /** A first-party GitHub release asset (.tar.gz). */
    url: string;
    /** SHA-256 of the downloaded archive. */
    sha256: string;
    /** Single top-level directory every archive entry must live under. */
    archiveRoot: string;
    /** SHA-256 of the extracted executable, re-checked before every run. */
    executableSha256: string;
}

export interface ManagedMachineTool {
    id: string;
    version: string;
    /** Command name a profile uses; also the executable's file name in the archive root. */
    executable: string;
    artifacts: Partial<Record<ManagedMachineToolPlatform, ManagedMachineToolArtifact>>;
}

export interface ManagedMachineToolStatus {
    toolId: string;
    version: string;
    platform: ManagedMachineToolPlatform | null;
    supported: boolean;
    installed: boolean;
    /**
     * Stable user-facing link `<root>/<toolId>/bin/<executable>`, present only
     * while it resolves to the verified executable. machine.run never executes
     * through it; runs resolve and re-hash the versioned file.
     */
    executablePath?: string;
    /** Present only for a verified install. */
    resolvedVersion?: string;
    /** Pinned digest of the verified executable; present only for a verified install. */
    executableSha256?: string;
}

export type ManagedMachineToolFetch = (url: string, init: { redirect: 'follow' }) => Promise<Pick<Response, 'ok' | 'status' | 'url' | 'headers' | 'arrayBuffer'>>;

export interface ManagedMachineToolInstallOptions {
    root: string;
    platform: ManagedMachineToolPlatform | null;
    fetch?: ManagedMachineToolFetch;
    maxDownloadBytes?: number;
}

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const RELEASE_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/]+\/[^/]+\.tar\.gz$/;
const REDIRECT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const inFlight = new Map<string, Promise<ManagedMachineToolStatus>>();

function fail(code: string): never {
    throw new Error(code);
}

export function managedMachineToolPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ManagedMachineToolPlatform | null {
    if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
    if (platform === 'linux' && arch === 'x64') return 'linux-x64';
    return null;
}

function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function versionDirectory(tool: ManagedMachineTool, root: string): string {
    return join(root, tool.id, tool.version);
}

function stableExecutablePath(tool: ManagedMachineTool, root: string): string {
    return join(root, tool.id, 'bin', tool.executable);
}

function assertReleaseUrl(raw: string, initial: boolean): void {
    let url: URL;
    try { url = new URL(raw); } catch { fail('MANAGED_TOOL_UNSAFE_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('MANAGED_TOOL_UNSAFE_URL');
    const host = url.hostname.toLowerCase();
    if (initial ? host !== 'github.com' || url.search || !RELEASE_PATH.test(url.pathname) : !REDIRECT_HOSTS.has(host)) fail('MANAGED_TOOL_UNSAFE_URL');
}

/** Absolute path of the pinned executable, or null when absent, linked, or not byte-identical to the pin. */
async function verifiedExecutable(tool: ManagedMachineTool, root: string, platform: ManagedMachineToolPlatform | null): Promise<string | null> {
    const artifact = platform ? tool.artifacts[platform] : undefined;
    if (!artifact) return null;
    const path = join(versionDirectory(tool, root), tool.executable);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) return null;
    const bytes = await readFile(path).catch(() => null);
    return bytes && sha256(bytes) === artifact.executableSha256 ? path : null;
}

export async function managedMachineToolStatus(tool: ManagedMachineTool, root: string, platform: ManagedMachineToolPlatform | null): Promise<ManagedMachineToolStatus> {
    const artifact = platform ? tool.artifacts[platform] : undefined;
    const executable = artifact ? await verifiedExecutable(tool, root, platform) : null;
    const status = { toolId: tool.id, version: tool.version, platform, supported: Boolean(artifact), installed: Boolean(executable) };
    if (!artifact || !executable) return status;
    const link = stableExecutablePath(tool, root);
    const [linkTarget, executableTarget] = await Promise.all([realpath(link).catch(() => null), realpath(executable).catch(() => null)]);
    return {
        ...status,
        ...(linkTarget && linkTarget === executableTarget ? { executablePath: link } : {}),
        resolvedVersion: tool.version,
        executableSha256: artifact.executableSha256,
    };
}

export async function resolveManagedMachineToolExecutable(tool: ManagedMachineTool, root: string, platform: ManagedMachineToolPlatform | null): Promise<string> {
    if (!platform || !tool.artifacts[platform]) fail(`MACHINE_RUN_UNSUPPORTED_PLATFORM: no ${tool.id} artifact`);
    return await verifiedExecutable(tool, root, platform) ?? fail(`MACHINE_RUN_TOOL_NOT_INSTALLED: ${tool.id}@${tool.version}`);
}

async function download(artifact: ManagedMachineToolArtifact, options: ManagedMachineToolInstallOptions): Promise<Buffer> {
    assertReleaseUrl(artifact.url, true);
    const limit = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
    const response = await (options.fetch ?? fetch)(artifact.url, { redirect: 'follow' });
    if (!response.ok) fail(`MANAGED_TOOL_DOWNLOAD_FAILED: HTTP ${response.status}`);
    if (response.url && response.url !== artifact.url) assertReleaseUrl(response.url, false);
    const advertised = Number(response.headers?.get('content-length') ?? '');
    if (Number.isFinite(advertised) && advertised > limit) fail('MANAGED_TOOL_ARTIFACT_TOO_LARGE');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) fail('MANAGED_TOOL_ARTIFACT_TOO_LARGE');
    if (sha256(bytes) !== artifact.sha256) fail('MANAGED_TOOL_ARTIFACT_HASH_MISMATCH');
    return bytes;
}

/** Only regular files and directories under the archive root; no links, devices or traversal. */
async function extract(archivePath: string, artifact: ManagedMachineToolArtifact, destination: string): Promise<void> {
    const unsafe: string[] = [];
    const allowed = (path: string, type: string) => {
        const normalized = posix.normalize(path).replace(/\/$/, '');
        return (type === 'File' || type === 'Directory')
            && !posix.isAbsolute(normalized)
            && !normalized.split('/').includes('..')
            && (normalized === artifact.archiveRoot || normalized.startsWith(`${artifact.archiveRoot}/`));
    };
    await tar.t({ file: archivePath, strict: true, onReadEntry: (entry) => { if (!allowed(entry.path, entry.type)) unsafe.push(entry.path); } });
    if (unsafe.length > 0) fail('MANAGED_TOOL_UNSAFE_ARCHIVE');
    await mkdir(destination, { mode: 0o700 });
    await tar.x({ file: archivePath, cwd: destination, strict: true, preservePaths: false, filter: (path, entry) => allowed(path, (entry as tar.ReadEntry).type) });
}

/** Download, verify and atomically commit one version directory. */
async function installVersion(tool: ManagedMachineTool, artifact: ManagedMachineToolArtifact, options: ManagedMachineToolInstallOptions): Promise<void> {
    const parent = join(options.root, tool.id);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('MANAGED_TOOL_UNSAFE_INSTALL_ROOT');
    const stage = await mkdtemp(join(parent, `.${tool.version}.staging-`));
    try {
        const bytes = await download(artifact, options);
        const archivePath = join(stage, 'artifact.tar.gz');
        await writeFile(archivePath, bytes, { mode: 0o600 });
        const extracted = join(stage, 'extracted');
        await extract(archivePath, artifact, extracted);
        const staged = join(extracted, artifact.archiveRoot);
        const executable = join(staged, tool.executable);
        const info = await lstat(executable).catch(() => null);
        if (!info?.isFile()) fail('MANAGED_TOOL_UNSAFE_ARCHIVE');
        if (sha256(await readFile(executable)) !== artifact.executableSha256) fail('MANAGED_TOOL_EXECUTABLE_HASH_MISMATCH');
        await chmod(executable, 0o700);

        // A version directory that fails verification (tampered, partial) is moved
        // aside, never reused; the rename below is the only commit point.
        const target = versionDirectory(tool, options.root);
        if (await lstat(target).catch(() => null)) await rename(target, join(stage, 'replaced'));
        await rename(staged, target);
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}

/**
 * Point `<root>/<toolId>/bin/<executable>` at a verified versioned executable
 * so users and agents get one path that survives upgrades. It is a convenience
 * only: the daemon never runs a tool through it.
 *
 * The link is swapped in with a same-directory rename, so readers see the old
 * or the new target, never a missing one. A `bin` that is not our own real
 * directory, or a link path held by anything but a symlink, is left untouched
 * and the install still succeeds: the verified tool already works for
 * machine.run, while overwriting a user's file or writing through a redirected
 * directory would not be recoverable. The skip is logged, and the status then
 * omits `executablePath`.
 */
async function refreshStableLink(tool: ManagedMachineTool, root: string, executable: string): Promise<void> {
    const bin = join(root, tool.id, 'bin');
    const link = stableExecutablePath(tool, root);
    const staging = join(bin, `.${tool.executable}.${randomBytes(6).toString('hex')}.link`);
    try {
        await mkdir(bin, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
        const binInfo = await lstat(bin);
        if (!binInfo.isDirectory() || binInfo.isSymbolicLink() || (process.getuid && binInfo.uid !== process.getuid())) fail('bin is not a directory owned by this user');
        const existing = await lstat(link).catch(() => null);
        if (existing && !existing.isSymbolicLink()) fail('link path is occupied by a non-symlink');
        await symlink(relative(bin, executable), staging);
        await rename(staging, link);
    } catch (error) {
        await rm(staging, { force: true });
        logger.debug(`[managed-tool] skipped stable link for ${tool.id}@${tool.version}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function install(tool: ManagedMachineTool, options: ManagedMachineToolInstallOptions): Promise<ManagedMachineToolStatus> {
    const artifact = options.platform ? tool.artifacts[options.platform] : undefined;
    if (!artifact) fail('MANAGED_TOOL_UNSUPPORTED_PLATFORM');
    if (!await verifiedExecutable(tool, options.root, options.platform)) await installVersion(tool, artifact, options);
    // Only an executable that just passed the digest check is linked.
    const executable = await verifiedExecutable(tool, options.root, options.platform);
    if (executable) await refreshStableLink(tool, options.root, executable);
    return await managedMachineToolStatus(tool, options.root, options.platform);
}

/** Idempotent; concurrent installs of one tool version share a single download. */
export function installManagedMachineTool(tool: ManagedMachineTool, options: ManagedMachineToolInstallOptions): Promise<ManagedMachineToolStatus> {
    const key = `${options.root}\u0000${tool.id}\u0000${tool.version}`;
    const running = inFlight.get(key);
    if (running) return running;
    const started = install(tool, options).finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
}

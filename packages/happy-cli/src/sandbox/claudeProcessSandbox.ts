/** Whole-process Linux boundary for mandatory remote Claude sessions. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'shell-quote';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { getLinuxDependencyStatus, type LinuxDependencyStatus } from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js';
import { getApplySeccompBinaryPath, getPreGeneratedBpfPath } from '@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxConfig } from '@/persistence';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { resolveSandboxTrustFloor } from './config';
import { MandatorySandboxError } from './sandboxPolicy';

const CLAUDE_ENV = new Set([
    'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_THINKING_TOKENS',
]);

export function filterClaudeProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
        ...Object.fromEntries(Object.entries(env).filter(([key, value]) => CLAUDE_ENV.has(key) && value !== undefined)),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', TMPDIR: '/tmp',
    };
}

const TRUSTED_PATH = '/usr/local/bin:/usr/bin:/bin';
const DEFAULT_DOMAINS = ['api.anthropic.com', 'claude.ai', 'platform.claude.com'];
const DOMAIN_CONFIG = '/etc/aplus/claude-sandbox.json';

export function parseClaudeSandboxDomains(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw) as { allowedDomains?: unknown };
        const domains = parsed.allowedDomains;
        if (!Array.isArray(domains) || domains.length > 64 || domains.some(domain => typeof domain !== 'string'
            || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain))) throw new Error();
        return domains;
    } catch { throw new MandatorySandboxError('init-failed', 'invalid Claude domain policy'); }
}

function readClaudeSandboxDomains(): string[] {
    let fd: number;
    try { fd = openSync(DOMAIN_CONFIG, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_DOMAINS;
        throw new MandatorySandboxError('init-failed', 'unreadable Claude domain policy');
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new MandatorySandboxError('init-failed', 'untrusted Claude domain policy');
        return parseClaudeSandboxDomains(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
}

export function seedClaudeState(source: string, target: string): void {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const credential = join(target, '.credentials.json');
    if (existsSync(credential)) return;
    let contents: Buffer;
    let fd: number | undefined;
    try {
        fd = openSync(join(source, '.credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!fstatSync(fd).isFile()) throw new MandatorySandboxError('init-failed', 'invalid Claude credential file');
        contents = readFileSync(fd);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    // Never replace credentials refreshed by an earlier provider generation.
    writeFileSync(credential, contents, { flag: 'wx', mode: 0o600 });
}

export function buildProcessSandboxConfig(
    config: SandboxConfig, sessionPath: string, installPrefix: string, stagedPaths: string[],
    allowedDomains = DEFAULT_DOMAINS,
): SandboxRuntimeConfig {
    const cwd = resolve(sessionPath);
    if (['/', '/tmp', '/var', '/run', '/home', homedir()].includes(cwd)) {
        throw new MandatorySandboxError('unsafe-write-scope');
    }
    const denyRead = [...new Set([
        ...resolveSandboxTrustFloor(), configuration.happyHomeDir, ...stagedPaths,
        '/run/abp', '/etc/abp', '/var/lib/abp', '/var/run/docker.sock',
        ...config.denyReadPaths.map(path => resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()))),
    ])];
    return {
        network: { allowedDomains: config.networkMode === 'blocked' ? [] : allowedDomains, deniedDomains: config.deniedDomains, allowAllUnixSockets: false, allowUnixSockets: [] },
        filesystem: {
            allowWrite: [cwd], denyRead,
            denyWrite: [...denyRead, installPrefix, ...config.denyWritePaths.map(path => resolve(cwd, path))],
            allowGitConfig: false,
        },
        enableWeakerNestedSandbox: false,
    };
}

export function assertMandatoryDependencies(
    status: LinuxDependencyStatus, hasRipgrep: boolean,
    report: { errors: string[]; warnings: string[] } = { errors: [], warnings: [] },
): void {
    if (!Object.values(status).every(Boolean) || !hasRipgrep || report.errors.length || report.warnings.length) {
        throw new MandatorySandboxError('capability-unavailable', 'bwrap, socat, rg and seccomp are required');
    }
}

export function createArgvFile(directory: string, argv: string[], id: string = randomUUID()): string {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()
        || !/^[a-zA-Z0-9-]+$/.test(id) || argv.some(arg => arg.includes('\0'))) {
        throw new MandatorySandboxError('init-failed', 'invalid private argv transport');
    }
    const path = join(directory, id);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new MandatorySandboxError('init-failed');
        writeFileSync(fd, argv.join('\0') + '\0');
    } finally { closeSync(fd); }
    return path;
}

export function parseRuntimeCommand(command: string): string[] {
    return parse(command).map(value => {
        if (typeof value === 'string') return value;
        // shell-quote 1.8.3 represents even backslash-escaped '*' as a glob token.
        // The runtime quotes every argument; pass that pattern literally, never expand it.
        if ('op' in value && value.op === 'glob') return value.pattern;
        throw new MandatorySandboxError('init-failed', 'unexpected runtime shell operator');
    });
}

export type ClaudeProcessSandbox = {
    claudeConfigDir: string;
    spawn: (options: SpawnOptions) => ChildProcess;
    close: () => Promise<void>;
};

// SandboxManager is process-global. Never let a second preparation replace a live policy.
let active = false;
export async function prepareClaudeProcessSandbox(input: {
    sandboxConfig: SandboxConfig | undefined;
    sessionPath: string;
    mcpSocketPath?: string;
    allowedDomains?: string[];
    additionalDenyRead?: string[];
    additionalDenyWrite?: string[];
}): Promise<ClaudeProcessSandbox> {
    if (!input.sandboxConfig) throw new MandatorySandboxError('missing-config');
    if (!input.sandboxConfig.enabled) throw new MandatorySandboxError('disabled-config');
    if (process.platform !== 'linux' || active) throw new MandatorySandboxError('capability-unavailable');
    active = true;
    let directory: string | undefined;
    const originalPath = process.env.PATH;
    process.env.PATH = TRUSTED_PATH;
    try {
        let hasRipgrep = false;
        try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); hasRipgrep = true; } catch { /* fail closed below */ }
        assertMandatoryDependencies(getLinuxDependencyStatus(), hasRipgrep, SandboxManager.checkDependencies());
        const prefix = realpathSync(projectPath());
        const launcher = join(prefix, 'bin/claude-sandbox-launcher.sh');
        if (!lstatSync(launcher).isFile()) throw new MandatorySandboxError('init-failed', 'launcher unavailable');
        const stagedPaths = readdirSync(tmpdir()).filter(name => name.startsWith('happy-session-')).map(name => join(tmpdir(), name));
        directory = mkdtempSync('/tmp/happy-claude-argv-');
        const config = buildProcessSandboxConfig(input.sandboxConfig, realpathSync(input.sessionPath), prefix, stagedPaths, input.allowedDomains ?? readClaudeSandboxDomains());
        config.filesystem.denyRead.push(...(input.additionalDenyRead ?? []));
        config.filesystem.denyWrite.push(...(input.additionalDenyWrite ?? []));
        const stateParent = input.mcpSocketPath ? dirname(input.mcpSocketPath) : directory;
        const parentStat = lstatSync(stateParent);
        if (!parentStat.isDirectory() || parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o777) !== 0o700) {
            throw new MandatorySandboxError('init-failed', 'invalid session state directory');
        }
        const claudeState = join(stateParent, 'claude');
        seedClaudeState(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), claudeState);
        config.filesystem.denyRead.push(directory);
        await SandboxManager.initialize(config);
        const wrapped = await SandboxManager.wrapWithSandbox('true', '/bin/bash');
        const argv = parseRuntimeCommand(wrapped);
        const boundary = argv.indexOf('--');
        if (argv[0] !== 'bwrap' || boundary < 0 || !argv.includes('--unshare-net')
            || !argv.includes('--unshare-pid') || !argv.includes('--proc') || !argv.includes('--die-with-parent')
            || !argv.at(-1)?.includes('apply-seccomp')) {
            throw new MandatorySandboxError('capability-unavailable', 'unexpected sandbox-runtime wrapper');
        }
        const http = SandboxManager.getLinuxHttpSocketPath() ?? '';
        const socks = SandboxManager.getLinuxSocksSocketPath() ?? '';
        const base = argv.slice(0, boundary);
        // Runtime defaults include writable shared debug/log directories. D1 allows only cwd.
        for (let i = 1; i < base.length; i++) {
            if (base[i] === '--bind' && base[i + 1] === base[i + 2]
                && base[i + 1] !== realpathSync(input.sessionPath)
                && ![http, socks].includes(base[i + 1])) {
                base.splice(i, 3); i--;
            }
        }
        const rootMount = base.findIndex((arg, index) => arg === '--ro-bind' && base[index + 1] === '/' && base[index + 2] === '/');
        if (rootMount < 0) throw new MandatorySandboxError('init-failed', 'missing read-only root');
        // Hide host tmp BEFORE runtime write binds and deny masks. Rebinding the install
        // prefix after those masks would silently expose denied files beneath the prefix.
        const privateTmp = ['--cap-drop', 'ALL', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp'];
        if (prefix.startsWith('/tmp/') || prefix.startsWith('/var/tmp/')) privateTmp.push('--ro-bind', prefix, prefix);
        base.splice(rootMount + 3, 0, ...privateTmp);
        const mounts: string[] = [];
        for (const socket of [http, socks, input.mcpSocketPath]) {
            if (socket) mounts.push('--ro-bind', socket, socket);
        }
        mounts.push('--bind', claudeState, claudeState, '--setenv', 'CLAUDE_CONFIG_DIR', claudeState);
        // All argv stays data. The installed script starts only the fixed relays before seccomp.
        const prepared = [...base, ...mounts, '--', '/bin/bash', launcher, '--inside',
            getApplySeccompBinaryPath()!, getPreGeneratedBpfPath()!, http, socks, input.mcpSocketPath ?? ''];
        // A broken kernel/container sandbox is an initialization failure, before query().
        const probeFile = createArgvFile(directory, [...prepared, '/bin/true']);
        await new Promise<void>((resolveProbe, rejectProbe) => {
            const probe = spawn('/bin/bash', [launcher, probeFile], {
                cwd: input.sessionPath, env: { PATH: TRUSTED_PATH }, stdio: 'ignore',
            });
            const timer = setTimeout(() => { probe.kill('SIGKILL'); }, 10_000);
            probe.once('error', () => { clearTimeout(timer); rejectProbe(new MandatorySandboxError('init-failed')); });
            probe.once('exit', code => {
                clearTimeout(timer);
                if (code === 0) resolveProbe();
                else rejectProbe(new MandatorySandboxError('init-failed', 'sandbox preflight failed'));
            });
        });
        const children = new Set<ChildProcess>();
        const argvDirectory = directory;
        let closed = false;
        return {
            claudeConfigDir: claudeState,
            spawn(options) {
                if (closed || options.signal.aborted) throw new MandatorySandboxError('init-failed', 'spawn cancelled');
                const file = createArgvFile(argvDirectory, [...prepared, options.command, ...options.args]);
                try {
                    const child = spawn('/bin/bash', [launcher, file], {
                        cwd: options.cwd, env: { ...filterClaudeProcessEnv(options.env), PATH: TRUSTED_PATH }, signal: options.signal,
                        detached: true, stdio: ['pipe', 'pipe', 'inherit'],
                    });
                    children.add(child);
                    const cleanup = () => { children.delete(child); rmSync(file, { force: true }); };
                    child.once('exit', cleanup);
                    child.once('error', cleanup);
                    return child;
                } catch { rmSync(file, { force: true }); throw new MandatorySandboxError('init-failed'); }
            },
            async close() {
                if (closed) return;
                closed = true;
                await Promise.all([...children].map(child => new Promise<void>(resolveExit => {
                    child.once('exit', () => resolveExit());
                    child.kill('SIGKILL');
                })));
                await SandboxManager.reset();
                rmSync(argvDirectory, { recursive: true, force: true });
                active = false;
            },
        };
    } catch (error) {
        await SandboxManager.reset().catch(() => undefined);
        if (directory) rmSync(directory, { recursive: true, force: true });
        active = false;
        if (error instanceof MandatorySandboxError) throw error;
        throw new MandatorySandboxError('init-failed');
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
    }
}

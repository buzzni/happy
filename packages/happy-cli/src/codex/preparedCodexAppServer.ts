import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'cross-spawn';
import { withCodexRecallOwnership } from '@/memory/recallOwnerMarker';
import { sanitizeChildEnv } from '@/utils/childEnv';
import packageJson from '../../package.json';
import type { InitializeParams } from './codexAppServerTypes';
import { permitsPreparedSessionLinks } from './codexPreparedSessionLinks';
import { readSessionLinks, withoutSessionLinks, type SessionLinks } from '@/utils/sessionUrlEnv';
import { resolveCodexStateEnvironment } from './codexStateRecovery';

export const codexAppServerInitialization: InitializeParams = {
    clientInfo: { name: 'happy-codex', title: 'Happy Codex Client', version: packageJson.version },
    capabilities: {
        experimentalApi: true,
        // Happy consumes the response completion without the duplicate raw items.
        optOutNotificationMethods: ['rawResponseItem/completed'],
    },
};

export const codexAppServerArgs = [
    'app-server', '--listen', 'stdio://', '-c', 'features.default_mode_request_user_input=true',
] as const;

type Launch = { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string };
type Scope = { isCurrent(): boolean; signal?: AbortSignal };

export function resolveCodexAppServerBaseEnvironment(
    sessionEnv: NodeJS.ProcessEnv, startupEnvironment?: { CODEX_SQLITE_HOME: string },
): Promise<Record<string, string>> {
    return resolveCodexStateEnvironment({ ...sanitizeChildEnv(sessionEnv, { boundary: 'in-session' }), ...startupEnvironment });
}

export function applyCodexAppServerLogFilter(env: Record<string, string>): void {
    const filter = 'codex_core::rollout::list=off';
    if (!env.RUST_LOG) env.RUST_LOG = filter;
    else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) env.RUST_LOG += `,${filter}`;
}

/** Project the daemon's trusted session environment using the ordinary provider rules. */
export async function prepareCodexAppServerFromSessionEnvironment(launch: Launch, scope: Scope): Promise<PreparedCodexAppServer> {
    const env = withCodexRecallOwnership(await resolveCodexAppServerBaseEnvironment(launch.env), false);
    applyCodexAppServerLogFilter(env);
    return prepareCodexAppServer({ ...launch, env }, scope);
}

/** A server initialized in the eventual session owner's process tree. */
export interface PreparedCodexAppServer {
    readonly pluginsEnabled?: boolean;
    readonly sessionLinks?: SessionLinks;
    claim(launch: Launch): ChildProcess | undefined;
    dispose(): Promise<void>;
}

function launchDigest({ command, args, cwd, env }: Launch): string {
    const entries = Object.keys(env).filter(key => env[key] !== undefined).sort().map(key => [key, env[key]]);
    return createHash('sha256').update(JSON.stringify([command, args, cwd, entries])).digest('hex');
}

type PluginConfig = { features?: { plugins?: unknown } };

function resolvePluginPreference(configResult: unknown, requirementsResult: unknown, featuresResult: unknown): boolean {
    const { config, layers } = configResult as {
        config?: PluginConfig;
        layers?: Array<{ name?: { type?: string }; config?: PluginConfig; disabledReason?: string }>;
    };
    const { requirements } = requirementsResult as { requirements?: { featureRequirements?: { plugins?: unknown } | null } | null };
    const { data } = featuresResult as { data?: Array<{ name?: string; enabled?: unknown; defaultEnabled?: unknown }> };
    const plugins = Array.isArray(data) ? data.find(entry => entry?.name === 'plugins') : undefined;
    if (config?.features?.plugins !== false || plugins?.enabled !== false || typeof plugins.defaultEnabled !== 'boolean'
        || !Array.isArray(layers) || layers[0]?.name?.type !== 'sessionFlags'
        || layers[0].config?.features?.plugins !== false || requirements === undefined
        || (requirements !== null && !Object.hasOwn(requirements, 'featureRequirements'))) {
        throw new Error('Codex plugin preparation could not verify startup configuration');
    }
    const required = requirements?.featureRequirements?.plugins;
    if (required !== undefined) {
        if (required === false) return false;
        throw new Error('Codex plugin preparation cannot defer a required startup feature');
    }
    // Codex returns layers in precedence order. Skip just our launch flags and untrusted layers.
    for (const layer of layers.slice(1)) {
        if (!layer?.name?.type || layer.name.type === 'sessionFlags') throw new Error('Invalid Codex configuration layers');
        if (layer.disabledReason) continue;
        const enabled = layer.config?.features?.plugins;
        if (typeof enabled === 'boolean') return enabled;
        if (enabled !== undefined) throw new Error('Invalid Codex plugin configuration');
    }
    return plugins.defaultEnabled;
}

async function initialize(process: ChildProcess, cwd: string) {
    const { stdin, stdout } = process;
    if (!stdin || !stdout) throw new Error('Prepared Codex stdio unavailable');
    const lines = createInterface({ input: stdout });
    try {
        // These ids are outside the normal client's sequence.
        let id = 0;
        const deadline = performance.now() + 8_000;
        const request = (method: string, params?: unknown) => new Promise<unknown>((resolve, reject) => {
            const requestId = id--;
            const fail = () => finish(Error('Prepared Codex handshake failed'));
            const finish = (error?: Error, result?: unknown) => {
                clearTimeout(timer);
                lines.removeListener('line', onLine);
                lines.removeListener('close', fail);
                stdin.removeListener('error', fail);
                process.removeListener('error', fail);
                process.removeListener('exit', fail);
                if (error) reject(error);
                else resolve(result);
            };
            const onLine = (line: string) => {
                try {
                    const frame = JSON.parse(line);
                    if (frame?.id !== requestId) {
                        if (frame?.id != null) fail();
                        return;
                    }
                    if (!frame.result || frame.error) fail();
                    else finish(undefined, frame.result);
                } catch { fail(); }
            };
            const timer = setTimeout(fail, Math.max(deadline - performance.now(), 0));
            timer.unref();
            lines.on('line', onLine);
            lines.once('close', fail);
            process.once('error', fail);
            process.once('exit', fail);
            stdin.once('error', fail);
            stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
        });
        await request('initialize', codexAppServerInitialization);
        await new Promise<void>((resolve, reject) => {
            stdin.write('{"method":"initialized"}\n', error => error ? reject(error) : resolve());
        });
        const config = await request('config/read', { cwd, includeLayers: true });
        const requirements = await request('configRequirements/read');
        const features = await request('experimentalFeature/list', { limit: 250 });
        return { pluginsEnabled: resolvePluginPreference(config, requirements, features), canDeferSessionLinks: permitsPreparedSessionLinks(config, requirements) };
    } finally {
        lines.close();
        stdout.pause();
    }
}

/** The owner supplies the exact authorized launch and keeps its profile generation current. */
export async function prepareCodexAppServer(launch: Launch, scope: Scope): Promise<PreparedCodexAppServer> {
    if (!scope.isCurrent()) throw new Error('Codex preparation scope expired');
    const { signal } = scope;
    signal?.throwIfAborted();
    if (launch.args.length !== codexAppServerArgs.length || !codexAppServerArgs.every((arg, i) => launch.args[i] === arg)) {
        throw new Error('Codex preparation requires the ordinary app-server flags');
    }
    const fingerprint = launchDigest(launch);
    const child = spawn(launch.command, [...launch.args, '--disable', 'plugins'], {
        cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let ended = false;
    const exited = new Promise<void>(resolve => {
        const finish = () => { ended = true; resolve(); };
        child.once('exit', finish);
        child.on('error', () => { if (!child.pid) finish(); });
    });
    child.stdin?.on('error', () => {});
    child.stderr?.resume();
    let claimed = false;
    let discarded: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const detachOwner = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelPreparation);
    };
    const dispose = () => {
        detachOwner();
        if (claimed) return Promise.resolve();
        return discarded ??= (async () => {
            if (ended) return;
            const executable = win32.basename(child.spawnfile ?? '').toLowerCase();
            if (executable === 'cmd.exe' || executable === 'cmd') {
                // EOF lets the npm shim wait for its actual app-server child before exiting.
                child.stdin?.end();
            } else {
                child.kill();
            }
            let deadline: NodeJS.Timeout | undefined;
            try {
                await Promise.race([exited, new Promise<never>((_, reject) => {
                    deadline = setTimeout(() => reject(Object.assign(new Error('Prepared Codex process exit unconfirmed'), {
                        code: 'CODEX_PREPARED_EXIT_UNCONFIRMED',
                    })), 5_000);
                    deadline.unref();
                })]);
            } finally { clearTimeout(deadline); }
        })();
    };
    const cancelPreparation = () => { void dispose().catch(() => {}); };
    signal?.addEventListener('abort', cancelPreparation, { once: true });
    void exited.then(detachOwner);
    let initialized: Awaited<ReturnType<typeof initialize>>;
    try {
        initialized = await initialize(child, launch.cwd);
        signal?.throwIfAborted();
    } catch (error) {
        await dispose();
        signal?.throwIfAborted();
        throw error;
    }
    timer = setTimeout(() => void dispose().catch(() => {}), 45_000);
    timer.unref();
    let sessionLinks: SessionLinks | undefined;
    return {
        pluginsEnabled: initialized.pluginsEnabled,
        get sessionLinks() { return sessionLinks; },
        claim(expected) {
            if (claimed || discarded || ended || signal?.aborted || child.exitCode !== null || child.signalCode !== null
                || !child.stdin?.writable) return undefined;
            let links: SessionLinks | undefined;
            if (fingerprint !== launchDigest(expected)) {
                links = initialized.canDeferSessionLinks ? readSessionLinks(expected.env) : undefined;
                if (!links || fingerprint !== launchDigest({ ...expected, env: withoutSessionLinks(expected.env) })) return undefined;
            }
            try { if (!scope.isCurrent()) return undefined; }
            catch { return undefined; }
            if (signal?.aborted) return undefined;
            claimed = true;
            sessionLinks = links;
            detachOwner();
            return child;
        },
        dispose,
    };
}

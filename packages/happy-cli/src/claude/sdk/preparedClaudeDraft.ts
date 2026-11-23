import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveSettings, type ClaimOptions, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildSkillGovernanceOptions, readSkillGovernanceConfigFromEnv } from '@/orchestrator/skillGovernance';
import { isToolPolicyEnabled, sessionToolPolicyHookFiles } from '@/toolPolicy/claudeHook';
import { sanitizeChildEnv } from '@/utils/childEnv';
import { readSessionLinks, withoutSessionLinks, type SessionLinks } from '@/utils/sessionUrlEnv';
import { buildSessionHookSettings } from '../utils/sessionHookSettings';
import { ensureLocalProxyBypass } from '../utils/proxyBypass';
import { resolveHappyEntrypoint } from './happyEntrypoint';
import { prepareClaudeProcess } from './preparedClaudeProcess';

type Launch = {
    cwd: string;
    env: Record<string, string>;
    installRoot: string;
    port: number;
    abortController: AbortController;
};
type DraftClaim = {
    options: ClaimOptions;
    mcpServers: NonNullable<Options['mcpServers']>;
    requiredMcp: string[];
    links?: SessionLinks;
    allowTool?: Options['canUseTool'];
    signal?: AbortSignal;
};

export function claudeSdkEnvironment(source: NodeJS.ProcessEnv, hasMcpServers: boolean) {
    const env = sanitizeChildEnv(source, { boundary: 'in-session' });
    env.CLAUDE_CODE_ENTRYPOINT = resolveHappyEntrypoint(source.CLAUDE_CODE_ENTRYPOINT);
    if (hasMcpServers) ensureLocalProxyBypass(env);
    return env;
}

function settingsDocument(settings: Options['settings']): unknown {
    if (typeof settings !== 'string') return settings;
    return JSON.parse(isAbsolute(settings) ? readFileSync(settings, 'utf8') : settings);
}

// These SDK controls are either attached for this conversation or forwarded through claim().
function splitOptions(options: Options) {
    const { cwd, additionalDirectories, systemPrompt, model, permissionMode, effort, agents,
        mcpServers, allowedTools, abortController, canUseTool, settings, env, ...fixed } = options;
    const defined = Object.fromEntries(Object.entries(fixed).filter(([, value]) => value !== undefined));
    return { fixed: defined, settings: settingsDocument(settings), env, cwd, additionalDirectories, systemPrompt,
        model, permissionMode, effort, agents, mcpServers, allowedTools, abortController, canUseTool };
}

export function matchPreparedClaudeOptions(startup: Options, expected: Options, scope: Pick<Launch, 'cwd'>): DraftClaim | undefined {
    try {
        const pre = splitOptions(startup);
        const send = splitOptions(expected);
        if (!send.cwd || send.cwd !== scope.cwd || !isDeepStrictEqual(pre.fixed, send.fixed)
            || !isDeepStrictEqual(pre.settings, send.settings)) return;
        const prompt = send.systemPrompt;
        if (prompt !== undefined && (typeof prompt === 'string' || Array.isArray(prompt) || prompt.type !== 'preset'
            || prompt.excludeDynamicSections || prompt.snapshot)) return;
        if (send.allowedTools?.some(tool => !/^mcp__happy__[a-z0-9_]+$/i.test(tool))) return;

        const env = { ...send.env };
        const bearer = env.SAYCODE_MCP_BEARER;
        const sessionId = env.CLAUDE_CODE_HOST_SESSION_ID;
        delete env.SAYCODE_MCP_BEARER;
        delete env.CLAUDE_CODE_HOST_SESSION_ID;
        const exactEnvironment = isDeepStrictEqual(pre.env, env);
        const links = exactEnvironment ? undefined : readSessionLinks(env);
        if (!exactEnvironment && (!links || !isDeepStrictEqual(pre.env, withoutSessionLinks(env)))) return;

        const mcpServers = { ...send.mcpServers };
        const happy = mcpServers.happy;
        if (bearer) {
            if (!/^[a-f0-9]{64}$/.test(bearer) || happy?.type !== 'http' || !/^http:\/\/127\.0\.0\.1:[1-9]\d*\/$/.test(happy.url)
                || !isDeepStrictEqual(happy.headers, { Authorization: 'Bearer ${SAYCODE_MCP_BEARER}' })) return;
            // This is sent over the private SDK stream after activation, never as a CLI flag.
            mcpServers.happy = { ...happy, headers: { Authorization: `Bearer ${bearer}` } };
        }
        const claim: ClaimOptions = { cwd: send.cwd, model: send.model, permissionMode: send.permissionMode,
            additionalDirectories: send.additionalDirectories, agents: send.agents, appendSystemPrompt: prompt?.append,
            env: sessionId ? { CLAUDE_CODE_HOST_SESSION_ID: sessionId } : undefined };
        const base = pre.settings as Pick<NonNullable<ClaimOptions['settings']>, 'env' | 'permissions'> | undefined;
        if (send.effort || send.allowedTools?.length || links) claim.settings = {
            ...(send.effort ? { effortLevel: send.effort } : {}),
            ...(send.allowedTools?.length ? { permissions: { ...base?.permissions, allow: [...(base?.permissions?.allow ?? []), ...send.allowedTools] } } : {}),
            ...(links ? { env: { ...base?.env, ...links } } : {}),
        };
        return { options: claim, links, mcpServers, requiredMcp: happy ? ['happy'] : [], allowTool: send.canUseTool, signal: send.abortController?.signal };
    } catch {
        // An unreadable or concurrently rewritten settings file cannot justify reusing a process.
        return undefined;
    }
}

async function permitsLateSessionLinks(cwd: string, settingSources: Options['settingSources']): Promise<boolean> {
    // A SessionStart hook or native MCP may run before the flag overlay. Read local sources in the
    // activated environment and leave those launches on the original path.
    const { readClaudeMcpServerNames } = await import('@/aplus/launchMcpServers');
    if (readClaudeMcpServerNames({ configDir: process.env.CLAUDE_CONFIG_DIR || homedir(), cwd }).length) return false;
    try {
        const config = await resolveSettings({ cwd, settingSources });
        return config.sources.every(({ settings }) => !settings.policyHelper && !settings.hooks?.SessionStart?.length
            && !Object.values(settings.enabledPlugins ?? {}).some(enabled => enabled !== false));
    } catch { return false; }
}

async function verifySessionLinks(query: Query, links: SessionLinks): Promise<void> {
    const controls = query as Query & { getSettings?: () => Promise<{ effective?: { env?: Record<string, string> } }> };
    const effective = (await controls.getSettings?.())?.effective?.env;
    if (!effective || Object.entries(links).some(([key, value]) => effective[key] !== value)) {
        throw new Error('Prepared Claude session links were not applied');
    }
}

function nativeExecutableGeneration(command: string): string | undefined {
    if (!isAbsolute(command) || !/\.exe$/i.test(command)) return;
    try {
        const file = statSync(command, { bigint: true });
        if (file.isFile()) return `${file.dev}:${file.ino}:${file.ctimeNs}:${file.mtimeNs}:${file.size}`;
    } catch { /* An updated or missing binary retires its preparation. */ }
    return undefined;
}

export async function prepareClaudeDraft(scope: Launch) {
    const { env, installRoot, port, abortController } = scope;
    const homeDir = env.USERPROFILE || env.HOME;
    const executable = env.HAPPY_CLAUDE_PATH;
    const happyHomeDir = env.HAPPY_HOME_DIR || (homeDir && join(homeDir, '.happy'));
    if (executable !== undefined && (!isAbsolute(executable) || !/\.exe$/i.test(executable))
        || !homeDir || !isAbsolute(homeDir) || !happyHomeDir || !isAbsolute(happyHomeDir)
        || env.SAYCODE_MCP_BEARER || env.CLAUDE_CODE_HOST_SESSION_ID || env.APLUS_SESSION_ID || env.APLUS_SESSION_URL
        || env.HAPPY_AI_AUTH_SOURCE && !['personal-subscription', 'unknown'].includes(env.HAPPY_AI_AUTH_SOURCE)) return;
    const startup: Options = {
        pathToClaudeCodeExecutable: executable, includePartialMessages: true, promptSuggestions: true,
        ...buildSkillGovernanceOptions(readSkillGovernanceConfigFromEnv(env)),
        env: claudeSdkEnvironment(env, true),
        settings: JSON.stringify(buildSessionHookSettings({ homeDir, execPath: process.execPath, installRoot, env, port,
            toolPolicy: isToolPolicyEnabled(env) ? sessionToolPolicyHookFiles(happyHomeDir) : undefined })),
    };
    let native: { command: string; generation: string } | undefined;
    const processLease = await prepareClaudeProcess({ ...startup, abortController, allowDangerouslySkipPermissions: true,
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
            // An unset override lets the SDK choose its own embedded Windows executable, as on a cold start.
            const generation = nativeExecutableGeneration(command);
            if (!generation) throw new Error('Prepared Claude requires a native executable');
            native = { command, generation };
            return spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
        },
    });
    return {
        dispose: processLease.dispose,
        async claim(expected: Options, prompt: AsyncIterable<SDKUserMessage>) {
            const claim = matchPreparedClaudeOptions(startup, expected, scope);
            if (!claim || !native || native.generation !== nativeExecutableGeneration(native.command)
                || claim.links && !await permitsLateSessionLinks(claim.options.cwd, expected.settingSources)) {
                await processLease.dispose(); return;
            }
            const links = claim.links;
            const query = await processLease.claim({ ...claim, prompt,
                verifyClaim: links ? query => verifySessionLinks(query, links) : undefined,
            });
            const original = expected.mcpServers?.happy;
            const authenticated = claim.mcpServers.happy;
            if (!original || !authenticated || original === authenticated) return query;
            // Refreshes still use the original configuration, whose env placeholder is for cold launches.
            return new Proxy(query, { get(target, key) {
                if (key === 'setMcpServers') return ((servers) => target.setMcpServers(
                    isDeepStrictEqual(servers.happy, original) ? { ...servers, happy: authenticated } : servers)) satisfies Query['setMcpServers'];
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        },
    };
}

type Draft = NonNullable<Awaited<ReturnType<typeof prepareClaudeDraft>>>;
// Disk and resident bundles may each load a copy. The lease stays in the authorized worker.
const key = Symbol.for('happy.claude.preparedDraft');
const owner = globalThis as typeof globalThis & { [key]?: Draft };

export function offerClaudeDraft(draft: Draft) {
    if (owner[key]) throw new Error('Claude draft already offered');
    owner[key] = draft;
}

export function takeClaudeDraft(): Draft | undefined {
    const lease = owner[key];
    delete owner[key];
    return lease;
}

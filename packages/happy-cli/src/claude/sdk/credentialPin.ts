import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '../utils/claudeAuthOverrideEnv';

import { ORGANIZATION_CLAUDE_AUTH_FAILURE, PERSONAL_CLAUDE_AUTH_FAILURE } from '../utils/launchFailureMessage';
const CONTROL_TIMEOUT_MS = 10_000;
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
type LiveSettings = { effective: ObjectValue; sources: Array<{ source: string; settings: ObjectValue }> };
type PinControls = { getSettings(): Promise<unknown> };

/** Fail closed if the installed SDK/CLI cannot prove the session's effective authentication. */
export function queryWithPinnedCredential(
    create: typeof query,
    params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options },
    oauthToken: string,
    source: 'personal' | 'organization' = 'personal',
): Query {
    const failureCode = source === 'organization' ? ORGANIZATION_CLAUDE_AUTH_FAILURE : PERSONAL_CLAUDE_AUTH_FAILURE;
    if (!oauthToken || /[\r\n\0]/.test(oauthToken)) throw new Error(failureCode);
    const signal = params.options.abortController?.signal;
    const authEnv = Object.fromEntries(CLAUDE_AUTH_OVERRIDE_ENV_KEYS.map(key => [key, '']));
    // Newer backends/profiles must not inherit a different credential route.
    for (const key of ['ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE']) authEnv[key] = '';
    // Native host routing ignores authentication env from settings even during live reloads.
    authEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    authEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    authEnv.ANTHROPIC_BASE_URL = params.options.env?.ANTHROPIC_BASE_URL ?? '';
    let response: Query;
    let rejectFailure!: (error: Error) => void;
    const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    void failed.catch(() => {});

    function refuse(upstreamError?: Error): never {
        const error = signal?.aborted ? new AbortError('Claude request aborted') : upstreamError ?? new Error(failureCode);
        rejectFailure(error);
        try { response.close(); } catch { /* already closed */ }
        throw error;
    }
    async function checked() { try { await verify(); } catch { refuse(); } }
    async function control<T>(call: () => Promise<T>): Promise<T> {
        if (signal?.aborted) throw new Error(failureCode);
        let timer: ReturnType<typeof setTimeout>;
        let onAbort: () => void;
        const refused = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new Error(failureCode));
            timer = setTimeout(onAbort, CONTROL_TIMEOUT_MS);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        try { return await Promise.race([Promise.resolve().then(call), refused]); }
        finally { clearTimeout(timer!); signal?.removeEventListener('abort', onAbort!); }
    }
    async function settings(): Promise<LiveSettings> {
        // getSettings exists in the pinned SDK runtime, but is not in its public Query type.
        // Capability/shape checks are mandatory; a missing/changed implementation refuses input.
        const controls = response as Query & Partial<PinControls>;
        if (typeof controls.getSettings !== 'function') throw new Error(failureCode);
        const value = await control(() => controls.getSettings!());
        if (!object(value) || !object(value.effective) || !Array.isArray(value.sources)
            || value.sources.some(source => !object(source) || typeof source.source !== 'string' || !object(source.settings))) throw new Error(failureCode);
        return value as LiveSettings;
    }
    async function verify() {
        const { effective } = await settings();
        const env = effective.env;
        if (effective.forceLoginOrgUUID !== undefined
            || (effective.forceLoginMethod !== undefined && effective.forceLoginMethod !== 'claudeai')
            || (effective.allowedProviders !== undefined && (!Array.isArray(effective.allowedProviders) || !effective.allowedProviders.includes('anthropic')))
            || effective.apiKeyHelper !== '' || !object(env)
            || Object.entries(authEnv).some(([key, value]) => env[key] !== value)) throw new Error(failureCode);
        const info = await control(() => response.reinitialize());
        const account = info.account;
        if (!account || account.apiProvider !== 'firstParty' || account.tokenSource !== 'CLAUDE_CODE_OAUTH_TOKEN'
            || (account.apiKeySource !== undefined && account.apiKeySource !== 'none')) throw new Error(failureCode);
    }
    async function* guardedInput(): AsyncGenerator<SDKUserMessage> {
        let readingInput = false;
        try {
            // The SDK may start consuming its input inside create(), before it returns the Query.
            await Promise.resolve();
            if (typeof response.initializationResult !== 'function' || typeof response.applyFlagSettings !== 'function'
                || typeof response.reinitialize !== 'function') throw new Error(failureCode);
            const initialized = await control(() => response.initializationResult());
            const version = (initialized as { claude_code_version?: string }).claude_code_version?.match(/^2\.1\.(\d+)$/);
            if (!version || Number(version[1]) < 308 || initialized.hooks_applied !== true) throw new Error(failureCode);
            const before = await settings();
            const flag = before.sources.find(source => source.source === 'flagSettings')?.settings;
            // Preserve existing flag-level non-auth env without promoting project/user values.
            await control(() => response.applyFlagSettings({ apiKeyHelper: '', env: {
                ...(object(flag?.env) ? flag.env as Record<string, string> : {}), ...authEnv,
            } }));
            const input = typeof params.prompt === 'string'
                ? (async function* () { yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content: params.prompt as string } }; })()
                : params.prompt;
            readingInput = true;
            for await (const message of input) { await checked(); yield message; }
        } catch (error) {
            // Only trusted input-producer errors retain their identity (authority refusal/abort).
            // Control errors are sanitized by checked() or by this initialization catch.
            refuse(readingInput && error instanceof Error ? error : undefined);
        }
    }
    response = create({ prompt: guardedInput(), options: {
        ...params.options, env: { ...params.options.env, ...authEnv },
        hooks: { ...params.options.hooks, ConfigChange: [
            ...(params.options.hooks?.ConfigChange ?? []),
            { hooks: [async input => {
                // Never override an administrator's changed policy. End the credential generation
                // so the next launch can validate it before any more model requests.
                if (input.hook_event_name === 'ConfigChange' && input.source === 'policy_settings') refuse();
                return {};
            }] },
        ] },
    } });
    let proxy: Query;
    proxy = new Proxy(response, { get(target, key) {
        if (key === Symbol.asyncIterator) return () => proxy;
        // The SDK can swallow input-stream failures. Surface refusal to every consumer, including
        // the main launcher and off-turn title queries, even when close() ends the underlying stream.
        if (key === 'request') {
            const request = Reflect.get(target, key, target);
            if (typeof request !== 'function') return request;
            return async (body: unknown, ...args: unknown[]) => {
                if (object(body) && body.subtype === 'side_question') await checked();
                return request.call(target, body, ...args);
            };
        }
        if (key === 'streamInput') return () => refuse();
        if (key === 'next') return (...args: [] | [undefined]) => Promise.race([target.next(...args), failed]);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    return proxy;
}

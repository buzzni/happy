import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '../utils/claudeAuthOverrideEnv';

import { logger } from '@/lib';
import {
    ClaudeAuthNotVerifiedError, ORGANIZATION_CLAUDE_AUTH_FAILURE, PERSONAL_CLAUDE_AUTH_FAILURE,
    type ClaudeAuthCheckReason, type ClaudeAuthCheckStage,
} from '../utils/launchFailureMessage';
const CONTROL_TIMEOUT_MS = 10_000;
// Initialization waits for SessionStart hooks, and no input exists until it resolves, so a longer
// wait delays the first request without weakening any check. Same as the SDK's startup() default.
const INITIALIZE_TIMEOUT_MS = 60_000;
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
    const startedAt = Date.now();
    const fail = (stage: ClaudeAuthCheckStage, reason: ClaudeAuthCheckReason): never => {
        throw new ClaudeAuthNotVerifiedError(failureCode, stage, reason);
    };
    const diagnosis = (error: unknown, stage: ClaudeAuthCheckStage) => error instanceof ClaudeAuthNotVerifiedError
        ? error : new ClaudeAuthNotVerifiedError(failureCode, stage, 'control_failed');
    let response: Query;
    let rejectFailure!: (error: Error) => void;
    const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    void failed.catch(() => {});

    function refuse(upstreamError: Error | undefined, refusal: ClaudeAuthNotVerifiedError): never {
        const error = signal?.aborted ? new AbortError('Claude request aborted') : upstreamError ?? refusal;
        if (error === refusal) logger.debug(`[credentialPin] ${source} credential refused: stage=${refusal.stage} reason=${refusal.reason} after ${Date.now() - startedAt}ms`);
        rejectFailure(error);
        try { response.close(); } catch { /* already closed */ }
        throw error;
    }
    async function checked() { try { await verify(); } catch (error) { refuse(undefined, diagnosis(error, 'recheck')); } }
    async function control<T>(stage: ClaudeAuthCheckStage, call: () => Promise<T>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<T> {
        if (signal?.aborted) fail(stage, 'control_failed');
        const began = Date.now();
        let timer: ReturnType<typeof setTimeout>;
        let onAbort: () => void;
        const refused = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new ClaudeAuthNotVerifiedError(failureCode, stage, 'control_failed'));
            timer = setTimeout(() => reject(new ClaudeAuthNotVerifiedError(failureCode, stage, 'timeout')), timeoutMs);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        try {
            const value = await Promise.race([Promise.resolve().then(call).catch(() => fail(stage, 'control_failed')), refused]);
            logger.debug(`[credentialPin] ${stage} answered in ${Date.now() - began}ms`);
            return value;
        } finally { clearTimeout(timer!); signal?.removeEventListener('abort', onAbort!); }
    }
    async function settings(stage: ClaudeAuthCheckStage): Promise<LiveSettings> {
        // getSettings exists in the pinned SDK runtime, but is not in its public Query type.
        // Capability/shape checks are mandatory; a missing/changed implementation refuses input.
        const controls = response as Query & Partial<PinControls>;
        if (typeof controls.getSettings !== 'function') fail(stage, 'unsupported');
        const value = await control(stage, () => controls.getSettings!());
        if (!object(value) || !object(value.effective) || !Array.isArray(value.sources)
            || value.sources.some(source => !object(source) || typeof source.source !== 'string' || !object(source.settings))) fail(stage, 'unsupported');
        return value as LiveSettings;
    }
    async function verify() {
        const { effective } = await settings('recheck');
        const env = effective.env;
        if (effective.forceLoginOrgUUID !== undefined
            || (effective.forceLoginMethod !== undefined && effective.forceLoginMethod !== 'claudeai')
            || (effective.allowedProviders !== undefined && (!Array.isArray(effective.allowedProviders) || !effective.allowedProviders.includes('anthropic')))) fail('recheck', 'policy');
        if (effective.apiKeyHelper !== '' || !object(env)
            || Object.entries(authEnv).some(([key, value]) => env[key] !== value)) fail('recheck', 'mismatch');
        const info = await control('recheck', () => response.reinitialize());
        const account = info.account;
        if (!account || account.apiProvider !== 'firstParty' || account.tokenSource !== 'CLAUDE_CODE_OAUTH_TOKEN'
            || (account.apiKeySource !== undefined && account.apiKeySource !== 'none')) fail('recheck', 'mismatch');
    }
    async function* guardedInput(): AsyncGenerator<SDKUserMessage> {
        let readingInput = false;
        try {
            // The SDK may start consuming its input inside create(), before it returns the Query.
            await Promise.resolve();
            if (typeof response.initializationResult !== 'function' || typeof response.applyFlagSettings !== 'function'
                || typeof response.reinitialize !== 'function') fail('initialize', 'unsupported');
            const initialized = await control('initialize', () => response.initializationResult(), INITIALIZE_TIMEOUT_MS);
            const version = (initialized as { claude_code_version?: string }).claude_code_version?.match(/^2\.1\.(\d+)$/);
            if (!version || Number(version[1]) < 308 || initialized.hooks_applied !== true) fail('initialize', 'unsupported');
            const before = await settings('settings');
            const flag = before.sources.find(source => source.source === 'flagSettings')?.settings;
            // Preserve existing flag-level non-auth env without promoting project/user values.
            await control('apply', () => response.applyFlagSettings({ apiKeyHelper: '', env: {
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
            refuse(readingInput && error instanceof Error ? error : undefined, diagnosis(error, 'initialize'));
        }
    }
    response = create({ prompt: guardedInput(), options: {
        ...params.options, env: { ...params.options.env, ...authEnv },
        hooks: { ...params.options.hooks, ConfigChange: [
            ...(params.options.hooks?.ConfigChange ?? []),
            { hooks: [async input => {
                // Never override an administrator's changed policy. End the credential generation
                // so the next launch can validate it before any more model requests.
                if (input.hook_event_name === 'ConfigChange' && input.source === 'policy_settings') refuse(undefined, new ClaudeAuthNotVerifiedError(failureCode, 'recheck', 'policy'));
                return {};
            }] },
        ] },
    } });
    // Startup hooks are the usual reason initialization is slow; log their timing, never their output.
    const hookStarts = new Map<string, number>();
    function observeHook<R extends IteratorResult<unknown>>(result: R): R {
        const message = result.done ? undefined : result.value;
        if (!object(message) || message.type !== 'system' || message.hook_event !== 'SessionStart' || typeof message.hook_id !== 'string') return result;
        const name = typeof message.hook_name === 'string' && /^[A-Za-z]+(?::[\w.-]*)?$/.test(message.hook_name) ? message.hook_name : 'SessionStart';
        const at = Date.now() - startedAt;
        if (message.subtype === 'hook_started') {
            hookStarts.set(message.hook_id, Date.now());
            logger.debug(`[credentialPin] ${name} hook started at +${at}ms`);
        } else if (message.subtype === 'hook_response') {
            const began = hookStarts.get(message.hook_id);
            hookStarts.delete(message.hook_id);
            const outcome = typeof message.outcome === 'string' && /^\w+$/.test(message.outcome) ? message.outcome : 'unknown';
            logger.debug(`[credentialPin] ${name} hook ${outcome} at +${at}ms${began === undefined ? '' : ` after ${Date.now() - began}ms`}`);
        }
        return result;
    }
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
        if (key === 'streamInput') return () => refuse(undefined, new ClaudeAuthNotVerifiedError(failureCode, 'recheck', 'unsupported'));
        if (key === 'next') return (...args: [] | [undefined]) => Promise.race([target.next(...args).then(observeHook), failed]);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    return proxy;
}

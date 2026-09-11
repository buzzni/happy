/**
 * Where the approved gateway actually has to hold.
 *
 * Three things decide whether a managed run spends only its own capability:
 * the URL the SDK ends up calling, the provider the agent CLI is configured
 * with, and whether anything on the machine can substitute a different account
 * on the way. All three are properties of the agent's real configuration, not
 * of the envelope we parsed.
 */
import { describe, it, expect } from 'vitest';

import {
    managedClaudeGatewayBaseUrl,
    managedCodexProviderArguments,
    applyManagedGatewayEnvironment,
    stripProviderCredentialOverrides,
} from '@/managed/managedStartup';
import type { ManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';
import { managedAiAuthCodexHome } from '@/managed/managedAiAuth';

const SAYCODE = 'https://studio.example.test';

function envelope(agent: 'claude' | 'codex'): ManagedSpawnEnvelope {
    const claude = agent === 'claude';
    return {
        directory: '/workspace/project',
        agent,
        model: claude ? 'claude-opus-5' : 'gpt-5',
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'a'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: 'https://happy.example.test',
            sessionId: 'sess-1',
            encryptionVariant: 'dataKey',
            rawKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            wrappedKeyBase64: Buffer.alloc(105, 9).toString('base64'),
            scopedToken: 'scoped.bearer.value',
            tokenExpiresAt: Date.now() + 3_600_000,
        },
        aiAuth: { kind: 'platform-gateway' },
        gateway: {
            baseUrl: claude
                ? `${SAYCODE}/api/cloud/gateway/anthropic/v1/messages`
                : `${SAYCODE}/api/cloud/gateway/openai/v1/responses`,
            capability: 'capability-for-this-run',
            provider: claude ? 'anthropic' : 'openai',
            endpoint: claude ? 'anthropic-messages' : 'openai-responses',
            model: claude ? 'claude-opus-5' : 'gpt-5',
        },
    };
}

describe('the base URL each SDK is given', () => {
    it('stops where the Anthropic SDK starts appending', () => {
        // `client.js` builds `new URL(baseURL + path)` with path `/v1/messages`
        // (`resources/messages/messages.js:35`). Handing it the full endpoint
        // produces `/anthropic/v1/messages/v1/messages`, which is not a route.
        const base = managedClaudeGatewayBaseUrl(envelope('claude'));
        expect(base).toBe(`${SAYCODE}/api/cloud/gateway/anthropic`);
        expect(`${base}/v1/messages`).toBe(envelope('claude').gateway!.baseUrl);
    });

    it('stops where the Codex provider starts appending', () => {
        // The Codex provider appends `/responses` to `base_url`.
        const args = managedCodexProviderArguments(envelope('codex'));
        const baseUrl = args[args.indexOf('-c') + 1];
        expect(args).toContain(`model_providers.saycode-managed.base_url="${SAYCODE}/api/cloud/gateway/openai/v1"`);
        expect(baseUrl).toBeDefined();
    });

    it('refuses an endpoint that is not the route this agent was approved for', () => {
        const crossed = envelope('claude');
        crossed.gateway!.baseUrl = `${SAYCODE}/api/cloud/gateway/openai/v1/responses`;
        expect(() => managedClaudeGatewayBaseUrl(crossed)).toThrow(/gateway/i);
    });
});

describe('the provider the Codex CLI is configured with', () => {
    it('is pinned as whole configuration, not left to whatever is on disk', () => {
        const args = managedCodexProviderArguments(envelope('codex'));
        // Every axis the CLI would otherwise take from the user's config file.
        expect(args).toContain('model_providers.saycode-managed.env_key="OPENAI_API_KEY"');
        expect(args).toContain('model_providers.saycode-managed.wire_api="responses"');
        expect(args).toContain('model_providers.saycode-managed.requires_openai_auth=false');
        expect(args).toContain('model_provider="saycode-managed"');
    });

    it('carries the capability in the environment the provider reads', () => {
        const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'someone-elses-key' };
        applyManagedGatewayEnvironment(env, envelope('codex'));
        expect(env.OPENAI_API_KEY).toBe('capability-for-this-run');
        expect(env.OPENAI_BASE_URL).toBe(`${SAYCODE}/api/cloud/gateway/openai/v1`);
    });
});

/**
 * The other route (R21~R25): the requester's own subscription.
 *
 * No capability, no gateway, and a login this runtime holds for exactly one
 * connection. What is checked here is that the two routes do not leak into
 * each other — a gateway key left in the environment would run a personal
 * subscription on the platform's account, and an auth home left behind would
 * run a platform generation on somebody's personal one.
 */
describe('a personal subscription', () => {
    const CONNECTION = 'conn-0123456789ab';

    const personal = (agent: 'claude' | 'codex'): ManagedSpawnEnvelope => ({
        ...envelope(agent),
        aiAuth: {
            kind: 'personal-subscription',
            provider: agent,
            connectionId: CONNECTION,
            connectionVersion: 2,
        },
        gateway: null,
    });

    it('points claude at this connection\'s auth home and spends no capability', () => {
        const env: NodeJS.ProcessEnv = {
            ANTHROPIC_AUTH_TOKEN: 'someone-elses-capability',
            ANTHROPIC_BASE_URL: 'https://gateway.example.test',
            CLAUDE_CONFIG_DIR: '/workspace/.auth/another-connection/claude',
        };
        applyManagedGatewayEnvironment(env, personal('claude'));
        expect(env.CLAUDE_CONFIG_DIR).toBe(`/workspace/.auth/${CONNECTION}/claude`);
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('leaves CODEX_HOME to the launcher plan', () => {
        // `buildCodexToolPolicy` refuses a provider environment carrying
        // `CODEX_HOME` and sets it from the plan's `codexHome`. Setting it
        // here would refuse every managed codex launch instead of configuring
        // one.
        const env: NodeJS.ProcessEnv = { CODEX_HOME: '/workspace/.auth/another-connection/codex' };
        applyManagedGatewayEnvironment(env, personal('codex'));
        expect(env.CODEX_HOME).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBeUndefined();
    });

    it('does not pin a model provider, so the chatgpt login is the one used', () => {
        expect(managedCodexProviderArguments(personal('codex'))).toEqual([]);
    });

    it('clears an inherited auth home on the gateway route too', () => {
        const env: NodeJS.ProcessEnv = {
            CLAUDE_CONFIG_DIR: `/workspace/.auth/${CONNECTION}/claude`,
            CODEX_HOME: `/workspace/.auth/${CONNECTION}/codex`,
        };
        applyManagedGatewayEnvironment(env, envelope('claude'));
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(env.CODEX_HOME).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('capability-for-this-run');
    });

    it('refuses to build a gateway base URL for a run that has none', () => {
        expect(() => managedClaudeGatewayBaseUrl(personal('claude'))).toThrow(/personal subscription/);
    });
});

/**
 * The third route: the requester's own **key**.
 *
 * Same shape as a personal subscription — no capability, no gateway — but the
 * credential is a string this runtime holds rather than a login the vendor CLI
 * manages, so the thing that has to hold is the environment it is put into. A
 * key in the wrong variable is a run that authenticates as nobody and falls
 * back to whatever else it can find.
 */
describe('a registered api key', () => {
    const CONNECTION = 'conn-0123456789ab';
    const KEY = 'sk-the-registered-key';

    const keyed = (provider: 'claude' | 'codex' | 'glm'): ManagedSpawnEnvelope => ({
        ...envelope(provider === 'codex' ? 'codex' : 'claude'),
        aiAuth: {
            kind: 'personal-api-key',
            provider,
            connectionId: CONNECTION,
            connectionVersion: 2,
        },
        gateway: null,
    });

    /** The key file as the store wrote it, served from the expected home only. */
    const reader = (provider: string, contents = JSON.stringify({
        v: 1, provider, apiKey: KEY,
    })) => (path: string): string => {
        if (path !== `/workspace/.auth/${CONNECTION}/${provider}/api-key.json`) {
            throw new Error(`ENOENT: ${path}`);
        }
        return contents;
    };

    it('gives claude the key and a config directory of this connection\'s own', () => {
        const env: NodeJS.ProcessEnv = {
            ANTHROPIC_API_KEY: 'someone-elses-key',
            ANTHROPIC_AUTH_TOKEN: 'someone-elses-capability',
            CLAUDE_CONFIG_DIR: '/workspace/.auth/another-connection/claude',
        };
        applyManagedGatewayEnvironment(env, keyed('claude'), reader('claude'));
        expect(env.ANTHROPIC_API_KEY).toBe(KEY);
        expect(env.CLAUDE_CONFIG_DIR).toBe(`/workspace/.auth/${CONNECTION}/claude`);
        // Nothing of the gateway route survives beside it.
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('spends a glm key on the z.ai route, which is a whole environment', () => {
        const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.test' };
        applyManagedGatewayEnvironment(env, keyed('glm'), reader('glm'));
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
        expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3');
        expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4.7');
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.7');
        expect(env.API_TIMEOUT_MS).toBe('3000000');
        // Z.AI is reached with the Anthropic *auth token*, not an API key: a
        // key in the other variable is a request that authenticates as nobody.
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        // Its own directory, not the claude one — two connections' Claude Code
        // state must not land in the same place.
        expect(env.CLAUDE_CONFIG_DIR).toBe(`/workspace/.auth/${CONNECTION}/glm`);
    });

    it('gives codex the key and still leaves CODEX_HOME to the launcher plan', () => {
        const env: NodeJS.ProcessEnv = {
            OPENAI_API_KEY: 'someone-elses-key',
            OPENAI_BASE_URL: 'https://gateway.example.test',
            CODEX_HOME: '/workspace/.auth/another-connection/codex',
        };
        applyManagedGatewayEnvironment(env, keyed('codex'), reader('codex'));
        expect(env.OPENAI_API_KEY).toBe(KEY);
        expect(env.OPENAI_BASE_URL).toBeUndefined();
        expect(env.CODEX_HOME).toBeUndefined();
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('does not pin a model provider for a key either', () => {
        expect(managedCodexProviderArguments(keyed('codex'))).toEqual([]);
    });

    it('sends the launcher to this connection\'s codex home for either personal kind', () => {
        // The other half of "CODEX_HOME is the launcher plan's": the plan has
        // to be built with the connection's own home, or the run reads the
        // shared provider state the platform runs use.
        const platform = '/workspace/.codex';
        const home = `/workspace/.auth/${CONNECTION}/codex`;
        expect(managedAiAuthCodexHome(keyed('codex').aiAuth, platform)).toBe(home);
        expect(managedAiAuthCodexHome({
            kind: 'personal-subscription', provider: 'codex',
            connectionId: CONNECTION, connectionVersion: 2,
        }, platform)).toBe(home);
        expect(managedAiAuthCodexHome(envelope('codex').aiAuth, platform)).toBe(platform);
    });

    it.each([
        ['there is no key file', () => { throw new Error('ENOENT'); }],
        ['the file is not a key', () => 'nonsense'],
        ['the key inside it is unusable', () => JSON.stringify({ v: 1, apiKey: 'short' })],
    ])('refuses to start when %s', (_name, read) => {
        const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'someone-elses-key' };
        // No fallback: the gateway would spend Studio's budget on a run priced
        // as the user's own, and the inherited key is somebody else's.
        expect(() => applyManagedGatewayEnvironment(env, keyed('claude'), read as () => string))
            .toThrow(/personal api key is not present/);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('still drops a caller override that would substitute the key', () => {
        // `--claude-env` values are applied after startup, so an override named
        // here wins over everything above.
        expect(stripProviderCredentialOverrides({
            ANTHROPIC_API_KEY: 'substituted',
            ANTHROPIC_AUTH_TOKEN: 'substituted',
            OPENAI_API_KEY: 'substituted',
            CLAUDE_CONFIG_DIR: '/workspace/.auth/another-connection/claude',
            CODEX_HOME: '/workspace/.auth/another-connection/codex',
            HAPPY_SOMETHING_ELSE: 'kept',
        })).toEqual({ HAPPY_SOMETHING_ELSE: 'kept' });
    });
});

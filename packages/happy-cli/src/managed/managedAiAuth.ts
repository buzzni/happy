/**
 * The AI-authentication axis of a managed run, as the runtime reads it.
 *
 * A **copy** of `packages/web-ui/server/cloudAiAuth.ts` on the Studio side:
 * there is no shared package across the submodule boundary (see the note at
 * the top of `managedDispatchToken.ts` about the token contract), so the two
 * files carry the same constants and a cross-boundary test keeps them equal.
 *
 * Three kinds, and they are not interchangeable:
 *
 *  - `platform-gateway`     the meaning of an envelope with no `aiAuth` at all:
 *                           the approved Saycode gateway, spent with the
 *                           capability in `envelope.gateway`.
 *  - `platform-glm`         the default GLM route. Still the gateway, still a
 *                           capability — only the upstream differs, and the
 *                           parent chose it. The runtime treats it as gateway.
 *  - `personal-subscription` the requester's **own** Claude or Codex login,
 *                           living under this runtime's auth home. No gateway,
 *                           no capability, no Studio AI budget. The provider
 *                           CLI talks to the vendor directly.
 *
 * Nothing here reads a file or the environment; the auth home layout is a
 * path contract, and the module that touches it is `managedAiAuthStore`.
 */

export const MANAGED_AI_AUTH_KINDS = [
    'platform-gateway', 'platform-glm', 'personal-subscription', 'personal-api-key',
] as const;
export type ManagedAiAuthKind = (typeof MANAGED_AI_AUTH_KINDS)[number];

/**
 * `glm` is API-key only: there is no GLM subscription login, and a GLM key is
 * spent by Claude Code (agent `claude`) against Z.AI's Anthropic-compatible
 * endpoint.
 */
export const MANAGED_AI_AUTH_PROVIDERS = ['claude', 'codex', 'glm'] as const;
export type ManagedAiAuthProvider = (typeof MANAGED_AI_AUTH_PROVIDERS)[number];
export const MANAGED_AI_AUTH_SUBSCRIPTION_PROVIDERS = ['claude', 'codex'] as const;

/** What a connection holds. One-to-one with the personal kinds. */
export const MANAGED_AI_AUTH_CREDENTIAL_KINDS = ['oauth', 'api-key'] as const;
export type ManagedAiAuthCredentialKind = (typeof MANAGED_AI_AUTH_CREDENTIAL_KINDS)[number];

export type ManagedAiAuthPersonalKind = 'personal-subscription' | 'personal-api-key';

export type ManagedAiAuthSelection =
    | { kind: 'platform-gateway' }
    | { kind: 'platform-glm' }
    | {
        kind: ManagedAiAuthPersonalKind;
        provider: ManagedAiAuthProvider;
        connectionId: string;
        connectionVersion: number;
    };

export function isPersonalAiAuth(
    selection: ManagedAiAuthSelection,
): selection is Extract<ManagedAiAuthSelection, { kind: ManagedAiAuthPersonalKind }> {
    return selection.kind === 'personal-subscription' || selection.kind === 'personal-api-key';
}

export function credentialKindForAiAuth(kind: ManagedAiAuthPersonalKind): ManagedAiAuthCredentialKind {
    return kind === 'personal-subscription' ? 'oauth' : 'api-key';
}

/** The agent a provider's credential is spent by. A GLM key runs Claude Code. */
export function aiAuthAgentForProvider(provider: ManagedAiAuthProvider): 'claude' | 'codex' {
    return provider === 'codex' ? 'codex' : 'claude';
}

/** Z.AI's Anthropic-compatible base, the same one the trial lease points Claude Code at. */
export const MANAGED_AI_AUTH_GLM_BASE_URL = 'https://api.z.ai/api/anthropic';

/** Same character set as the parent: the id becomes a directory name. */
export const MANAGED_AI_AUTH_CONNECTION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Where personal logins live on a managed runtime.
 *
 * Outside both `/workspace/project` and `/workspace/.codex`, so no checkpoint
 * area ever contains a credential (R23). Per connection, so two users on one
 * workspace never share a home, and a logout removes exactly one.
 */
export const MANAGED_AI_AUTH_HOME_ROOT = '/workspace/.auth';

/** The marker the runtime writes beside a login. Version pinned on purpose. */
export const MANAGED_AI_AUTH_MARKER_FILE = 'connection.json';
export const MANAGED_AI_AUTH_MARKER_VERSION = 1;

export type ManagedAiAuthMarker = {
    v: typeof MANAGED_AI_AUTH_MARKER_VERSION;
    provider: ManagedAiAuthProvider;
    /** The parent-issued version this credential belongs to. */
    connectionVersion: number;
    /** Absent in markers written before keys existed: those are logins. */
    credentialKind?: ManagedAiAuthCredentialKind;
    /** Masked, non-secret account display. */
    accountLabel?: string;
};

export function managedAiAuthConnectionDir(connectionId: string): string {
    if (!MANAGED_AI_AUTH_CONNECTION_ID_PATTERN.test(connectionId)) {
        throw new Error('connectionId is not a valid managed auth connection id');
    }
    return `${MANAGED_AI_AUTH_HOME_ROOT}/${connectionId}`;
}

/** `CLAUDE_CONFIG_DIR` for claude, `CODEX_HOME` for codex, the key file's home for glm. */
export function managedAiAuthProviderHome(connectionId: string, provider: ManagedAiAuthProvider): string {
    return `${managedAiAuthConnectionDir(connectionId)}/${provider}`;
}

export class ManagedAiAuthSelectionError extends Error {
    readonly field: string;
    constructor(field: string, detail: string) {
        super(`${field}: ${detail}`);
        this.name = 'ManagedAiAuthSelectionError';
        this.field = field;
    }
}

function fail(field: string, detail: string): never {
    throw new ManagedAiAuthSelectionError(field, detail);
}

/**
 * Reads `envelope.aiAuth`. `undefined` is the legacy meaning; `null` and every
 * unknown shape are refusals — an unknown kind is not "run it on the gateway".
 */
export function parseManagedAiAuthSelection(value: unknown, agent: string): ManagedAiAuthSelection {
    if (value === undefined) return { kind: 'platform-gateway' };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('aiAuth', 'must be an object');
    }
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== 'string' || !(MANAGED_AI_AUTH_KINDS as readonly string[]).includes(kind)) {
        fail('aiAuth.kind', 'is not supported');
    }
    if (kind === 'platform-gateway' || kind === 'platform-glm') {
        for (const key of Object.keys(record)) {
            if (key !== 'kind') fail('aiAuth', 'has an unexpected field');
        }
        return { kind };
    }
    for (const key of Object.keys(record)) {
        if (!['kind', 'provider', 'connectionId', 'connectionVersion'].includes(key)) {
            fail('aiAuth', 'has an unexpected field');
        }
    }
    const provider = record.provider;
    if (typeof provider !== 'string' || !(MANAGED_AI_AUTH_PROVIDERS as readonly string[]).includes(provider)) {
        fail('aiAuth.provider', 'must be claude, codex or glm');
    }
    if (
        kind === 'personal-subscription'
        && !(MANAGED_AI_AUTH_SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider)
    ) {
        fail('aiAuth.provider', 'a subscription login exists only for claude and codex');
    }
    // A Codex login cannot run a Claude generation, and the parent never asks
    // for it; an envelope that does is built from the wrong run. A GLM key is
    // spent by Claude Code, so it maps to the claude agent.
    if (aiAuthAgentForProvider(provider as ManagedAiAuthProvider) !== agent) {
        fail('aiAuth.provider', 'does not match the agent');
    }
    const connectionId = record.connectionId;
    if (typeof connectionId !== 'string' || !MANAGED_AI_AUTH_CONNECTION_ID_PATTERN.test(connectionId)) {
        fail('aiAuth.connectionId', 'is not a valid connection id');
    }
    const connectionVersion = record.connectionVersion;
    if (typeof connectionVersion !== 'number' || !Number.isSafeInteger(connectionVersion) || connectionVersion < 1) {
        fail('aiAuth.connectionVersion', 'must be a positive integer');
    }
    return {
        kind: kind as ManagedAiAuthPersonalKind,
        provider: provider as ManagedAiAuthProvider,
        connectionId,
        connectionVersion,
    };
}

export function isGatewayAiAuth(selection: ManagedAiAuthSelection): boolean {
    return !isPersonalAiAuth(selection);
}

/**
 * The `CODEX_HOME` one run must be launched with.
 *
 * Codex reads its login from that directory, so for a personal subscription it
 * has to be the requester's own — not the shared provider state the platform
 * runs use. The platform's path is passed in rather than named here: it is the
 * launcher's, and this module knows only about auth homes.
 */
export function managedAiAuthCodexHome(
    selection: ManagedAiAuthSelection,
    platformCodexHome: string,
): string {
    return isPersonalAiAuth(selection)
        ? managedAiAuthProviderHome(selection.connectionId, 'codex')
        : platformCodexHome;
}

// ---------------------------------------------------------------------------
// `managed:ai-auth` RPC wire (parent → daemon)
// ---------------------------------------------------------------------------

export const MANAGED_AI_AUTH_RPC_METHOD = 'managed:ai-auth';
export const MANAGED_AI_AUTH_TOKEN_OP = 'ai-auth';

export const MANAGED_AI_AUTH_ACTIONS = [
    'login-start', 'login-complete', 'login-cancel', 'set-key', 'logout', 'status',
] as const;
export type ManagedAiAuthAction = (typeof MANAGED_AI_AUTH_ACTIONS)[number];

export type ManagedAiAuthRpcParams = {
    action: ManagedAiAuthAction;
    connectionId: string;
    provider: ManagedAiAuthProvider;
    /** login-start / logout: the version the marker records on success. */
    connectionVersion?: number;
    /** login-start: the pending login is discarded after this instant. */
    expiresAt?: number;
    /** login-complete (claude): the code the user pasted, `code#state` allowed. */
    code?: string;
    /**
     * set-key only. Lands in the auth home and nowhere else — never in a
     * reply, never in a log line, never in the parent's database.
     */
    apiKey?: string;
};

/** Printable ASCII, 8..512, no whitespace. Provider prefixes are not checked: they change. */
export const MANAGED_AI_AUTH_API_KEY_PATTERN = /^[\x21-\x7E]{8,512}$/;

export type ManagedAiAuthLoginMethod = 'paste-code' | 'device-code';

/**
 * What the daemon answers. Never a token, never a refresh token, never the
 * PKCE verifier: the parent stores this reply, and a reply that carried a
 * secret would put the secret in the parent's database.
 */
export type ManagedAiAuthRpcResult = {
    state: 'absent' | 'pending' | 'connected' | 'failed';
    connectionVersion: number | null;
    /** On `connected`: what kind of credential is held. */
    credentialKind?: ManagedAiAuthCredentialKind;
    loginMethod?: ManagedAiAuthLoginMethod;
    loginUrl?: string;
    userCode?: string;
    expiresAt?: number;
    accountLabel?: string;
    failureCode?: string;
};

export function parseManagedAiAuthRpcParams(value: unknown): ManagedAiAuthRpcParams {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('params', 'must be an object');
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!['action', 'connectionId', 'provider', 'connectionVersion', 'expiresAt', 'code', 'apiKey'].includes(key)) {
            fail('params', 'has an unexpected field');
        }
    }
    const action = record.action;
    if (typeof action !== 'string' || !(MANAGED_AI_AUTH_ACTIONS as readonly string[]).includes(action)) {
        fail('action', 'is not supported');
    }
    const connectionId = record.connectionId;
    if (typeof connectionId !== 'string' || !MANAGED_AI_AUTH_CONNECTION_ID_PATTERN.test(connectionId)) {
        fail('connectionId', 'is not a valid connection id');
    }
    const provider = record.provider;
    if (typeof provider !== 'string' || !(MANAGED_AI_AUTH_PROVIDERS as readonly string[]).includes(provider)) {
        fail('provider', 'must be claude, codex or glm');
    }
    const params: ManagedAiAuthRpcParams = {
        action: action as ManagedAiAuthAction,
        connectionId,
        provider: provider as ManagedAiAuthProvider,
    };
    if (record.connectionVersion !== undefined) {
        const version = record.connectionVersion;
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
            fail('connectionVersion', 'must be a positive integer');
        }
        params.connectionVersion = version;
    }
    if (record.expiresAt !== undefined) {
        const expiresAt = record.expiresAt;
        if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
            fail('expiresAt', 'must be a positive safe integer');
        }
        params.expiresAt = expiresAt;
    }
    if (record.code !== undefined) {
        const code = record.code;
        // Bounded: it is pasted by a person and forwarded to a token endpoint.
        if (typeof code !== 'string' || code.trim() === '' || code.length > 512) {
            fail('code', 'must be a non-empty string');
        }
        params.code = code.trim();
    }
    if (record.apiKey !== undefined) {
        const apiKey = record.apiKey;
        // The value never reaches a message: the failure names the field only.
        if (typeof apiKey !== 'string' || !MANAGED_AI_AUTH_API_KEY_PATTERN.test(apiKey)) {
            fail('apiKey', 'is not a usable api key');
        }
        params.apiKey = apiKey;
    }
    if ((action === 'login-start' || action === 'logout' || action === 'set-key') && params.connectionVersion === undefined) {
        fail('connectionVersion', `is required for ${action}`);
    }
    if (action === 'set-key' && params.apiKey === undefined) fail('apiKey', 'is required for set-key');
    if ((action === 'login-start' || action === 'login-complete') && provider === 'glm') {
        fail('provider', 'glm has no login; register a key');
    }
    if (action === 'login-start' && params.expiresAt === undefined) {
        fail('expiresAt', 'is required for login-start');
    }
    return params;
}

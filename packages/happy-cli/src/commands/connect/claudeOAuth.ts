/**
 * The Claude.ai OAuth axes, in one place.
 *
 * Extracted from `authenticateClaude.ts` rather than copied, because a managed
 * runtime drives the **same** flow without a browser or a callback server: the
 * user opens the URL on their own device and pastes the code back (R23). Two
 * copies of a client id and a token endpoint are two things that can drift,
 * and the half that drifts is the half that stops being able to exchange a
 * code at all.
 *
 * Pure: nothing here opens a socket, reads a file or talks to the network. The
 * interactive flow keeps its server and its browser; the managed store keeps
 * its paste-the-code flow; both build their request from these.
 */
import { createHash, randomBytes } from 'node:crypto';

/** The Claude Code client, as registered with Anthropic. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

/**
 * The redirect the authorization request names.
 *
 * It is part of the signature twice over — the authorize request and the token
 * exchange must name the same one — so it is built once. On a managed runtime
 * nothing listens on it: the page shows the code and the user pastes it, which
 * is what `code=true` asks for.
 */
export const CLAUDE_OAUTH_DEFAULT_PORT = 54545;

export function claudeOAuthRedirectUri(port: number = CLAUDE_OAUTH_DEFAULT_PORT): string {
    return `http://localhost:${port}/callback`;
}

export type PkceCodes = { verifier: string; challenge: string };

export function generateClaudePkce(): PkceCodes {
    const verifier = randomBytes(32)
        .toString('base64url')
        .replace(/[^a-zA-Z0-9\-._~]/g, '');
    const challenge = createHash('sha256')
        .update(verifier)
        .digest('base64url')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return { verifier, challenge };
}

export function generateClaudeOAuthState(): string {
    return randomBytes(32).toString('base64url');
}

/**
 * The authorize URL.
 *
 * `code=true` is what makes claude.ai display the authorization code as well
 * as redirecting — the only thing that makes this flow work on a device that
 * is not the user's browser.
 */
export function buildClaudeAuthorizeUrl(input: {
    challenge: string;
    state: string;
    redirectUri: string;
    scope: string;
}): string {
    const params = new URLSearchParams({
        code: 'true',
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        response_type: 'code',
        redirect_uri: input.redirectUri,
        scope: input.scope,
        code_challenge: input.challenge,
        code_challenge_method: 'S256',
        state: input.state,
    });
    return `${CLAUDE_OAUTH_AUTHORIZE_URL}?${params}`;
}

/** The body the token endpoint takes, as JSON. Same fields for both flows. */
export function claudeTokenExchangeBody(input: {
    code: string;
    verifier: string;
    redirectUri: string;
    state: string;
}): Record<string, string> {
    return {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        code_verifier: input.verifier,
        state: input.state,
    };
}

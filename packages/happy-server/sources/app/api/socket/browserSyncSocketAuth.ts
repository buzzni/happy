/**
 * The socket handshake for a browser that no longer carries the account bearer.
 *
 * Runs before the account verifier and declines anything it does not recognise,
 * so a credential it cannot read falls through to the existing path unchanged —
 * the CLI, the desktop app and the agent are not in this branch at all.
 *
 * What it does not do is decide how long the connection may live. The
 * credential's expiry is returned so the caller can end an already-open socket
 * at that moment: a check that only runs at connect would let a browser stay
 * connected long after the logout that was meant to disconnect it.
 */
import type { BrowserSyncTokenIssuer } from '@/app/auth/browserSyncToken';

export type BrowserSyncSocketHandshake = {
    token: string;
    clientType: 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
};

export type BrowserSyncSocketIdentity = {
    accountId: string;
    expiresAt: number;
};

export async function authenticateBrowserSyncSocket(input: {
    handshake: BrowserSyncSocketHandshake;
    issuer: BrowserSyncTokenIssuer | null;
    now: number;
}): Promise<BrowserSyncSocketIdentity | null> {
    const { token, clientType } = input.handshake;
    // A browser is a user-scoped client. The other two client types carry
    // machine and session authority whose handlers this credential must not
    // reach, so it is refused there rather than quietly accepted.
    if (clientType !== 'user-scoped' || !token || !input.issuer) return null;

    const verified = await input.issuer.verify(token, input.now);
    if (!verified.ok) return null;

    return { accountId: verified.claims.accountId, expiresAt: verified.claims.expiresAt };
}

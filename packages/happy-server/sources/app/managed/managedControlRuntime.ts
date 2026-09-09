/**
 * What the managed control plane needs configured before it can be used.
 *
 * Off by default and refusing when unset. A deployment that has not been given
 * control verification keys and a scoped-token seed must be unable to mint
 * session grants at all — not fall back to the account bearer, and not mint
 * under some derived default. There is no default secret here for the same
 * reason there is no signing key: both would make the fail-closed state
 * reachable by accident.
 */

import {
    createControlAssertionVerifier,
    type ControlAssertionVerifier,
} from '@/app/managed/managedControlAssertion';
import {
    createSessionScopedTokenIssuer,
    type SessionScopedTokenIssuer,
} from '@/app/auth/sessionScopedToken';

export type ManagedControlEnv = {
    HAPPY_MANAGED_CONTROL_VERIFIER_KEYS?: string;
    HAPPY_MANAGED_CONTROL_AUDIENCE?: string;
    HAPPY_MANAGED_SCOPED_TOKEN_SEED?: string;
    HAPPY_MANAGED_PUBLIC_URL?: string;
};

export type ManagedControlRuntime = {
    assertions: ControlAssertionVerifier;
    scopedTokens: SessionScopedTokenIssuer;
    /**
     * The absolute origin managed relay URLs are built from. Taken from
     * configuration only: a URL derived from a request's own `Host` or
     * `x-forwarded-*` headers would let a caller choose where a scoped bearer
     * is sent next.
     */
    publicUrl: string;
};

/**
 * Builds the runtime, or returns null when the deployment has not enabled it.
 *
 * A partial configuration throws rather than returning null: half-configured is
 * a mistake worth reporting, while unconfigured is a deliberate state.
 */
export async function createManagedControlRuntime(
    env: ManagedControlEnv,
): Promise<ManagedControlRuntime | null> {
    const assertions = createControlAssertionVerifier({
        audience: env.HAPPY_MANAGED_CONTROL_AUDIENCE,
        verifierKeys: env.HAPPY_MANAGED_CONTROL_VERIFIER_KEYS,
    });
    if (!assertions) return null;

    const seed = env.HAPPY_MANAGED_SCOPED_TOKEN_SEED?.trim();
    if (!seed) {
        throw new Error('HAPPY_MANAGED_SCOPED_TOKEN_SEED is required when managed control is enabled');
    }
    const publicUrl = env.HAPPY_MANAGED_PUBLIC_URL?.trim();
    if (!publicUrl) {
        throw new Error('HAPPY_MANAGED_PUBLIC_URL is required when managed control is enabled');
    }
    let parsed: URL;
    try {
        parsed = new URL(publicUrl);
    } catch {
        throw new Error('HAPPY_MANAGED_PUBLIC_URL must be an absolute URL');
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
        throw new Error('HAPPY_MANAGED_PUBLIC_URL must be https outside localhost');
    }

    return {
        assertions,
        scopedTokens: await createSessionScopedTokenIssuer({ seed }),
        publicUrl: parsed.origin,
    };
}

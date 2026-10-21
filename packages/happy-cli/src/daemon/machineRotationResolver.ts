import { z } from 'zod';
import { rotationDecodeBinary, rotationSha256 } from '@slopus/happy-wire';
import type { MachineRotationConfig } from './machineSetupTokenProtocol';

/**
 * aplus specs/shared-machine-server-signing Phase 3c — machine setup-token rotation without hand-set environment.
 * The company is the machine's shared scope; Studio is the trusted origin and its rotation key is read from there.
 * New launches use rotation only when Studio accepts this PC; otherwise they run the current way and the caller logs
 * the reason. HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED can only force new launches off; recovering existing launches never
 * depends on it or on acceptance.
 */
export type MachineRotationDecision<R> = { runtime: R; reason?: undefined } | { runtime: null; reason: MachineRotationFallback };
export type MachineRotationFallback = 'DISABLED' | 'STUDIO_ORIGIN_MISSING' | 'STUDIO_KEY_UNAVAILABLE' | 'NOT_ACCEPTED' | 'ACCEPTANCE_UNAVAILABLE';
const CACHE_MS = 10 * 60_000;
/** A failed lookup is retried after this, so a hanging Studio costs one wait per minute, not one per launch. */
const FAILURE_CACHE_MS = 60_000;
const keySchema = z.object({ version: z.literal(2), algorithm: z.literal('Ed25519'), keyId: z.string().regex(/^[0-9a-f]{64}$/),
    publicKey: z.string(), studioOrigin: z.string(), happyOrigin: z.string() }).passthrough();
const acceptanceSchema = z.object({ version: z.literal(2), accepted: z.boolean() }).strict();

type Cached<T> = { until: number; value: Promise<T> };
/** One lookup at a time per key; its result (or its failure, for a shorter time) is reused until it expires. */
function cachedLookup<T>(now: () => number, lookup: (key: string) => Promise<T>) {
    const entries = new Map<string, Cached<T>>();
    return (key: string): Promise<T> => {
        const cached = entries.get(key);
        if (cached && cached.until > now()) return cached.value;
        const value = lookup(key);
        const entry: Cached<T> = { until: Number.POSITIVE_INFINITY, value };
        entries.set(key, entry);
        value.then(() => { entry.until = now() + CACHE_MS; }, () => { entry.until = now() + FAILURE_CACHE_MS; });
        return value;
    };
}

export function createMachineRotationResolver<R>(deps: {
    env: Record<string, string | undefined>; machineId: string; happyOrigin: string; studioOrigin: string | null;
    bearer: () => string; fetch?: typeof fetch; now?: () => number;
    createRuntime(config: MachineRotationConfig): R;
}) {
    const now = deps.now ?? Date.now, fetcher = deps.fetch ?? fetch;
    const forcedOff = () => ['false', 'off', '0'].includes((deps.env.HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED ?? '').trim().toLowerCase());
    // One runtime per company keeps its launch fencing; a rotated Studio key is written into the config it verifies with.
    const runtimes = new Map<string, { runtime: R; config: MachineRotationConfig }>();

    const studioKey = cachedLookup(now, async (origin: string) => {
        const response = await fetcher(origin + '/api/claude-setup-token/daemon/v2/public-key', {
            redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('STUDIO_KEY_UNAVAILABLE');
        const text = await response.text();
        if (text.length > 4096) throw new Error('STUDIO_KEY_UNAVAILABLE');
        const value = keySchema.parse(JSON.parse(text));
        if (value.studioOrigin !== origin || value.happyOrigin !== deps.happyOrigin
            || await rotationSha256(rotationDecodeBinary(value.publicKey, 32)) !== value.keyId) throw new Error('STUDIO_KEY_UNAVAILABLE');
        return { publicKey: value.publicKey, keyId: value.keyId };
    });
    const accepted = cachedLookup(now, async (companyId: string) => {
        const url = new URL('/api/claude-setup-token/daemon/v2/acceptance', deps.studioOrigin!);
        url.searchParams.set('companyId', companyId);
        url.searchParams.set('machineId', deps.machineId);
        const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { Authorization: `Bearer ${deps.bearer()}` } });
        if (!response.ok) throw new Error('ACCEPTANCE_UNAVAILABLE');
        return acceptanceSchema.parse(await response.json()).accepted;
    });
    /** The runtime for launches of this company, new or recovered; null when Studio or its key cannot be reached. */
    async function runtime(companyId: string): Promise<R | null> {
        if (!deps.studioOrigin) return null;
        let served;
        try { served = await studioKey(deps.studioOrigin); } catch { return null; }
        const current = runtimes.get(companyId);
        if (current) {
            current.config.studioPublicKey = served.publicKey;
            return current.runtime;
        }
        const config: MachineRotationConfig = { companyId, machineId: deps.machineId, studioOrigin: deps.studioOrigin, happyOrigin: deps.happyOrigin, studioPublicKey: served.publicKey };
        const created = deps.createRuntime(config);
        runtimes.set(companyId, { runtime: created, config });
        return created;
    }
    return {
        runtime,
        /** A recovered launch may still complete its initial issue unless new issuance is forced off. */
        newIssuesAllowed: () => !forcedOff(),
        /** Whether a new launch of this company uses machine rotation, and why not when it does not. */
        async newLaunch(companyId: string): Promise<MachineRotationDecision<R>> {
            if (forcedOff()) return { runtime: null, reason: 'DISABLED' };
            if (!deps.studioOrigin) return { runtime: null, reason: 'STUDIO_ORIGIN_MISSING' };
            const current = await runtime(companyId);
            if (!current) return { runtime: null, reason: 'STUDIO_KEY_UNAVAILABLE' };
            let ok: boolean;
            try { ok = await accepted(companyId); } catch { return { runtime: null, reason: 'ACCEPTANCE_UNAVAILABLE' }; }
            return ok ? { runtime: current } : { runtime: null, reason: 'NOT_ACCEPTED' };
        },
    };
}

/**
 * The machine-rotation decision for one launch. The cheap opt-outs come before the shared scope is resolved, and an
 * unresolved assignment (two companies, or one still being applied) runs the current way instead of failing.
 */
export async function chooseLaunchRotation<R>(input: {
    managedClaude: boolean; explicitUserGrant: boolean; precreatedSession: boolean;
    resolver: { newIssuesAllowed(): boolean; newLaunch(companyId: string): Promise<MachineRotationDecision<R>> } | null;
    scope(): Promise<string | null>;
    log(reason: string, unexpected: boolean): void;
}): Promise<R | null> {
    // Explicit user-v1 grants keep their existing verifier. A machine-v2 document cannot pass it.
    if (!input.managedClaude || input.explicitUserGrant) return null;
    if (!input.resolver || !input.resolver.newIssuesAllowed()) return null;
    let scope: string | null;
    try { scope = await input.scope(); } catch { input.log('ASSIGNMENT_UNRESOLVED', false); return null; }
    if (!scope) return null;
    // A session created before the launch cannot carry the execution proof machine rotation binds to.
    if (input.precreatedSession) { input.log('PRECREATED_SESSION', false); return null; }
    const decision = await input.resolver.newLaunch(scope);
    if (decision.runtime) return decision.runtime;
    const reason = decision.reason ?? 'UNAVAILABLE';
    input.log(reason, reason === 'STUDIO_KEY_UNAVAILABLE' || reason === 'ACCEPTANCE_UNAVAILABLE');
    return null;
}

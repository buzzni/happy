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
const keySchema = z.object({ version: z.literal(2), algorithm: z.literal('Ed25519'), keyId: z.string().regex(/^[0-9a-f]{64}$/),
    publicKey: z.string(), studioOrigin: z.string(), happyOrigin: z.string() }).passthrough();
const acceptanceSchema = z.object({ version: z.literal(2), accepted: z.boolean() }).strict();

export function createMachineRotationResolver<R>(deps: {
    env: Record<string, string | undefined>; machineId: string; happyOrigin: string; studioOrigin: string | null;
    bearer: () => string; fetch?: typeof fetch; now?: () => number;
    createRuntime(config: MachineRotationConfig): R;
}) {
    const now = deps.now ?? Date.now, fetcher = deps.fetch ?? fetch;
    let key: { value: { publicKey: string; keyId: string }; until: number } | null = null;
    const acceptance = new Map<string, { accepted: boolean; until: number }>();
    const runtimes = new Map<string, R>();
    const forcedOff = () => ['false', 'off', '0'].includes((deps.env.HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED ?? '').trim().toLowerCase());

    async function studioKey(origin: string) {
        if (key && key.until > now()) return key.value;
        const response = await fetcher(origin + '/api/claude-setup-token/daemon/v2/public-key', {
            redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('STUDIO_KEY_UNAVAILABLE');
        const text = await response.text();
        if (text.length > 4096) throw new Error('STUDIO_KEY_UNAVAILABLE');
        const value = keySchema.parse(JSON.parse(text));
        if (value.studioOrigin !== origin || value.happyOrigin !== deps.happyOrigin
            || await rotationSha256(rotationDecodeBinary(value.publicKey, 32)) !== value.keyId) throw new Error('STUDIO_KEY_UNAVAILABLE');
        key = { value: { publicKey: value.publicKey, keyId: value.keyId }, until: now() + CACHE_MS };
        return key.value;
    }
    async function accepted(origin: string, companyId: string) {
        const cached = acceptance.get(companyId);
        if (cached && cached.until > now()) return cached.accepted;
        const url = new URL('/api/claude-setup-token/daemon/v2/acceptance', origin);
        url.searchParams.set('companyId', companyId);
        url.searchParams.set('machineId', deps.machineId);
        const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${deps.bearer()}` } });
        if (!response.ok) throw new Error('ACCEPTANCE_UNAVAILABLE');
        const value = acceptanceSchema.parse(await response.json());
        acceptance.set(companyId, { accepted: value.accepted, until: now() + CACHE_MS });
        return value.accepted;
    }
    /** The runtime for launches of this company, new or recovered; null when Studio or its key cannot be reached. */
    async function runtime(companyId: string): Promise<R | null> {
        if (!deps.studioOrigin) return null;
        let served;
        try { served = await studioKey(deps.studioOrigin); } catch { return null; }
        const cacheKey = companyId + '\u0000' + served.keyId;
        let current = runtimes.get(cacheKey);
        if (!current) {
            current = deps.createRuntime({ companyId, machineId: deps.machineId, studioOrigin: deps.studioOrigin, happyOrigin: deps.happyOrigin, studioPublicKey: served.publicKey });
            runtimes.set(cacheKey, current);
        }
        return current;
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
            try { ok = await accepted(deps.studioOrigin, companyId); } catch { return { runtime: null, reason: 'ACCEPTANCE_UNAVAILABLE' }; }
            return ok ? { runtime: current } : { runtime: null, reason: 'NOT_ACCEPTED' };
        },
    };
}

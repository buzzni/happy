/** Daemon-vouched caller bindings for hosts this daemon launched (Desktop P0a §4.4 step 1-2).
 * The host contributes only its actual runtimeId and public key; scope, depth and identity come
 * from the daemon's own launch state, never from the report, provider env or workspace ledger. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { OwnershipCallerBindingSchema, ownershipId } from '@slopus/happy-wire';
import type { TrackedSession } from './types';
import { readTrustedStudioOrigin } from './setupTokenBindingProof';

type Caller = z.infer<typeof OwnershipCallerBindingSchema>;
type Identity = { machineId: string; happyAccountId: string; epoch: string };
export interface OwnerContactTrust {
    issuer: string; audience: string; publicKeys: Record<string, string>;
    /** The daemon's trusted Studio origin; the only lookup destination a host may use. */
    lookupOrigin: string;
}
const reportSchema = z.object({ sessionId: ownershipId, runtimeId: ownershipId, hostPid: z.number().int().positive(),
    callerPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const COUNT = /^\d{1,9}$/;
/** Rollout switch of the daemon and host. Default OFF; it never supplies source, owner or scope. */
export const OWNER_CONTACT_SWITCH = 'HAPPY_OWNER_CONTACT_V1';

/** The daemon's existing ownership trust (as ownedSpawnRuntime verifies proofs) and its trusted Studio origin. */
export function readOwnerContactTrust(env: Record<string, string | undefined>, happyOrigin: string): OwnerContactTrust | null {
    const lookupOrigin = readTrustedStudioOrigin(env), issuer = env.HAPPY_SESSION_OWNERSHIP_ISSUER;
    if (env.HAPPY_SESSION_OWNERSHIP_ENABLED !== '1' || !issuer || env.HAPPY_SESSION_OWNERSHIP_AUDIENCE !== happyOrigin || !lookupOrigin) return null;
    try {
        const publicKeys = z.record(z.string(), z.string()).parse(JSON.parse(env.HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS ?? ''));
        return { issuer, audience: happyOrigin, publicKeys, lookupOrigin };
    } catch { return null; }
}

export function createAgentCallerLaunches(deps: {
    /** Rollout switch (HAPPY_OWNER_CONTACT_V1). Default OFF; enabling grants no authority by itself. */
    enabled: boolean;
    identity(): Promise<Identity | null>;
    trust(): OwnerContactTrust | null;
    /** The daemon's own launch record for a host process (pidToTrackedSession). */
    trackedByPid(pid: number): TrackedSession | undefined;
    live(session: TrackedSession): boolean;
    realpath?(path: string): string;
}) {
    const bound = new Map<string, { pid: number; caller: Caller; identity: Identity }>();
    const realpath = deps.realpath ?? realpathSync;
    /** Before the session-started webhook the launch may not know its session yet; it must never name another one. */
    function launch(sessionId: string, pid: number, confirmed: boolean) {
        const session = deps.trackedByPid(pid);
        if (!session || session.startedBy !== 'daemon' || session.pid !== pid || !deps.live(session)
            || (confirmed || session.happySessionId !== undefined ? session.happySessionId !== sessionId : false)) throw new Error('caller-not-running');
        return session;
    }
    return {
        /** Host bootstrap before provider start. First report wins for one launch (pid). */
        async issue(raw: unknown): Promise<{ caller: Caller; trust: OwnerContactTrust }> {
            if (!deps.enabled) throw new Error('owner-contact-disabled');
            const report = reportSchema.parse(raw);
            const trust = deps.trust();
            if (!trust) throw new Error('owner-contact-unconfigured');
            const session = launch(report.sessionId, report.hostPid, false);
            if (bound.get(report.sessionId)?.pid === report.hostPid) throw new Error('caller-already-bound');
            const identity = await deps.identity();
            if (!identity) throw new Error('identity-unknown');
            launch(report.sessionId, report.hostPid, false);
            if (bound.get(report.sessionId)?.pid === report.hostPid) throw new Error('caller-already-bound');
            const agent = session.agentEnvironment;
            const depth = agent?.SAYCODE_AGENT_DEPTH, scope = agent?.SAYCODE_AGENT_SCOPE ?? session.directory;
            if (!scope || (depth !== undefined && !COUNT.test(depth))) throw new Error('caller-scope-unknown');
            const caller = OwnershipCallerBindingSchema.parse({ callerBindingId: randomUUID(), sessionId: report.sessionId,
                runtimeId: report.runtimeId, machineId: identity.machineId, happyAccountId: identity.happyAccountId,
                scope: realpath(scope), depth: depth === undefined ? 0 : Number(depth), hostEpoch: randomUUID(),
                callerPublicKey: report.callerPublicKey });
            bound.set(report.sessionId, { pid: report.hostPid, caller, identity });
            return { caller: { ...caller }, trust };
        },
        /** agent-caller-binding for non-journal sources. Never reconstructs a binding. */
        async query(raw: unknown) {
            const input = z.object({ sessionId: ownershipId, nonce: z.string().min(16).max(256) }).strict().parse(raw);
            const entry = bound.get(input.sessionId);
            if (!deps.enabled || !entry) throw new Error('caller-unavailable');
            // Main may ask before the session-started webhook; that is pending, not a stale launch.
            const pending = deps.trackedByPid(entry.pid);
            if (pending?.pid === entry.pid && pending.happySessionId === undefined && deps.live(pending)) throw new Error('caller-pending');
            try { launch(input.sessionId, entry.pid, true); } catch (error) { bound.delete(input.sessionId); throw error; }
            const identity = await deps.identity();
            if (bound.get(input.sessionId) !== entry) throw new Error('caller-changed');
            if (identity?.epoch !== entry.identity.epoch || identity.machineId !== entry.identity.machineId
                || identity.happyAccountId !== entry.identity.happyAccountId) {
                bound.delete(input.sessionId); throw new Error('identity-changed');
            }
            return { version: 1 as const, nonce: input.nonce, caller: { ...entry.caller } };
        },
    };
}

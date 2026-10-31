/** Daemon-vouched caller bindings for hosts this daemon launched (Desktop P0a §4.4 step 1-2).
 * The host contributes only its actual runtimeId and public key, authenticated by a one-time launch
 * capability on a private pipe. Scope, depth and identity come from the daemon's own launch state,
 * never from the report, the requested/provider env or a workspace ledger. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import type { Writable } from 'node:stream';
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
const key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const reportSchema = z.object({ sessionId: ownershipId, runtimeId: ownershipId, hostPid: z.number().int().positive(),
    callerPublicKey: key32, capability: key32 }).strict();
/** Names the inherited pipe that carries the launch capability; the value is only a descriptor number. */
export const OWNER_CONTACT_FD = 'HAPPY_OWNER_CONTACT_FD';
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

/** An owned child's lineage, fixed by the daemon from its owned-spawn journal before the launch (T1c-b2 H3).
 * 'unknown' marks an owned session whose lineage could not be read: it gets no binding, never depth 0. */
export type OwnedLaunchLineage = { sessionId: string; scope: string; depth: number; parentCallerPublicKey?: string };

const sameIdentity = (current: Identity | null, issued: Identity) => current?.epoch === issued.epoch
    && current.machineId === issued.machineId && current.happyAccountId === issued.happyAccountId;

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
    /** In memory only: a daemon restart forgets them, so a recovered host gets no binding. */
    const launches = new Map<number, { capability: Buffer; cwd: string; depth: number | null; owned?: OwnedLaunchLineage }>();
    const realpath = deps.realpath ?? realpathSync;
    /** Before the session-started webhook the launch may not know its session yet; it must never name another one. */
    function launch(sessionId: string, pid: number, confirmed: boolean) {
        const session = deps.trackedByPid(pid);
        if (!session || session.startedBy !== 'daemon' || session.pid !== pid || !deps.live(session)
            || (confirmed || session.happySessionId !== undefined ? session.happySessionId !== sessionId : false)) throw new Error('caller-not-running');
        return session;
    }
    function unique(report: z.infer<typeof reportSchema>, owned?: OwnedLaunchLineage) {
        if (report.callerPublicKey === owned?.parentCallerPublicKey
            || [...bound.values()].some(entry => entry.caller.callerPublicKey === report.callerPublicKey)) throw new Error('caller-key-reused');
        // One live host per session: a second start of the same session gets no binding.
        const prior = bound.get(report.sessionId), priorLaunch = prior && deps.trackedByPid(prior.pid);
        if (prior && prior.pid !== report.hostPid && priorLaunch?.pid === prior.pid && priorLaunch.startedBy === 'daemon'
            && deps.live(priorLaunch)) throw new Error('caller-duplicate-launch');
    }
    /** The binding the daemon still vouches for: a confirmed live launch under the identity it was issued to. */
    async function vouched(sessionId: string): Promise<Caller> {
        const entry = bound.get(sessionId);
        if (!deps.enabled || !entry) throw new Error('caller-unavailable');
        // Main may ask before the session-started webhook; that is pending, not a stale launch.
        const pending = deps.trackedByPid(entry.pid);
        if (pending?.pid === entry.pid && pending.happySessionId === undefined && deps.live(pending)) throw new Error('caller-pending');
        try { launch(sessionId, entry.pid, true); } catch (error) { bound.delete(sessionId); throw error; }
        const identity = await deps.identity().catch(() => null);
        if (bound.get(sessionId) !== entry) throw new Error('caller-changed');
        if (!sameIdentity(identity, entry.identity)) { bound.delete(sessionId); throw new Error('identity-changed'); }
        return { ...entry.caller };
    }
    return {
        /** At spawn: one capability per launch, written once to an extra stdio pipe the host closes before its provider starts. */
        prepareLaunch(input: { cwd: string; agentEnvironment?: TrackedSession['agentEnvironment']; owned?: OwnedLaunchLineage | 'unknown' | null }) {
            if (!deps.enabled) return null;
            const capability = randomBytes(32);
            const owned = input.owned && input.owned !== 'unknown' ? input.owned : undefined;
            // An agent grant's scope and depth come from the spawn request; the daemon has no lineage for them.
            // An owned child's come from the daemon's own journal, so they replace both (H3).
            const depth = owned ? owned.depth : input.owned === 'unknown' || input.agentEnvironment?.SAYCODE_AGENT_ENV === '1' ? null : 0;
            let index = -1;
            return {
                stdio(base: StdioOptions) {
                    const list = Array.isArray(base) ? [...base] : [base, base, base];
                    while (list.length < 3) list.push('ignore');
                    index = list.length; list.push('pipe');
                    return { stdio: list, environment: { [OWNER_CONTACT_FD]: String(index) } };
                },
                attach(child: ChildProcess) {
                    const pipe = child.stdio[index] as Writable | null | undefined, pid = child.pid;
                    if (!pid || index < 3 || !pipe) return;
                    launches.set(pid, { capability, cwd: owned?.scope ?? input.cwd, depth, ...(owned ? { owned } : {}) });
                    const forget = () => { if (launches.get(pid)?.capability === capability) launches.delete(pid); };
                    child.once('exit', forget); child.once('error', forget); pipe.on('error', forget);
                    pipe.end(JSON.stringify({ capability: capability.toString('base64url') }));
                },
            };
        },
        /** Host bootstrap before provider start. The capability is single-use and bound to its launch pid. */
        async issue(raw: unknown): Promise<{ caller: Caller; trust: OwnerContactTrust }> {
            if (!deps.enabled) throw new Error('owner-contact-disabled');
            const report = reportSchema.parse(raw);
            const record = launches.get(report.hostPid), offered = Buffer.from(report.capability, 'base64url');
            if (!record || offered.length !== record.capability.length || !timingSafeEqual(offered, record.capability)) throw new Error('caller-capability-invalid');
            launches.delete(report.hostPid);
            const trust = deps.trust();
            if (!trust) throw new Error('owner-contact-unconfigured');
            launch(report.sessionId, report.hostPid, false);
            if (record.depth === null) throw new Error('caller-lineage-unknown');
            // An owned child binds only itself, with its own key: never its parent's session or contact key.
            if (record.owned && report.sessionId !== record.owned.sessionId) throw new Error('caller-not-running');
            unique(report, record.owned);
            const identity = await deps.identity();
            if (!identity) throw new Error('identity-unknown');
            launch(report.sessionId, report.hostPid, false);
            unique(report, record.owned);
            const caller = OwnershipCallerBindingSchema.parse({ callerBindingId: randomUUID(), sessionId: report.sessionId,
                runtimeId: report.runtimeId, machineId: identity.machineId, happyAccountId: identity.happyAccountId,
                scope: realpath(record.cwd), depth: record.depth, hostEpoch: randomUUID(), callerPublicKey: report.callerPublicKey });
            bound.set(report.sessionId, { pid: report.hostPid, caller, identity });
            return { caller: { ...caller }, trust };
        },
        /** Lets a host check, before each signature and reply, that the daemon still vouches for its binding.
         * Same fences as query(): an ended launch or a changed/unknown identity revokes the binding. */
        async current(raw: unknown): Promise<{ current: boolean }> {
            const input = z.object({ sessionId: ownershipId, callerBindingId: ownershipId }).strict().parse(raw);
            const entry = bound.get(input.sessionId);
            if (!deps.enabled || !entry || entry.caller.callerBindingId !== input.callerBindingId) return { current: false };
            const session = deps.trackedByPid(entry.pid);
            if (!session || session.pid !== entry.pid || session.startedBy !== 'daemon' || !deps.live(session)
                || (session.happySessionId !== undefined && session.happySessionId !== input.sessionId)) {
                bound.delete(input.sessionId); return { current: false };
            }
            const identity = await deps.identity().catch(() => null);
            if (bound.get(input.sessionId) !== entry) return { current: false };
            if (!sameIdentity(identity, entry.identity)) { bound.delete(input.sessionId); return { current: false }; }
            return { current: true };
        },
        /** Owner contact is served only with the switch on and the daemon's trust configured. */
        available() { return deps.enabled && deps.trust() !== null; },
        /** The child binding an owned start waits for; null unless the daemon still vouches for it. */
        async currentCaller(sessionId: string): Promise<Caller | null> {
            try { return await vouched(sessionId); } catch { return null; }
        },
        /** agent-caller-binding for non-journal sources. Never reconstructs a binding. */
        async query(raw: unknown) {
            const input = z.object({ sessionId: ownershipId, nonce: z.string().min(16).max(256) }).strict().parse(raw);
            return { version: 1 as const, nonce: input.nonce, caller: await vouched(input.sessionId) };
        },
    };
}

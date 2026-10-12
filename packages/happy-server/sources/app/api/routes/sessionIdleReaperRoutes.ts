import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { requireAccountPrincipal } from "@/app/api/utils/enableAuthentication";

/**
 * Self-host answer to the daemon's idle-session question (Desktop specs/headless-standalone-server
 * R23, R23b). The cloud serves this path from web-ui with project presence; a self-hosted or
 * Desktop-embedded happy-server has neither, so it only applies the absolute idle cut and the
 * daemon still re-checks every candidate locally before stopping it.
 *
 * Registered only when HAPPY_SESSION_IDLE_REAPER is set: the cloud server's routes stay as they are.
 */
export type SessionIdleReaperMode = "absolute" | "off";

export function readSessionIdleReaperMode(env: NodeJS.ProcessEnv): SessionIdleReaperMode | null {
    const value = env.HAPPY_SESSION_IDLE_REAPER?.trim();
    if (!value) return null;
    if (value === "absolute" || value === "off") return value;
    throw new Error(`HAPPY_SESSION_IDLE_REAPER must be "absolute" or "off", got "${value}"`);
}

const DEFAULT_IDLE_AFTER_MS = 24 * 60 * 60 * 1000;

const observedSession = z.object({
    sessionId: z.string(),
    thinking: z.boolean(),
    hasOpenToolCall: z.boolean(),
    pendingUserInput: z.boolean(),
    lastActiveAt: z.number(),
    lastUserInteractionAt: z.number().optional(),
    launchedBackgroundJob: z.boolean().optional(),
}).passthrough();

const requestBody = z.object({
    machineId: z.string(),
    sessions: z.array(observedSession),
    idleAfterMs: z.number().positive().optional(),
}).passthrough();

type ReaperRequest = z.infer<typeof requestBody>;

export interface IdleCandidate {
    sessionId: string;
    projectId: null;
    machineId: string;
    lastActiveAt: number;
    idleMs: number;
    reason: "absolute-idle-cut";
}

/**
 * The daemon's lastActiveAt is when the session started, so idleness is measured from the later
 * of that and the last real user action — otherwise a long-running session someone used minutes
 * ago would look a day idle. Busy sessions and ones that launched background work are never picked.
 */
export function selectAbsoluteIdleCandidates(request: ReaperRequest, now: number): IdleCandidate[] {
    const idleAfterMs = request.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    const candidates: IdleCandidate[] = [];
    for (const session of request.sessions) {
        if (session.thinking || session.hasOpenToolCall || session.pendingUserInput || session.launchedBackgroundJob) continue;
        const lastActiveAt = Math.max(session.lastActiveAt, session.lastUserInteractionAt ?? 0);
        const idleMs = now - lastActiveAt;
        if (idleMs <= idleAfterMs) continue;
        candidates.push({ sessionId: session.sessionId, projectId: null, machineId: request.machineId, lastActiveAt, idleMs, reason: "absolute-idle-cut" });
    }
    return candidates;
}

export function sessionIdleReaperRoutes(app: Fastify, options: { mode: SessionIdleReaperMode; now?: () => number }) {
    const now = options.now ?? Date.now;
    app.post('/api/daemon/session-idle-reaper/candidates', {
        preHandler: [app.authenticate, requireAccountPrincipal],
        schema: { body: requestBody },
    }, async (request, reply) => {
        const machine = await db.machine.findFirst({ where: { id: request.body.machineId, accountId: request.userId }, select: { id: true } });
        if (!machine) return reply.code(404).send({ error: 'Machine not found' });
        const checkedAt = now();
        const candidates = options.mode === "absolute" ? selectAbsoluteIdleCandidates(request.body, checkedAt) : [];
        return reply.send({ checkedAt, candidates });
    });
}

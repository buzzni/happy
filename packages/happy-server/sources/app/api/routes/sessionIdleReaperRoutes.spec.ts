import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

// Desktop specs/headless-standalone-server R23, R23b (T33, approval 9).
//
// Self-hosted and Desktop-embedded daemons ask this server which of their sessions have been
// idle long enough to stop. The cloud answers from web-ui; a self-hosted happy-server only
// answers when the env turns the route on, and only for the caller's own machines.

const { db, machines } = vi.hoisted(() => {
    const machines = new Map<string, string>();
    const db = {
        machine: {
            findFirst: vi.fn(async ({ where }: any) => (machines.get(where.id) === where.accountId ? { id: where.id } : null)),
        },
    };
    return { db, machines };
});
vi.mock("@/storage/db", () => ({ db }));

import { readSessionIdleReaperMode, selectAbsoluteIdleCandidates, sessionIdleReaperRoutes } from "./sessionIdleReaperRoutes";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const session = (overrides: Record<string, unknown> = {}) => ({
    sessionId: "s1", agent: "claude", active: true, thinking: false, hasOpenToolCall: false, pendingUserInput: false,
    lastActiveAt: NOW - 30 * HOUR, ...overrides,
});

async function createApp(mode: "absolute" | "off", userId = "owner-account") {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any) => {
        request.userId = userId;
        request.principal = { kind: "account" };
    });
    sessionIdleReaperRoutes(typed, { mode, now: () => NOW });
    await typed.ready();
    return typed;
}

beforeEach(() => { machines.clear(); machines.set("m1", "owner-account"); });

describe("readSessionIdleReaperMode", () => {
    it("is off the route entirely unless the env names a mode", () => {
        expect(readSessionIdleReaperMode({})).toBeNull();
        expect(readSessionIdleReaperMode({ HAPPY_SESSION_IDLE_REAPER: "absolute" })).toBe("absolute");
        expect(readSessionIdleReaperMode({ HAPPY_SESSION_IDLE_REAPER: "off" })).toBe("off");
        expect(() => readSessionIdleReaperMode({ HAPPY_SESSION_IDLE_REAPER: "sometimes" })).toThrow();
    });
});

describe("selectAbsoluteIdleCandidates", () => {
    it("picks sessions idle past the cut by the later of start and last user action", () => {
        const picked = selectAbsoluteIdleCandidates({ machineId: "m1", sessions: [session()] }, NOW);
        expect(picked).toEqual([{ sessionId: "s1", projectId: null, machineId: "m1", lastActiveAt: NOW - 30 * HOUR, idleMs: 30 * HOUR, reason: "absolute-idle-cut" }]);
        // Started long ago but the user was here 40 minutes ago: not idle.
        expect(selectAbsoluteIdleCandidates({ machineId: "m1", sessions: [session({ lastUserInteractionAt: NOW - 40 * 60 * 1000 })] }, NOW)).toEqual([]);
    });

    it("never picks a busy session or one that launched a background job", () => {
        for (const busy of [{ thinking: true }, { hasOpenToolCall: true }, { pendingUserInput: true }, { launchedBackgroundJob: true }]) {
            expect(selectAbsoluteIdleCandidates({ machineId: "m1", sessions: [session(busy)] }, NOW)).toEqual([]);
        }
    });

    it("uses the daemon's idleAfterMs when it sends one, 24 hours otherwise", () => {
        expect(selectAbsoluteIdleCandidates({ machineId: "m1", sessions: [session({ lastActiveAt: NOW - 2 * HOUR })] }, NOW)).toEqual([]);
        expect(selectAbsoluteIdleCandidates({ machineId: "m1", idleAfterMs: HOUR, sessions: [session({ lastActiveAt: NOW - 2 * HOUR })] }, NOW)).toHaveLength(1);
    });
});

describe("POST /api/daemon/session-idle-reaper/candidates", () => {
    const url = "/api/daemon/session-idle-reaper/candidates";

    it("answers the daemon of the caller's own machine", async () => {
        const app = await createApp("absolute");
        const res = await app.inject({ method: "POST", url, payload: { machineId: "m1", sessions: [session()] } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ checkedAt: NOW, candidates: [expect.objectContaining({ sessionId: "s1", reason: "absolute-idle-cut" })] });
    });

    it("refuses a machine that belongs to someone else", async () => {
        const app = await createApp("absolute", "other-account");
        const res = await app.inject({ method: "POST", url, payload: { machineId: "m1", sessions: [session()] } });
        expect(res.statusCode).toBe(404);
    });

    it("answers with no candidates when the policy is off", async () => {
        const app = await createApp("off");
        const res = await app.inject({ method: "POST", url, payload: { machineId: "m1", sessions: [session()] } });
        expect(res.json()).toEqual({ checkedAt: NOW, candidates: [] });
    });
});

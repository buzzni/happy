import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const { state, dbMock, resetState, accessKeyFindUnique } = vi.hoisted(() => {
    const state = { accessKey: null as any };
    const resetState = () => { state.accessKey = null; };
    const accessKeyFindUnique = vi.fn(async () => state.accessKey);
    const dbMock = { accessKey: { findUnique: accessKeyFindUnique } };
    return { state, dbMock, resetState, accessKeyFindUnique };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { machineSessionOwnerRoutes } from "./machineSessionOwnerRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });
    machineSessionOwnerRoutes(typed);
    await typed.ready();
    return typed;
}

function ask(app: Fastify, opts: { userId?: string; machineId?: unknown; sessionId?: string } = {}) {
    return app.inject({
        method: "POST",
        url: `/v1/machine-sessions/${opts.sessionId ?? "S-1"}/owner`,
        headers: opts.userId === undefined ? {} : { "x-user-id": opts.userId },
        payload: { machineId: opts.machineId ?? "M-1" },
    });
}

// specs/cli-agent-spawn-project-visibility-server (aplus-dev-studio).
//
// A+ needs to know whether the machine calling it really owns a session that `agent spawn`
// just created, WITHOUT an automation run claim — a plain spawn has none. The AccessKey row
// is the proof: it exists exactly when this machine can read that session's data.
describe("machineSessionOwnerRoutes — POST /v1/machine-sessions/:sessionId/owner", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); accessKeyFindUnique.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    it("reports the owning account when the machine holds an access key for the session", async () => {
        state.accessKey = { accountId: "acc-1", machineId: "M-1", sessionId: "S-1" };
        app = await createApp();

        const res = await ask(app, { userId: "acc-1" });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ owner: { ownerAccountId: "acc-1" } });
        expect(accessKeyFindUnique).toHaveBeenCalledWith({
            where: { accountId_machineId_sessionId: { accountId: "acc-1", machineId: "M-1", sessionId: "S-1" } },
        });
    });

    it("answers 200 with a null owner when no access key ties this machine to the session", async () => {
        // Deliberately NOT a 404: an older server that does not serve this route at all also
        // answers 404, and the caller must be able to tell "not the owner" (deny) apart from
        // "route unavailable" (retry). Keeping both outcomes on 200 makes any non-200 an outage.
        state.accessKey = null;
        app = await createApp();

        const res = await ask(app, { userId: "acc-1" });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ owner: null });
    });

    it("scopes the lookup to the authenticated account, so another account's session is not disclosed", async () => {
        state.accessKey = null;
        app = await createApp();

        await ask(app, { userId: "attacker", sessionId: "victim-session" });

        expect(accessKeyFindUnique).toHaveBeenCalledWith({
            where: {
                accountId_machineId_sessionId: {
                    accountId: "attacker", machineId: "M-1", sessionId: "victim-session",
                },
            },
        });
    });

    it("rejects an unauthenticated request", async () => {
        app = await createApp();

        const res = await ask(app);

        expect(res.statusCode).toBe(401);
        expect(accessKeyFindUnique).not.toHaveBeenCalled();
    });

    it("rejects a request with no machineId", async () => {
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/machine-sessions/S-1/owner",
            headers: { "x-user-id": "acc-1" },
            payload: {},
        });

        expect(res.statusCode).toBe(400);
        expect(accessKeyFindUnique).not.toHaveBeenCalled();
    });
});

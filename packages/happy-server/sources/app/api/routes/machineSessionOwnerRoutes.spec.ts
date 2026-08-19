import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const { state, dbMock, resetState, sessionFindFirst, machineFindFirst } = vi.hoisted(() => {
    const state = { session: null as any, machine: null as any };
    const resetState = () => { state.session = null; state.machine = null; };
    const sessionFindFirst = vi.fn(async () => state.session);
    const machineFindFirst = vi.fn(async () => state.machine);
    const dbMock = {
        session: { findFirst: sessionFindFirst },
        machine: { findFirst: machineFindFirst },
    };
    return { state, dbMock, resetState, sessionFindFirst, machineFindFirst };
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
// just created, WITHOUT an automation run claim — a plain spawn has none.
//
// The first implementation proved this with the `AccessKey` table (a machine can decrypt a
// session's data only if it holds a wrapped key for it). Real E2E testing against production
// found that table permanently empty: no Happy client — not happy-cli, not happy-app — ever
// calls the route that would populate it. It is unused infrastructure, not a live signal.
//
// The proof used here instead: `Session.accountId` and `Machine.accountId` are plain columns
// (not the encrypted `metadata`/`data` blobs), and `accessKeysRoutes.ts`'s own GET handler
// already trusts exactly this pair to establish "this account may touch this session/machine".
// It is a same-account check, not a same-machine check — weaker than the AccessKey model would
// have been (any of the account's machines can now claim any of the account's sessions), but it
// is real, and for a daemon self-reporting a session it just spawned that is the same trust bar
// `chat -p` already assumes end to end.
describe("machineSessionOwnerRoutes — POST /v1/machine-sessions/:sessionId/owner", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); sessionFindFirst.mockClear(); machineFindFirst.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    it("reports the owning account when both the session and the machine belong to it", async () => {
        state.session = { id: "S-1", accountId: "acc-1" };
        state.machine = { id: "M-1", accountId: "acc-1" };
        app = await createApp();

        const res = await ask(app, { userId: "acc-1" });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ owner: { ownerAccountId: "acc-1" } });
        expect(sessionFindFirst).toHaveBeenCalledWith({ where: { id: "S-1", accountId: "acc-1" } });
        expect(machineFindFirst).toHaveBeenCalledWith({ where: { id: "M-1", accountId: "acc-1" } });
    });

    it("answers 200 with a null owner when the session does not belong to this account", async () => {
        // Deliberately NOT a 404: an older server that does not serve this route at all also
        // answers 404, and the caller must be able to tell "not the owner" (deny) apart from
        // "route unavailable" (retry). Keeping both outcomes on 200 makes any non-200 an outage.
        state.session = null;
        state.machine = { id: "M-1", accountId: "acc-1" };
        app = await createApp();

        const res = await ask(app, { userId: "acc-1" });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ owner: null });
    });

    it("answers 200 with a null owner when the machine does not belong to this account", async () => {
        state.session = { id: "S-1", accountId: "acc-1" };
        state.machine = null;
        app = await createApp();

        const res = await ask(app, { userId: "acc-1" });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ owner: null });
    });

    it("scopes both lookups to the authenticated account, so another account's session is not disclosed", async () => {
        state.session = null;
        state.machine = null;
        app = await createApp();

        await ask(app, { userId: "attacker", sessionId: "victim-session" });

        expect(sessionFindFirst).toHaveBeenCalledWith({ where: { id: "victim-session", accountId: "attacker" } });
        expect(machineFindFirst).toHaveBeenCalledWith({ where: { id: "M-1", accountId: "attacker" } });
    });

    it("rejects an unauthenticated request", async () => {
        app = await createApp();

        const res = await ask(app);

        expect(res.statusCode).toBe(401);
        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(machineFindFirst).not.toHaveBeenCalled();
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
        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(machineFindFirst).not.toHaveBeenCalled();
    });
});

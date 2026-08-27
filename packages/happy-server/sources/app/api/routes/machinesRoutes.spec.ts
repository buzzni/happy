import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";
// Cross-package contract check: the app's real update schema. apiTypes.ts is
// pure zod (no react-native / @/ aliases), so it imports cleanly in node.
import { ApiUpdateContainerSchema } from "../../../../../happy-app/sources/sync/apiTypes";

const {
    state,
    dbMock,
    resetState,
    allocateUserSeqMock,
    emitUpdateSpy,
    emitEphemeralSpy,
    machineUpdate,
    machineUpdateMany,
    accessKeyMutationSpy,
    sessionMutationSpy,
    logSpy,
} = vi.hoisted(() => {
    const emitUpdateSpy = vi.fn();
    const emitEphemeralSpy = vi.fn();
    const accessKeyMutationSpy = vi.fn();
    const sessionMutationSpy = vi.fn();
    const logSpy = vi.fn();
    const state = {
        existingMachine: null as any,
        created: [] as any[],
        seq: 0,
    };

    const resetState = () => {
        state.existingMachine = null;
        state.created = [];
        state.seq = 0;
    };

    const machineFindFirst = vi.fn(async (args?: any) => {
        const machine = state.existingMachine;
        if (!machine) return null;
        const where = args?.where ?? {};
        if (where.id !== undefined && machine.id !== where.id) return null;
        if (where.accountId !== undefined && machine.accountId !== where.accountId) return null;
        return machine;
    });
    const machineCreate = vi.fn(async (args: any) => {
        // Mirror a Prisma Machine row: server defaults active=false on create
        // ("Default to offline - in case the user does not start daemon").
        const now = new Date("2026-01-01T00:00:00.000Z");
        const row = {
            id: args.data.id,
            accountId: args.data.accountId,
            seq: 7,
            metadata: args.data.metadata,
            metadataVersion: args.data.metadataVersion ?? 1,
            daemonState: args.data.daemonState ?? null,
            daemonStateVersion: args.data.daemonStateVersion ?? 0,
            dataEncryptionKey: args.data.dataEncryptionKey ?? null,
            serverDataEncryptionKey: args.data.serverDataEncryptionKey ?? null,
            active: false,
            lastActiveAt: now,
            createdAt: now,
            updatedAt: now,
        };
        state.created.push(row);
        return row;
    });

    const machineUpdate = vi.fn(async (args: any) => {
        state.existingMachine = { ...state.existingMachine, ...args.data };
        return state.existingMachine;
    });
    const machineUpdateMany = vi.fn(async (args: any) => {
        const machine = state.existingMachine;
        const expected = args.where.dataEncryptionKey;
        const matchesExpected = machine?.dataEncryptionKey instanceof Uint8Array
            && expected instanceof Uint8Array
            && Buffer.from(machine.dataEncryptionKey).equals(Buffer.from(expected));
        if (!machine || machine.id !== args.where.id || machine.accountId !== args.where.accountId || !matchesExpected) {
            return { count: 0 };
        }
        state.existingMachine = { ...machine, ...args.data };
        return { count: 1 };
    });
    const machineFindMany = vi.fn(async (): Promise<any[]> => []);
    const dbMock = {
        machine: { findFirst: machineFindFirst, create: machineCreate, update: machineUpdate, updateMany: machineUpdateMany, findMany: machineFindMany },
        accessKey: { updateMany: accessKeyMutationSpy, deleteMany: accessKeyMutationSpy },
        session: { updateMany: sessionMutationSpy, deleteMany: sessionMutationSpy },
    };
    const allocateUserSeqMock = vi.fn(async () => ++state.seq);

    return {
        state,
        dbMock,
        resetState,
        allocateUserSeqMock,
        emitUpdateSpy,
        emitEphemeralSpy,
        machineUpdate,
        machineUpdateMany,
        accessKeyMutationSpy,
        sessionMutationSpy,
        logSpy,
    };
});

// Keep the REAL event-builder functions (buildNewMachineUpdate etc.), but
// replace the eventRouter singleton with a spy so we can capture exactly what
// the create handler emits.
vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return { ...actual, eventRouter: { emitUpdate: emitUpdateSpy, emitEphemeral: emitEphemeralSpy } };
});
vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/seq", () => ({ allocateUserSeq: allocateUserSeqMock }));
vi.mock("@/storage/inTx", () => ({ inTx: async (fn: any) => fn({}), afterTx: (_tx: any, cb: () => void) => cb() }));
vi.mock("@/utils/log", () => ({ log: logSpy, warn: vi.fn(), error: vi.fn() }));

import { machinesRoutes } from "./machinesRoutes";

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
    machinesRoutes(typed);
    await typed.ready();
    return typed;
}

function findEmit(t: string) {
    return emitUpdateSpy.mock.calls.find(([p]) => p?.payload?.body?.t === t)?.[0];
}

describe("machinesRoutes — POST /v1/machines creation emits", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); emitUpdateSpy.mockClear(); emitEphemeralSpy.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    it("emits new-machine to the user's app AND a key-less update-machine companion", async () => {
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: {
                id: "machine-1",
                metadata: "encrypted-metadata-blob",
                dataEncryptionKey: Buffer.from("the-data-key").toString("base64"),
            },
        });
        expect(res.statusCode).toBe(200);

        const newMachine = findEmit("new-machine");
        const updateMachine = findEmit("update-machine");

        // Both updates are emitted on creation.
        expect(newMachine).toBeDefined();
        expect(updateMachine).toBeDefined();

        // new-machine is the signal the user's app gets to LEARN about the
        // machine, and it carries the per-machine data encryption key.
        expect(newMachine.recipientFilter).toEqual({ type: "user-scoped-only" });
        expect(newMachine.payload.body.dataEncryptionKey).toBeTruthy();

        // The update-machine companion ALSO reaches the app (machine-scoped-only
        // resolves to a union that includes the user-scoped room), but it carries
        // NO data encryption key — so pre-fix the app could not initialize this
        // brand-new machine's encryption from it and dropped it at the
        // getMachineEncryption() guard. That's why new-machine handling is required.
        expect(updateMachine.recipientFilter).toEqual({ type: "machine-scoped-only", machineId: "machine-1" });
        expect(updateMachine.payload.body).not.toHaveProperty("dataEncryptionKey");
    });

    it("emits a new-machine update that validates against the app's update schema (the fix accepts the real payload)", async () => {
        app = await createApp();

        await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: {
                id: "machine-2",
                metadata: "encrypted-metadata-blob",
                dataEncryptionKey: Buffer.from("the-data-key").toString("base64"),
            },
        });

        const newMachine = findEmit("new-machine");
        expect(newMachine).toBeDefined();

        // The exact container the server pushes over the 'update' socket event —
        // this is what Sync.handleUpdate runs ApiUpdateContainerSchema.safeParse()
        // on. Pre-fix it failed (no new-machine member) and the machine was
        // dropped; post-fix it must validate.
        const parsed = ApiUpdateContainerSchema.safeParse(newMachine.payload);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body.t).toBe("new-machine");
        }
    });

    it("emits a new-machine update that also validates when there is no data encryption key", async () => {
        app = await createApp();

        await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: { id: "machine-3", metadata: "encrypted-metadata-blob" },
        });

        const newMachine = findEmit("new-machine");
        expect(newMachine).toBeDefined();
        expect(newMachine.payload.body.dataEncryptionKey).toBeNull();
        expect(ApiUpdateContainerSchema.safeParse(newMachine.payload).success).toBe(true);
    });
});

// aplus §6-1 Phase 3c (aplus-dev-studio specs/20260818-e2ee-account-keypair) —
// dataEncryptionKey write-once 백필. 기존 머신은 create 시점에만 키를 저장할
// 수 있었는데, aplus claim 흐름은 legacy(secret) 모드로 먼저 등록하고 신버전
// daemon 이 나중에 wrap 된 machineKey 를 제출한다. null 일 때만 채우고,
// non-null 덮어쓰기는 금지한다 (키 교체 공격·고아 암호문 방지 — 회전은 별도
// 명시 흐름의 몫).
describe("machinesRoutes — POST /v1/machines dataEncryptionKey write-once backfill", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); emitUpdateSpy.mockClear(); emitEphemeralSpy.mockClear(); machineUpdate.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    const now = new Date("2026-01-01T00:00:00.000Z");
    const existingRow = (dataEncryptionKey: Uint8Array | null) => ({
        id: "machine-1",
        accountId: "user-1",
        seq: 7,
        metadata: "encrypted-metadata-blob",
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey,
        active: false,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
    });

    const post = (payload: Record<string, unknown>) => app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { "x-user-id": "user-1" },
        payload: { id: "machine-1", metadata: "encrypted-metadata-blob", ...payload },
    });

    it("backfills a null dataEncryptionKey from a late submission and echoes it", async () => {
        app = await createApp();
        state.existingMachine = existingRow(null);
        const wrapped = Buffer.from("wrapped-machine-key").toString("base64");

        const res = await post({ dataEncryptionKey: wrapped });

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).toHaveBeenCalledTimes(1);
        const updateArg = machineUpdate.mock.calls[0][0];
        expect(updateArg.where).toEqual({ id: "machine-1" });
        expect(Buffer.from(updateArg.data.dataEncryptionKey).toString("base64")).toBe(wrapped);
        expect(res.json().machine.dataEncryptionKey).toBe(wrapped);
    });

    it("never overwrites an existing dataEncryptionKey (write-once)", async () => {
        app = await createApp();
        const original = new Uint8Array(Buffer.from("original-key"));
        state.existingMachine = existingRow(original);

        const res = await post({ dataEncryptionKey: Buffer.from("attacker-key").toString("base64") });

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).not.toHaveBeenCalled();
        expect(res.json().machine.dataEncryptionKey).toBe(Buffer.from("original-key").toString("base64"));
    });

    it("does nothing when an existing machine re-registers without the field (old CLI)", async () => {
        app = await createApp();
        state.existingMachine = existingRow(null);

        const res = await post({});

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).not.toHaveBeenCalled();
        expect(res.json().machine.dataEncryptionKey).toBeNull();
    });
});

describe("machinesRoutes — PATCH /v1/machines/:id/data-encryption-key CAS", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        machineUpdateMany.mockClear();
        accessKeyMutationSpy.mockClear();
        sessionMutationSpy.mockClear();
        logSpy.mockClear();
    });
    afterEach(async () => { if (app) await app.close(); });

    const envelope = (fill: number) => {
        const bytes = new Uint8Array(105).fill(fill);
        bytes[0] = 0;
        return Buffer.from(bytes).toString("base64");
    };

    it("replaces the authenticated account's matching dataEncryptionKey", async () => {
        app = await createApp();
        const expectedDataEncryptionKey = envelope(1);
        const replacementDataEncryptionKey = envelope(2);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(expectedDataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: { expectedDataEncryptionKey, replacementDataEncryptionKey },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, changed: true });
        expect(Buffer.from(state.existingMachine.dataEncryptionKey).toString("base64")).toBe(replacementDataEncryptionKey);
    });

    it("treats the same replacement as an idempotent success", async () => {
        app = await createApp();
        const expectedDataEncryptionKey = envelope(1);
        const replacementDataEncryptionKey = envelope(2);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(replacementDataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: { expectedDataEncryptionKey, replacementDataEncryptionKey },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, changed: false });
        expect(machineUpdateMany).toHaveBeenCalledTimes(1);
    });

    it("rejects a stale expected envelope without changing the machine", async () => {
        app = await createApp();
        const currentDataEncryptionKey = envelope(3);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(currentDataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey: envelope(1),
                replacementDataEncryptionKey: envelope(2),
            },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "data-encryption-key-conflict" });
        expect(Buffer.from(state.existingMachine.dataEncryptionKey).toString("base64")).toBe(currentDataEncryptionKey);
    });

    it.each([
        ["owned by another account", "user-2"],
        ["absent", null],
    ])("returns 404 when the machine is %s", async (_case, accountId) => {
        app = await createApp();
        const originalDataEncryptionKey = envelope(1);
        state.existingMachine = accountId ? {
            id: "machine-1",
            accountId,
            dataEncryptionKey: new Uint8Array(Buffer.from(originalDataEncryptionKey, "base64")),
        } : null;

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey: originalDataEncryptionKey,
                replacementDataEncryptionKey: envelope(2),
            },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "Machine not found" });
        if (state.existingMachine) {
            expect(Buffer.from(state.existingMachine.dataEncryptionKey).toString("base64")).toBe(originalDataEncryptionKey);
        }
    });

    it("rejects malformed base64 without writing it", async () => {
        app = await createApp();
        const originalDataEncryptionKey = envelope(1);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(originalDataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey: originalDataEncryptionKey,
                replacementDataEncryptionKey: "!!!not-base64!!!",
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-data-encryption-key-envelope" });
        expect(machineUpdateMany).not.toHaveBeenCalled();
    });

    it.each([
        ["wrong-length expected envelope", Buffer.from(new Uint8Array(104)).toString("base64"), envelope(2)],
        ["unsupported-version replacement envelope", envelope(1), Buffer.from(new Uint8Array(105).fill(1)).toString("base64")],
    ])("rejects a %s", async (_case, expectedDataEncryptionKey, replacementDataEncryptionKey) => {
        app = await createApp();
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(envelope(1), "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: { expectedDataEncryptionKey, replacementDataEncryptionKey },
        });

        expect(res.statusCode).toBe(400);
        expect(machineUpdateMany).not.toHaveBeenCalled();
    });

    it("changes only dataEncryptionKey and does not expose either envelope", async () => {
        app = await createApp();
        const expectedDataEncryptionKey = envelope(1);
        const replacementDataEncryptionKey = envelope(2);
        const original = {
            id: "machine-1",
            accountId: "user-1",
            seq: 17,
            metadata: "encrypted-metadata",
            metadataVersion: 4,
            daemonState: "encrypted-daemon-state",
            daemonStateVersion: 6,
            dataEncryptionKey: new Uint8Array(Buffer.from(expectedDataEncryptionKey, "base64")),
            serverDataEncryptionKey: new Uint8Array(Buffer.from(envelope(3), "base64")),
            active: true,
            lastActiveAt: new Date("2026-08-27T00:00:00.000Z"),
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
            updatedAt: new Date("2026-08-26T00:00:00.000Z"),
        };
        state.existingMachine = original;

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: { expectedDataEncryptionKey, replacementDataEncryptionKey },
        });

        expect(res.statusCode).toBe(200);
        expect(machineUpdateMany.mock.calls[0][0].data).toEqual({
            dataEncryptionKey: new Uint8Array(Buffer.from(replacementDataEncryptionKey, "base64")),
        });
        expect(state.existingMachine).toEqual({
            ...original,
            dataEncryptionKey: new Uint8Array(Buffer.from(replacementDataEncryptionKey, "base64")),
        });
        expect(accessKeyMutationSpy).not.toHaveBeenCalled();
        expect(sessionMutationSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
        expect(res.body).not.toContain(expectedDataEncryptionKey);
        expect(res.body).not.toContain(replacementDataEncryptionKey);
    });
});

describe("machinesRoutes — serverDataEncryptionKey dual-recipient wrap (aplus §6-1 B1)", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); emitUpdateSpy.mockClear(); emitEphemeralSpy.mockClear(); machineUpdate.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    const now = new Date("2026-01-01T00:00:00.000Z");
    const existingRow = (overrides: Record<string, unknown> = {}) => ({
        id: "machine-1",
        accountId: "user-1",
        seq: 7,
        metadata: "encrypted-metadata-blob",
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
        serverDataEncryptionKey: null,
        active: false,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });

    const post = (payload: Record<string, unknown>) => app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { "x-user-id": "user-1" },
        payload: { id: "machine-1", metadata: "encrypted-metadata-blob", ...payload },
    });

    it("stores serverDataEncryptionKey on creation and echoes it", async () => {
        app = await createApp();
        const wrapped = Buffer.from("server-wrapped-machine-key").toString("base64");

        const res = await post({ serverDataEncryptionKey: wrapped });

        expect(res.statusCode).toBe(200);
        expect(res.json().machine.serverDataEncryptionKey).toBe(wrapped);
        expect(Buffer.from(state.created[0].serverDataEncryptionKey).toString("base64")).toBe(wrapped);
    });

    it("backfills a null serverDataEncryptionKey from a late submission and echoes it", async () => {
        app = await createApp();
        state.existingMachine = existingRow({ dataEncryptionKey: new Uint8Array(Buffer.from("acct-key")) });
        const wrapped = Buffer.from("server-wrapped-machine-key").toString("base64");

        const res = await post({ serverDataEncryptionKey: wrapped });

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).toHaveBeenCalledTimes(1);
        const updateArg = machineUpdate.mock.calls[0][0];
        expect(Buffer.from(updateArg.data.serverDataEncryptionKey).toString("base64")).toBe(wrapped);
        // 계정 몫 봉투는 건드리지 않는다.
        expect(updateArg.data).not.toHaveProperty("dataEncryptionKey");
        expect(res.json().machine.serverDataEncryptionKey).toBe(wrapped);
    });

    it("never overwrites an existing serverDataEncryptionKey (write-once)", async () => {
        app = await createApp();
        state.existingMachine = existingRow({ serverDataEncryptionKey: new Uint8Array(Buffer.from("original-server-key")) });

        const res = await post({ serverDataEncryptionKey: Buffer.from("attacker-key").toString("base64") });

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).not.toHaveBeenCalled();
        expect(res.json().machine.serverDataEncryptionKey).toBe(Buffer.from("original-server-key").toString("base64"));
    });

    it("re-register without the field leaves it null (old CLI)", async () => {
        app = await createApp();
        state.existingMachine = existingRow();

        const res = await post({});

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).not.toHaveBeenCalled();
        expect(res.json().machine.serverDataEncryptionKey).toBeNull();
    });

    it("GET /v1/machines includes serverDataEncryptionKey", async () => {
        app = await createApp();
        const wrapped = new Uint8Array(Buffer.from("server-wrapped-machine-key"));
        dbMock.machine.findMany.mockResolvedValue([existingRow({ serverDataEncryptionKey: wrapped })]);

        const res = await app.inject({ method: "GET", url: "/v1/machines", headers: { "x-user-id": "user-1" } });

        expect(res.statusCode).toBe(200);
        expect(res.json()[0].serverDataEncryptionKey).toBe(Buffer.from(wrapped).toString("base64"));
    });
});

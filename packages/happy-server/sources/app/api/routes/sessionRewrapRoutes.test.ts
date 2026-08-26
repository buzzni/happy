// specs/e2ee-legacy-session-rewrap (aplus-dev-studio) D3 — legacy 세션을
// 세션별 DEK 로 재암호화하기 위한 최소 쓰기 표면 2개의 계약 테스트.
// rewrap-init: write-once DEK + metadata/agentState 원자 교체 (AC3)
// rewrap-messages: 해시 CAS 조건부 메시지 교체 (AC4)
import { createHash } from "node:crypto";
import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

type SessionRecord = {
    id: string;
    accountId: string;
    dataEncryptionKey: Uint8Array | null;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
};

type MessageRecord = {
    id: string;
    sessionId: string;
    seq: number;
    content: unknown;
};

const { state, dbMock, resetState, seedSession, seedMessage } = vi.hoisted(() => {
    const state = {
        sessions: [] as SessionRecord[],
        messages: [] as MessageRecord[],
        nextMessageId: 1
    };

    const resetState = () => {
        state.sessions = [];
        state.messages = [];
        state.nextMessageId = 1;
    };

    const seedSession = (input: Partial<SessionRecord> & Pick<SessionRecord, "id" | "accountId">) => {
        state.sessions.push({
            dataEncryptionKey: null,
            metadata: "legacy-metadata",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            ...input
        });
    };

    const seedMessage = (input: { sessionId: string; seq: number; content: unknown }) => {
        state.messages.push({
            id: `msg-${state.nextMessageId}`,
            sessionId: input.sessionId,
            seq: input.seq,
            content: input.content
        });
        state.nextMessageId += 1;
    };

    const selectFields = (row: Record<string, unknown>, select?: Record<string, boolean>) => {
        if (!select) return { ...row };
        const picked: Record<string, unknown> = {};
        for (const [key, enabled] of Object.entries(select)) {
            if (enabled) picked[key] = row[key];
        }
        return picked;
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        const row = state.sessions.find((session) => (
            session.id === args?.where?.id &&
            session.accountId === args?.where?.accountId
        ));
        if (!row) return null;
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const sessionUpdateMany = vi.fn(async (args: any) => {
        const where = args?.where ?? {};
        const rows = state.sessions.filter((session) => (
            (where.id === undefined || session.id === where.id) &&
            (where.accountId === undefined || session.accountId === where.accountId) &&
            (!("dataEncryptionKey" in where) || session.dataEncryptionKey === where.dataEncryptionKey) &&
            (where.metadataVersion === undefined || session.metadataVersion === where.metadataVersion) &&
            (where.agentStateVersion === undefined || session.agentStateVersion === where.agentStateVersion)
        ));
        for (const row of rows) {
            Object.assign(row, args?.data ?? {});
        }
        return { count: rows.length };
    });

    const sessionMessageFindFirst = vi.fn(async (args: any) => {
        const row = state.messages.find((message) => (
            message.sessionId === args?.where?.sessionId &&
            message.seq === args?.where?.seq
        ));
        if (!row) return null;
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const sessionMessageUpdateMany = vi.fn(async (args: any) => {
        const rows = state.messages.filter((message) => (
            message.sessionId === args?.where?.sessionId &&
            message.seq === args?.where?.seq
        ));
        for (const row of rows) {
            row.content = args.data.content;
        }
        return { count: rows.length };
    });

    const txClient = {
        session: { findFirst: sessionFindFirst, updateMany: sessionUpdateMany },
        sessionMessage: { findFirst: sessionMessageFindFirst, updateMany: sessionMessageUpdateMany }
    };

    const dbMock = {
        session: { findFirst: sessionFindFirst, updateMany: sessionUpdateMany },
        sessionMessage: { findFirst: sessionMessageFindFirst, updateMany: sessionMessageUpdateMany },
        $transaction: vi.fn(async (fn: any) => fn(txClient))
    };

    return { state, dbMock, resetState, seedSession, seedMessage };
});

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

import { sessionRewrapRoutes } from "./sessionRewrapRoutes";

// [0x00 | ephPub(32) | nonce(24) | box(ct=32+16)] = 105 bytes — 32B DEK 봉투.
function validEnvelopeB64(): string {
    const envelope = new Uint8Array(105);
    envelope[0] = 0x00;
    envelope.fill(7, 1);
    return Buffer.from(envelope).toString("base64");
}

// [0x00 | nonce(12) | ct+tag(>=16)] — AES-256-GCM 번들.
function validGcmB64(payloadLength = 24): string {
    const bundle = new Uint8Array(1 + 12 + 16 + payloadLength);
    bundle[0] = 0x00;
    bundle.fill(9, 1);
    return Buffer.from(bundle).toString("base64");
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

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

    sessionRewrapRoutes(typed);
    await typed.ready();
    return typed;
}

describe("sessionRewrapRoutes", () => {
    let app: Fastify;

    beforeEach(async () => {
        resetState();
        app = await createApp();
    });

    describe("POST /v3/sessions/:sessionId/rewrap-init", () => {
        it("sets the DEK, metadata and agentState atomically for a legacy session with matching versions", async () => {
            seedSession({ id: "s1", accountId: "u1", metadataVersion: 3, agentState: "legacy-agent", agentStateVersion: 2 });
            const envelope = validEnvelopeB64();
            const metadata = validGcmB64();
            const agentState = validGcmB64(8);

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-init",
                headers: { "x-user-id": "u1" },
                payload: {
                    dataEncryptionKey: envelope,
                    metadata,
                    agentState,
                    expectedMetadataVersion: 3,
                    expectedAgentStateVersion: 2
                }
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true });
            const session = state.sessions[0];
            expect(session.dataEncryptionKey).toEqual(new Uint8Array(Buffer.from(envelope, "base64")));
            expect(session.metadata).toBe(metadata);
            expect(session.agentState).toBe(agentState);
            // 버전은 그대로 — 평문 내용은 동일하고 CLI 의 버전 CAS 를 흔들지 않는다.
            expect(session.metadataVersion).toBe(3);
            expect(session.agentStateVersion).toBe(2);
        });

        it("returns 409 already-rewrapped and changes nothing when the session already has a DEK", async () => {
            seedSession({ id: "s1", accountId: "u1", dataEncryptionKey: new Uint8Array(105).fill(1) });

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-init",
                headers: { "x-user-id": "u1" },
                payload: {
                    dataEncryptionKey: validEnvelopeB64(),
                    metadata: validGcmB64(),
                    agentState: null,
                    expectedMetadataVersion: 1,
                    expectedAgentStateVersion: 0
                }
            });

            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "already-rewrapped" });
            expect(state.sessions[0].dataEncryptionKey).toEqual(new Uint8Array(105).fill(1));
            expect(state.sessions[0].metadata).toBe("legacy-metadata");
        });

        it("returns 409 version-conflict and changes nothing when the metadata version moved", async () => {
            seedSession({ id: "s1", accountId: "u1", metadataVersion: 5 });

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-init",
                headers: { "x-user-id": "u1" },
                payload: {
                    dataEncryptionKey: validEnvelopeB64(),
                    metadata: validGcmB64(),
                    agentState: null,
                    expectedMetadataVersion: 4,
                    expectedAgentStateVersion: 0
                }
            });

            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "version-conflict" });
            expect(state.sessions[0].dataEncryptionKey).toBeNull();
            expect(state.sessions[0].metadata).toBe("legacy-metadata");
        });

        it("rejects a malformed DEK envelope (wrong length or version byte) with 400", async () => {
            seedSession({ id: "s1", accountId: "u1" });
            const badVersion = new Uint8Array(105);
            badVersion[0] = 0x01;

            for (const dataEncryptionKey of [
                Buffer.from(new Uint8Array(104)).toString("base64"),
                Buffer.from(badVersion).toString("base64"),
                "!!!not-base64!!!"
            ]) {
                const response = await app.inject({
                    method: "POST",
                    url: "/v3/sessions/s1/rewrap-init",
                    headers: { "x-user-id": "u1" },
                    payload: {
                        dataEncryptionKey,
                        metadata: validGcmB64(),
                        agentState: null,
                        expectedMetadataVersion: 1,
                        expectedAgentStateVersion: 0
                    }
                });
                expect(response.statusCode).toBe(400);
            }
            expect(state.sessions[0].dataEncryptionKey).toBeNull();
        });

        it("returns 404 when the session belongs to another account", async () => {
            seedSession({ id: "s1", accountId: "someone-else" });

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-init",
                headers: { "x-user-id": "u1" },
                payload: {
                    dataEncryptionKey: validEnvelopeB64(),
                    metadata: validGcmB64(),
                    agentState: null,
                    expectedMetadataVersion: 1,
                    expectedAgentStateVersion: 0
                }
            });

            expect(response.statusCode).toBe(404);
        });
    });

    describe("POST /v3/sessions/:sessionId/rewrap-messages", () => {
        const dek = new Uint8Array(105).fill(1);

        it("applies matching items and reports mismatch / not-found per item", async () => {
            seedSession({ id: "s1", accountId: "u1", dataEncryptionKey: dek });
            seedMessage({ sessionId: "s1", seq: 1, content: { t: "encrypted", c: "legacy-ct-1" } });
            seedMessage({ sessionId: "s1", seq: 2, content: { t: "encrypted", c: "legacy-ct-2" } });
            const newContent1 = validGcmB64();
            const newContent2 = validGcmB64(4);

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-messages",
                headers: { "x-user-id": "u1" },
                payload: {
                    messages: [
                        { seq: 1, expectedContentSha256: sha256Hex("legacy-ct-1"), newContent: newContent1 },
                        { seq: 2, expectedContentSha256: sha256Hex("something-else"), newContent: newContent2 },
                        { seq: 99, expectedContentSha256: sha256Hex("whatever"), newContent: validGcmB64(2) }
                    ]
                }
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                results: [
                    { seq: 1, outcome: "applied" },
                    { seq: 2, outcome: "mismatch" },
                    { seq: 99, outcome: "not-found" }
                ]
            });
            expect(state.messages[0].content).toEqual({ t: "encrypted", c: newContent1 });
            expect(state.messages[1].content).toEqual({ t: "encrypted", c: "legacy-ct-2" });
        });

        it("refuses the whole batch with 409 when the session has no DEK yet (init must come first)", async () => {
            seedSession({ id: "s1", accountId: "u1" });
            seedMessage({ sessionId: "s1", seq: 1, content: { t: "encrypted", c: "legacy-ct-1" } });

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-messages",
                headers: { "x-user-id": "u1" },
                payload: {
                    messages: [{ seq: 1, expectedContentSha256: sha256Hex("legacy-ct-1"), newContent: validGcmB64() }]
                }
            });

            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "not-rewrapped" });
            expect(state.messages[0].content).toEqual({ t: "encrypted", c: "legacy-ct-1" });
        });

        it("rejects a batch containing a non-GCM newContent with 400 and applies nothing", async () => {
            seedSession({ id: "s1", accountId: "u1", dataEncryptionKey: dek });
            seedMessage({ sessionId: "s1", seq: 1, content: { t: "encrypted", c: "legacy-ct-1" } });
            const notGcm = Buffer.from(new Uint8Array(28)).toString("base64");

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-messages",
                headers: { "x-user-id": "u1" },
                payload: {
                    messages: [
                        { seq: 1, expectedContentSha256: sha256Hex("legacy-ct-1"), newContent: notGcm }
                    ]
                }
            });

            expect(response.statusCode).toBe(400);
            expect(state.messages[0].content).toEqual({ t: "encrypted", c: "legacy-ct-1" });
        });

        it("treats a message whose stored content is not the encrypted shape as mismatch", async () => {
            seedSession({ id: "s1", accountId: "u1", dataEncryptionKey: dek });
            seedMessage({ sessionId: "s1", seq: 1, content: { t: "plain", value: 1 } });

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-messages",
                headers: { "x-user-id": "u1" },
                payload: {
                    messages: [{ seq: 1, expectedContentSha256: sha256Hex("x"), newContent: validGcmB64() }]
                }
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ results: [{ seq: 1, outcome: "mismatch" }] });
        });

        it("returns 404 when the session belongs to another account", async () => {
            seedSession({ id: "s1", accountId: "someone-else", dataEncryptionKey: dek });

            const response = await app.inject({
                method: "POST",
                url: "/v3/sessions/s1/rewrap-messages",
                headers: { "x-user-id": "u1" },
                payload: {
                    messages: [{ seq: 1, expectedContentSha256: sha256Hex("x"), newContent: validGcmB64() }]
                }
            });

            expect(response.statusCode).toBe(404);
        });
    });
});

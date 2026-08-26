// specs/e2ee-legacy-session-rewrap (aplus-dev-studio) D3 — legacy 세션을
// 세션별 DEK 로 재암호화(rewrap)하기 위한 최소 쓰기 표면.
//
// 왜 이 두 개뿐인가: rewrap 은 "헤더(write-once DEK + metadata/agentState
// 원자 교체) → 메시지(해시 CAS 조건부 교체)" 순서만 필요하다. 자유로운
// 메시지 update/delete 표면은 만들지 않는다 — 오케스트레이터(web-ui 서버)
// 가 잘못 굴러도 여기서 막히도록 형식(GCM 번들·봉투)과 선행 조건(DEK
// 존재)을 서버가 강제한다.
import { createHash } from "node:crypto";
import { db } from "@/storage/db";
import { z } from "zod";
import { type Fastify } from "../types";

// DEK 봉투: [version 0x00 | ephPub(32) | nonce(24) | box(32B payload + 16B MAC)]
const DEK_ENVELOPE_LENGTH = 105;
// AES-256-GCM 번들: [version 0x00 | nonce(12) | ct + tag(16)] — 최소 빈 평문.
const GCM_MIN_LENGTH = 1 + 12 + 16;

function decodeBase64Strict(value: string): Uint8Array | null {
    const buffer = Buffer.from(value, "base64");
    // Buffer.from 은 잘못된 문자를 조용히 버린다 — 재인코딩 대조로 거른다.
    if (buffer.toString("base64") !== value) {
        return null;
    }
    return new Uint8Array(buffer);
}

function isDekEnvelope(bytes: Uint8Array | null): bytes is Uint8Array {
    return !!bytes && bytes.length === DEK_ENVELOPE_LENGTH && bytes[0] === 0x00;
}

function isGcmBundle(value: string): boolean {
    const bytes = decodeBase64Strict(value);
    return !!bytes && bytes.length >= GCM_MIN_LENGTH && bytes[0] === 0x00;
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

const rewrapInitBodySchema = z.object({
    dataEncryptionKey: z.string(),
    metadata: z.string(),
    agentState: z.string().nullable(),
    expectedMetadataVersion: z.number().int().min(0),
    expectedAgentStateVersion: z.number().int().min(0)
});

const rewrapMessagesBodySchema = z.object({
    messages: z.array(z.object({
        seq: z.number().int().min(0),
        expectedContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
        newContent: z.string()
    })).min(1).max(100)
});

export function sessionRewrapRoutes(app: Fastify) {
    app.post('/v3/sessions/:sessionId/rewrap-init', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: rewrapInitBodySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { dataEncryptionKey, metadata, agentState, expectedMetadataVersion, expectedAgentStateVersion } = request.body;

        const envelope = decodeBase64Strict(dataEncryptionKey);
        if (!isDekEnvelope(envelope)) {
            return reply.code(400).send({ error: 'invalid-envelope' });
        }
        if (!isGcmBundle(metadata) || (agentState !== null && !isGcmBundle(agentState))) {
            return reply.code(400).send({ error: 'invalid-content-format' });
        }

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true, dataEncryptionKey: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        if (session.dataEncryptionKey !== null) {
            return reply.code(409).send({ error: 'already-rewrapped' });
        }

        // write-once + 버전 CAS 를 한 조건부 쓰기로 — 조회와 쓰기 사이에
        // 다른 rewrap 이 이기거나 활성 daemon 이 metadata/agentState 를
        // 갱신했으면 count 0 으로 아무것도 바뀌지 않는다(부분 교체 없음).
        // 버전은 올리지 않는다 — 평문 내용이 동일해서 클라이언트 재복호가
        // 불필요하고, CLI 의 버전 CAS 흐름을 흔들지 않기 위해서다.
        const updated = await db.session.updateMany({
            where: {
                id: sessionId,
                accountId: userId,
                dataEncryptionKey: null,
                metadataVersion: expectedMetadataVersion,
                agentStateVersion: expectedAgentStateVersion
            },
            data: {
                // 사본 생성 — Buffer 유래 뷰(ArrayBufferLike)를 Prisma 의
                // Uint8Array<ArrayBuffer> 요구 타입으로 맞춘다.
                dataEncryptionKey: new Uint8Array(envelope),
                metadata,
                agentState
            }
        });
        if (updated.count === 0) {
            return reply.code(409).send({ error: 'version-conflict' });
        }
        return reply.send({ ok: true });
    });

    app.post('/v3/sessions/:sessionId/rewrap-messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: rewrapMessagesBodySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { messages } = request.body;

        for (const message of messages) {
            if (!isGcmBundle(message.newContent)) {
                return reply.code(400).send({ error: 'invalid-content-format', seq: message.seq });
            }
        }

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true, dataEncryptionKey: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        // 순서 강제: 헤더(rewrap-init)가 먼저다 — DEK 없는 세션의 메시지를
        // GCM 으로 바꾸면 그 세션은 legacy 판별 아래 영구 미복호가 된다.
        if (session.dataEncryptionKey === null) {
            return reply.code(409).send({ error: 'not-rewrapped' });
        }

        const results = await db.$transaction(async (tx) => {
            const outcomes: { seq: number; outcome: 'applied' | 'mismatch' | 'not-found' }[] = [];
            for (const message of messages) {
                const existing = await tx.sessionMessage.findFirst({
                    where: { sessionId, seq: message.seq },
                    select: { content: true }
                });
                if (!existing) {
                    outcomes.push({ seq: message.seq, outcome: 'not-found' });
                    continue;
                }
                const content = existing.content as { t?: unknown; c?: unknown } | null;
                const ciphertext = content && content.t === 'encrypted' && typeof content.c === 'string'
                    ? content.c
                    : null;
                if (ciphertext === null || sha256Hex(ciphertext) !== message.expectedContentSha256) {
                    outcomes.push({ seq: message.seq, outcome: 'mismatch' });
                    continue;
                }
                await tx.sessionMessage.updateMany({
                    where: { sessionId, seq: message.seq },
                    data: {
                        content: {
                            t: 'encrypted',
                            c: message.newContent
                        }
                    }
                });
                outcomes.push({ seq: message.seq, outcome: 'applied' });
            }
            return outcomes;
        });

        return reply.send({ results });
    });
}

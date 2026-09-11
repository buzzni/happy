/**
 * The adapter, against a real HTTP server and a real filesystem.
 *
 * The authorization call is the point of this file, so it is made for real:
 * a local `http.Server` stands in for the parent and every answer it can give
 * is exercised. What stays doubled is the session — the daemon's own map and
 * its message post — because those belong to the daemon's file.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { UserMessageSchema } from '@/api/types';

import {
    createByosOfflineReceiveWiring,
    readByosParentOrigin,
    type ByosOfflineWiringDeps,
} from './byosOfflineReceiveWiring';

const KEY = new Uint8Array(32).fill(5);
const BODY = { t: 'user-text', text: 'from the queue' };
const CIPHERTEXT = encodeBase64(encrypt(KEY, 'dataKey', BODY));
// 파일 안의 계산과 같은 축인지 보려고 직접 만든다.
const DIGEST = createHash('sha256').update(CIPHERTEXT).digest('hex');

const TRACKED = {
    happySessionId: 'sess-1',
    directory: '/work/project',
    pid: 4321,
    encryption: { encryptionKey: KEY, encryptionVariant: 'dataKey' as const },
};

const deliverParams = (over: Record<string, unknown> = {}) => ({
    actorUserId: 'u-actor',
    requestKey: 'req-0001-abcdef',
    claimId: 'claim-1',
    projectId: 'p-1',
    sessionId: 'sess-1',
    machineId: 'm-1',
    bindingVersion: 4,
    ciphertextDigest: DIGEST,
    payloadCiphertext: CIPHERTEXT,
    ...over,
});

let root: string;
let server: http.Server;
let origin: string;
let reply: { status: number; body: unknown };
let seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            seen.push({
                headers: req.headers,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            });
            res.writeHead(reply.status, { 'Content-Type': 'application/json' });
            res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'byos-wiring-'));
    seen = [];
    reply = { status: 200, body: { kind: 'authorized' } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The server's answer to a message post: it names back the localId it stored. */
const ackingPost = (seen?: { url: string; body: MessagesBody }[]) => (async (
    url: string, body: unknown,
) => {
    const parsed = body as MessagesBody;
    seen?.push({ url, body: parsed });
    return {
        data: {
            messages: parsed.messages.map((m, index) => ({
                id: `msg-${index}`, seq: index + 1, localId: m.localId,
            })),
        },
    };
}) as never;

type MessagesBody = { messages: { localId: string; content: string }[] };

const wiring = (over: Partial<ByosOfflineWiringDeps> = {}) => createByosOfflineReceiveWiring({
    machineId: 'm-1',
    happyHomeDir: root,
    readAccountToken: () => 'happy-token-fixture',
    parentConfigUrl: `${origin}/api/me/mcp-config`,
    findTrackedSession: () => TRACKED,
    serverUrl: 'http://127.0.0.1:65535',
    post: ackingPost(),
    ensureSessionRunning: async () => ({ ok: true }),
    ...over,
});

describe('deciding whether there is a parent to ask', () => {
    it.each([
        ['https', 'https://saycode.example/api/me/mcp-config', 'https://saycode.example'],
        ['loopback http', 'http://127.0.0.1:3000/api/me/mcp-config', 'http://127.0.0.1:3000'],
        ['localhost http', 'http://localhost:3000/x', 'http://localhost:3000'],
    ])('takes the origin of a %s url', (_name, url, expected) => {
        expect(readByosParentOrigin(url)).toBe(expected);
    });

    it.each([
        ['unset', undefined],
        ['empty', '  '],
        ['not a url', 'saycode.example'],
        ['plain http to a remote host', 'http://saycode.example/api'],
    ])('has no parent for %s', (_name, url) => {
        // 이 경로로 자격이 나간다 — 원격 평문은 주소로 인정하지 않는다.
        expect(readByosParentOrigin(url as string | undefined)).toBeNull();
    });

    it('builds no handlers at all when there is no configured parent', () => {
        /*
         * 항상 보류만 하는 handler 를 등록하면 부모는 매 요청 사람 손을
         * 기다린다 — 설정이 안 됐다는 사실이 "막힌 큐" 로 보인다.
         */
        expect(wiring({ parentConfigUrl: null })).toBeUndefined();
    });
});

describe('asking the parent over real HTTP', () => {
    it('delivers what the parent authorized, and says what it asked', async () => {
        const posted: { url: string; body: MessagesBody }[] = [];
        const handlers = wiring({ post: ackingPost(posted) })!;
        expect(await handlers.deliver(deliverParams())).toEqual({ kind: 'accepted' });

        expect(seen[0].headers.authorization).toBe('Bearer happy-token-fixture');
        expect(seen[0].headers['x-aplus-machine-id']).toBe('m-1');
        expect(seen[0].body).toEqual({
            actorUserId: 'u-actor', requestKey: 'req-0001-abcdef', claimId: 'claim-1',
            projectId: 'p-1', sessionId: 'sess-1', machineId: 'm-1', bindingVersion: 4,
            ciphertextDigest: DIGEST,
        });
        // 봉인된 본문은 부모에게 되돌려 보내지 않는다.
        expect(JSON.stringify(seen[0].body)).not.toContain(CIPHERTEXT);

        /*
         * **세션이 사용자 입력으로 읽는 모양이어야 한다.** 큐가 봉인한
         * `{t:'user-text'}` 를 그대로 다시 봉인하면 바이트는 멀쩡한데
         * `UserMessageSchema` 가 거절해 세션은 아무 입력도 못 본다.
         */
        expect(posted[0].url).toBe(
            'http://127.0.0.1:65535/v3/sessions/sess-1/messages',
        );
        const sealed = posted[0].body.messages[0]!;
        const decoded = decrypt(KEY, 'dataKey', decodeBase64(sealed.content));
        const parsed = UserMessageSchema.safeParse(decoded);
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.content.text).toBe(BODY.text);
        expect(parsed.success && parsed.data.meta?.sentFrom).toBe('daemon');
    });

    it('refuses to guess at a body shape it does not know', async () => {
        const other = encodeBase64(encrypt(KEY, 'dataKey', { t: 'something-else', text: 'x' }));
        const posted: { url: string; body: MessagesBody }[] = [];
        expect(await wiring({ post: ackingPost(posted) })!.deliver(deliverParams({
            payloadCiphertext: other, ciphertextDigest: createHash('sha256').update(other).digest('hex'),
        }))).toEqual({ kind: 'unknown', reason: 'unsupported-body' });
        expect(posted).toHaveLength(0);
    });

    it('holds when the server stored nothing under our localId', async () => {
        // 200 은 승인이 아니다 — 우리 localId 가 seq 와 함께 돌아와야 한다.
        expect(await wiring({
            post: (async () => ({ data: { messages: [] } })) as never,
        })!.deliver(deliverParams())).toEqual({ kind: 'unknown', reason: 'ack-absent' });
    });

    it('holds when the post itself failed', async () => {
        expect(await wiring({
            post: (async () => { throw new Error('ECONNRESET') }) as never,
        })!.deliver(deliverParams())).toEqual({ kind: 'unknown', reason: 'message-post-failed' });
    });

    it('does not deliver what the parent refused, and keeps its reason', async () => {
        reply = { status: 200, body: { kind: 'refused', reason: 'needs-reconfirmation' } };
        const posted: { url: string; body: MessagesBody }[] = [];
        expect(await wiring({ post: ackingPost(posted) })!.deliver(deliverParams()))
            .toEqual({ kind: 'refused', reason: 'needs-reconfirmation' });
        expect(posted).toHaveLength(0);
    });

    it.each([
        ['a 503 hold', { status: 503, body: { kind: 'unknown', reason: 'authority-unreadable' } }, 'authority-unreadable'],
        ['a 500 with no body contract', { status: 500, body: { oops: true } }, 'unknown'],
        ['a body that is not JSON', { status: 200, body: 'not json' }, 'authorization-unreadable'],
    ])('holds on %s', async (_name, answer, reason) => {
        reply = answer as { status: number; body: unknown };
        const posted: { url: string; body: MessagesBody }[] = [];
        expect(await wiring({ post: ackingPost(posted) })!.deliver(deliverParams()))
            .toEqual({ kind: 'unknown', reason });
        expect(posted).toHaveLength(0);
    });

    it('holds when the parent rejects this daemon\'s own credential', async () => {
        // 요청의 잘못이 아니다 — 설정이 고쳐질 때까지 붙들어야 한다.
        reply = { status: 401, body: { error: 'unauthorized' } };
        expect(await wiring()!.deliver(deliverParams()))
            .toEqual({ kind: 'unknown', reason: 'parent-rejected-credential' });
    });

    it('holds when this daemon has no bearer to present', async () => {
        expect(await wiring({ readAccountToken: () => null })!.deliver(deliverParams()))
            .toEqual({ kind: 'unknown', reason: 'parent-credential-missing' });
        expect(seen).toHaveLength(0);
    });

    it('holds when the parent cannot be reached at all', async () => {
        const handlers = createByosOfflineReceiveWiring({
            machineId: 'm-1',
            happyHomeDir: root,
            readAccountToken: () => 'happy-token-fixture',
            // 아무도 듣지 않는 포트.
            parentConfigUrl: 'http://127.0.0.1:1/api',
            findTrackedSession: () => TRACKED,
            serverUrl: 'http://127.0.0.1:65535',
            post: ackingPost(),
            ensureSessionRunning: async () => ({ ok: true }),
            timeoutMs: 500,
        })!;
        expect(await handlers.deliver(deliverParams()))
            .toEqual({ kind: 'unknown', reason: 'authorization-unreachable' });
    });
});

describe('handing the message to the session', () => {
    it('holds when the message was not acknowledged', async () => {
        /*
         * 콜백이 돌아온 것은 승인이 아니다. 승인이 없으면 도착 여부를 모르므로
         * 보류이고, 기록은 남아 다음 방문이 다시 보류를 답한다.
         */
        const handlers = wiring({
            post: (async () => ({ data: { messages: [] } })) as never,
        })!;
        expect(await handlers.deliver(deliverParams()))
            .toEqual({ kind: 'unknown', reason: 'ack-absent' });
        expect(await wiring()!.deliver(deliverParams()))
            .toEqual({ kind: 'unknown', reason: 'delivery-in-progress' });
    });

    it('accepts a landed message even when waking failed, and reports the failure', async () => {
        /*
         * 메시지는 이미 기록됐다. 여기서 실패로 답하면 그것이 다시 보내진다 —
         * 깨우기는 뒤의 일이다. 다만 조용히 넘기지 않는다.
         */
        const wakeFailures: unknown[] = [];
        expect(await wiring({
            ensureSessionRunning: async () => { throw new Error('resume fence busy') },
            onWakeFailed: (input) => wakeFailures.push(input),
        })!.deliver(deliverParams())).toEqual({ kind: 'accepted' });
        expect(wakeFailures).toEqual([{ sessionId: 'sess-1', reason: 'resume-threw' }]);
    });

    it('reports a resume the daemon refused', async () => {
        const wakeFailures: unknown[] = [];
        await wiring({
            ensureSessionRunning: async () => ({ ok: false, error: 'SESSION_ALIVE_ELSEWHERE' }),
            onWakeFailed: (input) => wakeFailures.push(input),
        })!.deliver(deliverParams());
        expect(wakeFailures)
            .toEqual([{ sessionId: 'sess-1', reason: 'SESSION_ALIVE_ELSEWHERE' }]);
    });

    it('wakes the session through the daemon\'s own fence', async () => {
        const woken: unknown[] = [];
        const ensureSessionRunning = async (input: unknown) => {
            woken.push(input);
            return { ok: true };
        };
        await wiring({ ensureSessionRunning })!.deliver(deliverParams());
        // 세션 id 하나면 된다 — 그 fence 가 경로를 스스로 읽는다.
        expect(woken[0]).toEqual({ sessionId: 'sess-1' });
    });

    it('wakes a session restored without a directory, which a cold restart leaves', async () => {
        /*
         * 추운 재시작 뒤 복원된 세션은 키와 pid 는 있어도 `directory` 가 없다.
         * 그것을 깨우기의 조건으로 세우면, 메시지는 들어갔는데 아무도 깨우지
         * 않는 세션이 된다.
         */
        const woken: unknown[] = [];
        const outcome = await wiring({
            findTrackedSession: () => ({
                happySessionId: 'sess-1',
                pid: 0,
                encryption: { encryptionKey: KEY, encryptionVariant: 'dataKey' as const },
            }),
            ensureSessionRunning: async (input: unknown) => {
                woken.push(input);
                return { ok: true };
            },
        })!.deliver(deliverParams());
        expect(outcome).toEqual({ kind: 'accepted' });
        expect(woken).toEqual([{ sessionId: 'sess-1' }]);
    });

    it('does not claim to hold a session whose key it does not have', async () => {
        // 아직 자기를 알리지 않은 세션은 봉투를 열 수 없다.
        const handlers = wiring({ findTrackedSession: () => ({ pid: 1 }) })!;
        expect(await handlers.confirmSessionHost({
            machineId: 'm-1', sessionId: 'sess-1', actorUserId: 'u-actor',
        })).toEqual({ kind: 'not-hosting', reason: 'session-not-here' });
    });

    it('confirms a session it is holding', async () => {
        expect(await wiring()!.confirmSessionHost({
            machineId: 'm-1', sessionId: 'sess-1', actorUserId: 'u-actor',
        })).toEqual({ kind: 'hosting' });
    });

    it('answers a settled delivery as a duplicate without repeating it', async () => {
        const posted: { url: string; body: MessagesBody }[] = [];
        expect(await wiring({ post: ackingPost(posted) })!.deliver(deliverParams()))
            .toEqual({ kind: 'accepted' });
        expect(await wiring({ post: ackingPost(posted) })!.deliver(deliverParams()))
            .toEqual({ kind: 'accepted', duplicate: true });
        expect(posted).toHaveLength(1);
    });
});

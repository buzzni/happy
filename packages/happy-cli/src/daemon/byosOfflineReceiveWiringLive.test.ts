/**
 * The delivery, against a **real Happy server**.
 *
 * Everything else in this feature's tests stops at a double: an `axios.post`
 * that answers the way the contract says the server would. This one does not —
 * it authenticates for real, creates a real session, hands the adapter the real
 * origin, and then reads the message back out of the server's own store.
 *
 * That is the only way to know two things a double cannot tell us: that the
 * server's message route **accepts the body this adapter builds**, and that
 * what it stores decrypts into something a session would read as user input.
 *
 * Run it with a server already listening:
 *
 *     cd vendor/happy/packages/happy-server
 *     DB_PROVIDER=pglite HANDY_MASTER_SECRET=<any> PORT=3115 \
 *       DATA_DIR=<tmp> PGLITE_DIR=<tmp>/pglite \
 *       ./node_modules/.bin/tsx ./sources/standalone.ts migrate
 *     …same env… ./sources/standalone.ts serve
 *
 *     cd ../happy-cli
 *     BYOS_HAPPY_SERVER_URL=http://127.0.0.1:3115 \
 *       ./node_modules/.bin/vitest run src/daemon/byosOfflineReceiveWiring.integration
 *
 * Without `BYOS_HAPPY_SERVER_URL` it skips: a green run that silently tested
 * nothing would be worse than no test.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import axios from 'axios';

import {
    authChallenge,
    decodeBase64,
    decrypt,
    encodeBase64,
    encrypt,
    getRandomBytes,
} from '@/api/encryption';
import { UserMessageSchema } from '@/api/types';

import { createByosOfflineReceiveWiring } from './byosOfflineReceiveWiring';

const serverUrl = process.env.BYOS_HAPPY_SERVER_URL;
const suite = serverUrl ? describe : describe.skip;
if (!serverUrl) console.warn('[byos wiring] BYOS_HAPPY_SERVER_URL 미설정 — skip.');

/** The session key. A legacy-variant session stores opaque bytes, so this is ours. */
const KEY = getRandomBytes(32);
const TEXT = 'delivered while the browser was closed';
const WEB_BODY = { t: 'user-text', text: TEXT };
const CIPHERTEXT = encodeBase64(encrypt(KEY, 'legacy', WEB_BODY));

let token: string;
let sessionId: string;
let home: string;
/** Stands in for the parent: authorizes, and records what it was asked. */
let parentAsked: Record<string, unknown>[] = [];

suite('one BYOS delivery, through a real Happy server', () => {
    beforeAll(async () => {
        home = mkdtempSync(join(tmpdir(), 'byos-live-'));

        // 실제 계정 인증 — CLI 가 쓰는 그 challenge/서명 경로다.
        const { challenge, publicKey, signature } = authChallenge(getRandomBytes(32));
        const auth = await axios.post(`${serverUrl}/v1/auth`, {
            challenge: encodeBase64(challenge),
            publicKey: encodeBase64(publicKey),
            signature: encodeBase64(signature),
        });
        token = auth.data.token as string;
        expect(typeof token).toBe('string');

        // 실제 세션 — 이후 메시지는 이 세션의 것으로만 기록된다.
        const created = await axios.post(`${serverUrl}/v1/sessions`, {
            tag: `byos-live-${randomUUID()}`,
            metadata: encodeBase64(encrypt(KEY, 'legacy', { path: home, host: 'byos-live' })),
            agentState: null,
            dataEncryptionKey: null,
        }, { headers: { Authorization: `Bearer ${token}` } });
        sessionId = created.data.session.id as string;
        expect(typeof sessionId).toBe('string');
    });

    afterAll(() => rmSync(home, { recursive: true, force: true }));

    const wiring = () => createByosOfflineReceiveWiring({
        machineId: 'm-live',
        happyHomeDir: home,
        serverUrl: serverUrl as string,
        readAccountToken: () => token,
        // 부모는 대역이지만 origin 은 설정에서만 온다는 규칙은 그대로다.
        parentConfigUrl: 'http://127.0.0.1:65535/api/me/mcp-config',
        findTrackedSession: () => ({
            happySessionId: sessionId,
            directory: home,
            pid: 4242,
            encryption: { encryptionKey: KEY, encryptionVariant: 'legacy' },
        }),
        fetch: async (_input, init) => {
            // 부모가 실제로 무엇을 받는지 본다 — body 는 이 어댑터가 만든 것이다.
            const body = typeof init?.body === 'string' ? init.body : '';
            parentAsked.push(JSON.parse(body) as Record<string, unknown>);
            return new Response(JSON.stringify({ kind: 'authorized' }), { status: 200 });
        },
        // 이 세션을 실행할 자식은 없다 — 전달 자체가 여기서 볼 것이다.
        ensureSessionRunning: async () => ({ ok: true }),
    });

    const request = (over: Record<string, unknown> = {}) => ({
        actorUserId: 'u-live',
        requestKey: `req-live-${randomUUID()}`,
        claimId: 'claim-live',
        projectId: 'p-live',
        sessionId,
        machineId: 'm-live',
        bindingVersion: 1,
        ciphertextDigest: createHash('sha256').update(CIPHERTEXT).digest('hex'),
        payloadCiphertext: CIPHERTEXT,
        ...over,
    });

    const readMessages = async (): Promise<{ localId: string | null; content: unknown }[]> => {
        const response = await axios.get(
            `${serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
            { headers: { Authorization: `Bearer ${token}` }, params: { limit: 50 } },
        );
        return (response.data.messages ?? []) as { localId: string | null; content: unknown }[];
    };

    it('lands in the session, in the shape a session reads as user input', async () => {
        parentAsked = [];
        const params = request();
        expect(await wiring()!.deliver(params)).toEqual({ kind: 'accepted' });

        // 부모에게는 판정에 필요한 것만 갔고, 봉인된 본문은 가지 않았다.
        expect(parentAsked).toHaveLength(1);
        expect(parentAsked[0].requestKey).toBe(params.requestKey);
        expect(JSON.stringify(parentAsked[0])).not.toContain(CIPHERTEXT);

        /*
         * **서버가 실제로 보관한 것**을 읽는다. 여기가 double 로는 알 수 없는
         * 지점이다: 이 본문을 그 라우트가 받아 주는가, 그리고 보관된 바이트가
         * 세션이 사용자 입력으로 읽는 모양인가.
         */
        const stored = await readMessages();
        expect(stored.length).toBeGreaterThan(0);
        const encryptedContents = stored
            .map((row) => row.content as { t?: string; c?: string })
            .filter((content) => content?.t === 'encrypted' && typeof content.c === 'string');
        const decoded = encryptedContents
            .map((content) => decrypt(KEY, 'legacy', decodeBase64(content.c as string)))
            .filter((value) => value !== null);
        const users = decoded
            .map((value) => UserMessageSchema.safeParse(value))
            .filter((parsed) => parsed.success);
        expect(users).toHaveLength(1);
        expect(users[0].success && users[0].data.content.text).toBe(TEXT);
        expect(users[0].success && users[0].data.meta?.sentFrom).toBe('daemon');
    });

    it('does not write a second copy when the same request comes back', async () => {
        parentAsked = [];
        const params = request();
        const before = (await readMessages()).length;
        expect(await wiring()!.deliver(params)).toEqual({ kind: 'accepted' });
        // 한 건이 **늘었다**: 전달이 실제로 일어났다는 뜻이다.
        expect((await readMessages()).length).toBe(before + 1);

        expect(await wiring()!.deliver(params)).toEqual({ kind: 'accepted', duplicate: true });
        expect((await readMessages()).length).toBe(before + 1);
        /*
         * 두 번째도 부모에게는 **묻는다.** 인가는 매 시도마다 지금의 권위로
         * 다시 받아야 하고(그 사이 자격이 회수됐을 수 있다), 중복 판정은 그
         * 뒤에 온다. 아끼는 것은 왕복이 아니라 **부수효과**다.
         */
        expect(parentAsked).toHaveLength(2);
    });

    it('holds, and writes nothing anywhere, when the session is not this server\'s', async () => {
        /*
         * 서버가 이 세션을 모르면 메시지는 기록되지 않는다. 그 답을 승인으로
         * 읽으면 실행된 적 없는 요청이 닫힌다.
         */
        const handlers = createByosOfflineReceiveWiring({
            machineId: 'm-live',
            happyHomeDir: home,
            serverUrl: serverUrl as string,
            readAccountToken: () => token,
            parentConfigUrl: 'http://127.0.0.1:65535/api/me/mcp-config',
            findTrackedSession: () => ({
                happySessionId: 'session-that-does-not-exist',
                directory: home,
                pid: 4242,
                encryption: { encryptionKey: KEY, encryptionVariant: 'legacy' },
            }),
            fetch: async () => new Response(
                JSON.stringify({ kind: 'authorized' }), { status: 200 },
            ),
            ensureSessionRunning: async () => ({ ok: true }),
        })!;
        const knownBefore = (await readMessages()).length;
        const outcome = await handlers.deliver(request({
            sessionId: 'session-that-does-not-exist',
            requestKey: `req-live-${randomUUID()}`,
        }));
        expect(outcome).toEqual({ kind: 'unknown', reason: 'message-post-failed' });
        /*
         * 그 세션에 못 쓴 것만으로는 "아무 데도 안 썼다" 가 아니다 — 알고 있는
         * 세션의 메시지 수가 그대로여야 그 말이 성립한다.
         */
        expect((await readMessages()).length).toBe(knownBefore);
    });
});

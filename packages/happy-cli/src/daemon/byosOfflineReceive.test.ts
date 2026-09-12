/**
 * The receiving half, with a real store on a real filesystem.
 *
 * The parent and the session are doubles here — what is under test is which
 * facts are required before a side effect and how each failure is classified.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64, encrypt } from '@/api/encryption';

import { createByosOfflineReceiptStore } from './byosOfflineReceiptStore';
import {
    byosOfflineCiphertextDigest,
    confirmByosOfflineSessionHost,
    receiveByosOfflineDelivery,
    type ByosOfflineReceiveDeps,
} from './byosOfflineReceive';

const KEY = new Uint8Array(32).fill(7);
const SESSION = {
    encryptionKey: KEY, encryptionVariant: 'dataKey' as const, incarnation: 'pid-1',
};
const BODY = { t: 'user-text', text: 'hello from offline' };
const CIPHERTEXT = encodeBase64(encrypt(KEY, 'dataKey', BODY));

let root: string;

const request = (over: Record<string, unknown> = {}) => ({
    actorUserId: 'u-actor',
    requestKey: 'req-0001-abcdef',
    claimId: 'claim-1',
    projectId: 'p-1',
    sessionId: 'sess-1',
    machineId: 'm-1',
    bindingVersion: 4,
    ciphertextDigest: byosOfflineCiphertextDigest(CIPHERTEXT),
    payloadCiphertext: CIPHERTEXT,
    ...over,
});

const deps = (over: Partial<ByosOfflineReceiveDeps> = {}): ByosOfflineReceiveDeps => ({
    machineId: 'm-1',
    findHostedSession: () => SESSION,
    authorize: async () => ({ kind: 'authorized' }),
    submitToSession: async () => ({ ok: true }),
    store: createByosOfflineReceiptStore(root),
    ...over,
});

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'byos-receive-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('confirming that this daemon holds the session', () => {
    it('confirms a session it is holding', () => {
        expect(confirmByosOfflineSessionHost(
            { machineId: 'm-1', sessionId: 'sess-1', actorUserId: 'u-actor' },
            { machineId: 'm-1', findHostedSession: () => SESSION },
        )).toEqual({ kind: 'hosting' });
    });

    it('does not claim a session it is not holding', () => {
        expect(confirmByosOfflineSessionHost(
            { machineId: 'm-1', sessionId: 'sess-1', actorUserId: 'u-actor' },
            { machineId: 'm-1', findHostedSession: () => null },
        )).toEqual({ kind: 'not-hosting', reason: 'session-not-here' });
    });

    it('refuses a request addressed to another machine', () => {
        expect(confirmByosOfflineSessionHost(
            { machineId: 'm-2', sessionId: 'sess-1', actorUserId: 'u-actor' },
            { machineId: 'm-1', findHostedSession: () => SESSION },
        )).toEqual({ kind: 'not-hosting', reason: 'another-machine' });
    });

    it('says unknown when it cannot tell, rather than denying', () => {
        // "모르겠다" 를 "없다" 로 답하면 부모가 그 세션을 다른 곳으로 보낸다.
        expect(confirmByosOfflineSessionHost(
            { machineId: 'm-1', sessionId: 'sess-1', actorUserId: 'u-actor' },
            { machineId: 'm-1', findHostedSession: () => { throw new Error('map') } },
        )).toEqual({ kind: 'unknown', reason: 'session-lookup-failed' });
    });
});

describe('delivering', () => {
    it('delivers a request the parent authorized', async () => {
        const seen: unknown[] = [];
        const submitToSession = vi.fn(async (input: unknown) => {
            seen.push(input);
            return { ok: true as const };
        });
        expect(await receiveByosOfflineDelivery(request(), deps({ submitToSession })))
            .toEqual({ kind: 'accepted' });
        expect(seen[0]).toMatchObject({ sessionId: 'sess-1', body: BODY });
    });

    it('asks the parent before it has any effect', async () => {
        const order: string[] = [];
        await receiveByosOfflineDelivery(request(), deps({
            authorize: async () => { order.push('authorize'); return { kind: 'authorized' } },
            submitToSession: async () => { order.push('submit'); return { ok: true } },
        }));
        expect(order).toEqual(['authorize', 'submit']);
    });

    it('does not deliver what the parent refused', async () => {
        const submitToSession = vi.fn(async () => ({ ok: true as const }));
        expect(await receiveByosOfflineDelivery(request(), deps({
            authorize: async () => ({ kind: 'refused', reason: 'dispatch-claim-changed' }),
            submitToSession,
        }))).toEqual({ kind: 'refused', reason: 'dispatch-claim-changed' });
        expect(submitToSession).not.toHaveBeenCalled();
    });

    it('holds, and does not deliver, when the parent could not be asked', async () => {
        /*
         * 부모에 닿지 못한 것은 허용도 거절도 아니다. 거절로 접으면 그 행이
         * 다시 큐로 돌아가고, 허용으로 접으면 회수된 자격으로 실행된다.
         */
        const submitToSession = vi.fn(async () => ({ ok: true as const }));
        expect(await receiveByosOfflineDelivery(request(), deps({
            authorize: async () => { throw new Error('offline') },
            submitToSession,
        }))).toEqual({ kind: 'unknown', reason: 'authorization-unreachable' });
        expect(submitToSession).not.toHaveBeenCalled();
    });

    it('carries the parent\'s own hold reason', async () => {
        expect(await receiveByosOfflineDelivery(request(), deps({
            authorize: async () => ({ kind: 'unknown', reason: 'authority-unreadable' }),
        }))).toEqual({ kind: 'unknown', reason: 'authority-unreadable' });
    });

    it('refuses a body that does not match the digest it was sent with', async () => {
        // 대조 축은 **받은 바이트**다. 전선의 digest 를 그대로 쓰면 대조가 무의미하다.
        expect(await receiveByosOfflineDelivery(
            request({ ciphertextDigest: 'a'.repeat(64) }), deps(),
        )).toEqual({ kind: 'refused', reason: 'ciphertext-digest-mismatch' });
    });

    it('refuses a body sealed for some other key', async () => {
        const other = encodeBase64(encrypt(new Uint8Array(32).fill(9), 'dataKey', BODY));
        expect(await receiveByosOfflineDelivery(request({
            payloadCiphertext: other, ciphertextDigest: byosOfflineCiphertextDigest(other),
        }), deps())).toEqual({ kind: 'refused', reason: 'envelope-unopenable' });
    });

    it('leaves no record behind when the final host check refuses', async () => {
        /*
         * 기록을 먼저 쓰고 나서 호스트 검사에서 거절하면, 그 `pending` 이 남아
         * **다음 재시도마다 `in-progress`** 가 된다 — 아무 일도 일어나지 않았는데
         * 영원히 사람 손을 기다린다. 검사가 기록보다 앞서야 한다.
         */
        const store = createByosOfflineReceiptStore(root);
        const found = [SESSION, null];
        expect(await receiveByosOfflineDelivery(request(), deps({
            store, findHostedSession: () => found.shift() ?? null,
        }))).toEqual({ kind: 'refused', reason: 'session-not-here' });
        // 같은 요청이 다시 오면 처음처럼 취급돼야 한다.
        expect(await receiveByosOfflineDelivery(request(), deps({ store })))
            .toEqual({ kind: 'accepted' });
    });

    it('leaves no record behind when the session was replaced', async () => {
        const store = createByosOfflineReceiptStore(root);
        const found = [SESSION, { ...SESSION, incarnation: 'pid-2' }];
        expect(await receiveByosOfflineDelivery(request(), deps({
            store, findHostedSession: () => found.shift() ?? null,
        }))).toEqual({ kind: 'refused', reason: 'session-replaced' });
        expect(await receiveByosOfflineDelivery(request(), deps({ store })))
            .toEqual({ kind: 'accepted' });
    });

    it('refuses when the session went away while the parent was being asked', async () => {
        /*
         * 인가 왕복은 즉시가 아니다. 그 사이 세션이 끝났는데 처음에 읽어 둔
         * 것으로 보내면, 이미 없는 수신자에게 보낸 것을 전달로 보고하게 된다.
         */
        const found = [SESSION, null];
        const submitToSession = vi.fn(async () => ({ ok: true as const }));
        expect(await receiveByosOfflineDelivery(request(), deps({
            findHostedSession: () => found.shift() ?? null, submitToSession,
        }))).toEqual({ kind: 'refused', reason: 'session-not-here' });
        expect(submitToSession).not.toHaveBeenCalled();
    });

    it('refuses when the session was replaced by another incarnation', async () => {
        // 같은 id 라도 다시 살아난 세션은 다른 수신자다.
        const found = [SESSION, { ...SESSION, incarnation: 'pid-2' }];
        const submitToSession = vi.fn(async () => ({ ok: true as const }));
        expect(await receiveByosOfflineDelivery(request(), deps({
            findHostedSession: () => found.shift() ?? null, submitToSession,
        }))).toEqual({ kind: 'refused', reason: 'session-replaced' });
        expect(submitToSession).not.toHaveBeenCalled();
    });

    it('submits to the session as it is now, not the one it first read', async () => {
        const later = { ...SESSION };
        const found = [SESSION, later];
        const seen: unknown[] = [];
        await receiveByosOfflineDelivery(request(), deps({
            findHostedSession: () => found.shift() ?? later,
            submitToSession: async (input) => { seen.push(input.session); return { ok: true } },
        }));
        expect(seen[0]).toBe(later);
    });

    it('refuses a session it is not holding', async () => {
        expect(await receiveByosOfflineDelivery(request(), deps({ findHostedSession: () => null })))
            .toEqual({ kind: 'refused', reason: 'session-not-here' });
    });

    it('refuses a request addressed to another machine', async () => {
        expect(await receiveByosOfflineDelivery(request({ machineId: 'm-2' }), deps()))
            .toEqual({ kind: 'refused', reason: 'another-machine' });
    });
});

describe('what happens the second time', () => {
    it('answers a settled request as a duplicate, without repeating it', async () => {
        const store = createByosOfflineReceiptStore(root);
        const submitToSession = vi.fn(async () => ({ ok: true as const }));
        await receiveByosOfflineDelivery(request(), deps({ store, submitToSession }));
        expect(await receiveByosOfflineDelivery(request(), deps({ store, submitToSession })))
            .toEqual({ kind: 'accepted', duplicate: true });
        expect(submitToSession).toHaveBeenCalledTimes(1);
    });

    it('holds an unfinished record instead of calling it a duplicate', async () => {
        /*
         * 실행됐는지 **모르는** 상태다. `accepted, duplicate` 로 답하면 부모는
         * 도착했고 이번엔 실행 안 됐다고 읽어 그 요청을 닫아 버린다.
         */
        const store = createByosOfflineReceiptStore(root);
        await receiveByosOfflineDelivery(request(), deps({
            store, submitToSession: async () => { throw new Error('crash') },
        }));
        expect(await receiveByosOfflineDelivery(request(), deps({ store })))
            .toEqual({ kind: 'unknown', reason: 'delivery-in-progress' });
    });

    it('refuses the same key carrying different content', async () => {
        const store = createByosOfflineReceiptStore(root);
        await receiveByosOfflineDelivery(request(), deps({ store }));
        const other = encodeBase64(encrypt(KEY, 'dataKey', { t: 'user-text', text: 'other' }));
        expect(await receiveByosOfflineDelivery(request({
            payloadCiphertext: other, ciphertextDigest: byosOfflineCiphertextDigest(other),
        }), deps({ store }))).toEqual({ kind: 'refused', reason: 'request-key-conflict' });
    });

    it('records before the side effect, so a crash leaves it unknown', async () => {
        const store = createByosOfflineReceiptStore(root);
        await receiveByosOfflineDelivery(request(), deps({
            store, submitToSession: async () => { throw new Error('crash') },
        })).catch(() => undefined);
        // 새 프로세스가 같은 디렉터리를 열어도 그 기록은 남아 있다.
        expect(createByosOfflineReceiptStore(root).begin({
            actorUserId: 'u-actor', requestKey: 'req-0001-abcdef', projectId: 'p-1',
            sessionId: 'sess-1', machineId: 'm-1', bindingVersion: 4,
            ciphertextDigest: byosOfflineCiphertextDigest(CIPHERTEXT),
        })).toEqual({ kind: 'in-progress' });
    });
});

describe('when the session could not take it', () => {
    it('holds a failure the session says it could retry', async () => {
        expect(await receiveByosOfflineDelivery(request(), deps({
            submitToSession: async () => ({ ok: false, reason: 'session-busy' }),
        }))).toEqual({ kind: 'unknown', reason: 'session-busy' });
    });

    it('holds every submit failure, however final it is reported to be', async () => {
        /*
         * 제출이 시작된 뒤의 실패는 **아무 일도 없었다는 증명이 아니다.** 그리고
         * 기록이 남으므로 거절로 답해도 다음 재시도는 `in-progress` 다 — 부모만
         * 헷갈린다. 되돌리기까지 갖춘 어댑터가 생기기 전에는 구분할 이유가 없다.
         */
        expect(await receiveByosOfflineDelivery(request(), deps({
            submitToSession: async () => ({ ok: false, reason: 'session-gone' }),
        }))).toEqual({ kind: 'unknown', reason: 'session-gone' });
    });

    it('keeps the record even when the submit failed, so a retry cannot repeat it blindly',
        async () => {
            const store = createByosOfflineReceiptStore(root);
            await receiveByosOfflineDelivery(request(), deps({
                store,
                submitToSession: async () => ({ ok: false, reason: 'busy' }),
            }));
            expect(await receiveByosOfflineDelivery(request(), deps({ store })))
                .toEqual({ kind: 'unknown', reason: 'delivery-in-progress' });
        });

    it('holds when the effect happened but the receipt could not be written', async () => {
        /*
         * 되돌릴 수 없는 일이 일어났는데 그것을 적지 못했다. `accepted` 는 증거
         * 없이 닫는 것이고 `refused` 는 같은 작업을 다시 실행시킨다.
         */
        const store = createByosOfflineReceiptStore(root);
        expect(await receiveByosOfflineDelivery(request(), deps({
            store: { ...store, settle: () => ({ kind: 'unknown', detail: 'io' }) } as never,
        }))).toEqual({ kind: 'unknown', reason: 'receipt-unwritable' });
    });
});

/**
 * The durable record behind BYOS offline delivery.
 *
 * Real files in a real temp directory — what is being tested is what survives a
 * restart, and a mocked filesystem cannot answer that.
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    createByosOfflineReceiptStore,
    ensureDurableDirectory,
} from './byosOfflineReceiptStore';

let root: string;
let store: ReturnType<typeof createByosOfflineReceiptStore>;

const INTENT = {
    actorUserId: 'u-actor',
    requestKey: 'req-0001-abcdef',
    projectId: 'p-1',
    sessionId: 'sess-1',
    machineId: 'm-1',
    bindingVersion: 4,
    ciphertextDigest: 'a'.repeat(64),
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'byos-receipts-'));
    store = createByosOfflineReceiptStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('recording an offline delivery before it happens', () => {
    it('records the intent as pending the first time', () => {
        expect(store.begin(INTENT)).toEqual({ kind: 'recorded' });
    });

    it('a second visit to an unfinished record is unknown, never a duplicate', () => {
        /*
         * 부수효과가 일어났는지 **모르는** 상태다. `duplicate` 로 답하면 부모는
         * "도착했고 이번엔 실행 안 됨" 으로 읽어 그 요청을 닫아 버린다.
         */
        store.begin(INTENT);
        expect(store.begin(INTENT)).toEqual({ kind: 'in-progress' });
    });

    it('answers a settled request as a duplicate, with the receipt that proves it', () => {
        store.begin(INTENT);
        store.settle(INTENT);
        expect(store.begin(INTENT)).toMatchObject({ kind: 'settled' });
    });

    it('survives a restart: an unfinished record is still unfinished', () => {
        store.begin(INTENT);
        // 같은 디렉터리에 새 store — 프로세스가 죽었다 살아난 것과 같다.
        expect(createByosOfflineReceiptStore(root).begin(INTENT)).toEqual({ kind: 'in-progress' });
    });

    it('survives a restart: a settled record stays settled', () => {
        store.begin(INTENT);
        store.settle(INTENT);
        expect(createByosOfflineReceiptStore(root).begin(INTENT)).toMatchObject({ kind: 'settled' });
    });
});

describe('the key binds one intent and only that intent', () => {
    it.each([
        ['projectId', { projectId: 'p-2' }],
        ['sessionId', { sessionId: 'sess-2' }],
        ['machineId', { machineId: 'm-2' }],
        ['bindingVersion', { bindingVersion: 5 }],
        ['ciphertextDigest', { ciphertextDigest: 'b'.repeat(64) }],
    ])('refuses the same key carrying a different %s', (_axis, over) => {
        /*
         * 같은 키로 **다른 내용**을 밀어 넣고 부모가 그것을 "이미 처리됨" 으로
         * 읽게 되는 것이 여기서 막는 것이다. 삼키지 않고 충돌로 답한다.
         */
        store.begin(INTENT);
        expect(store.begin({ ...INTENT, ...over }))
            .toEqual({ kind: 'conflict', reason: 'request-key-conflict' });
    });

    it('keeps two actors sending the same request key apart', () => {
        store.begin(INTENT);
        expect(store.begin({ ...INTENT, actorUserId: 'u-other' })).toEqual({ kind: 'recorded' });
    });

    it('does not put the request key or the actor into the path', () => {
        store.begin({ ...INTENT, requestKey: 'req-with-..-traversal' });
        const files = readdirSync(join(root, 'receipts'));
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    });
});

describe('a record that cannot be trusted is not overwritten', () => {
    it('reports an unreadable record as unknown rather than starting over', () => {
        store.begin(INTENT);
        const file = join(root, 'receipts', readdirSync(join(root, 'receipts'))[0]!);
        writeFileSync(file, 'not json');
        expect(store.begin(INTENT)).toMatchObject({ kind: 'unknown' });
    });

    it.each([
        ['delivered with no settled time', { state: 'delivered', settledAt: null }],
        ['pending that claims a settled time', { state: 'pending', settledAt: 1 }],
    ])('reports a record that is internally inconsistent (%s) as unknown', (_name, over) => {
        /*
         * `delivered` + `settledAt: null` 은 어떤 경로로도 쓰이지 않는 조합이다.
         * 그것을 통과시키면 **정산됐다는 증거 없이** settled 로 읽혀 부모가
         * `accepted` 를 받는다 — 실행되지 않았을 수도 있는 요청에 대해서.
         */
        store.begin(INTENT);
        const file = join(root, 'receipts', readdirSync(join(root, 'receipts'))[0]!);
        writeFileSync(file, JSON.stringify({ ...INTENT, recordedAt: 1, ...over }));
        expect(store.begin(INTENT)).toMatchObject({ kind: 'unknown' });
    });

    it('reports a record whose fields do not validate as unknown', () => {
        store.begin(INTENT);
        const file = join(root, 'receipts', readdirSync(join(root, 'receipts'))[0]!);
        writeFileSync(file, JSON.stringify({ state: 'delivered' }));
        expect(store.begin(INTENT)).toMatchObject({ kind: 'unknown' });
    });

    it('refuses a request key that is not well formed instead of hashing anything', () => {
        expect(store.begin({ ...INTENT, requestKey: 'x' }))
            .toEqual({ kind: 'conflict', reason: 'request-key-malformed' });
    });
});

describe('the directories the record lives in', () => {
    /*
     * `fsync` 로 파일을 내려도, 그 파일이 든 디렉터리가 **자기 부모에 아직
     * 기록되지 않았으면** 전원이 나간 뒤 디렉터리째 없을 수 있다. 그래서 새로
     * 만든 디렉터리는 부모까지 위에서 아래로 내린다.
     *
     * 여기서 확인하는 것은 **어디에 fsync 를 거는가** 이고, 전원 손실 실험이
     * 아니다 — 그 보장은 소스의 성질이지 이 테스트가 재현한 사실이 아니다.
     */
    it('persists each newly created directory through its parent, top down', () => {
        const anchor = mkdtempSync(join(tmpdir(), 'byos-anchor-'));
        const target = join(anchor, 'store', 'receipts');
        const synced: string[] = [];
        ensureDurableDirectory(target, { fsyncDir: (dir) => synced.push(dir) });
        expect(synced).toEqual([anchor, join(anchor, 'store'), target]);
        rmSync(anchor, { recursive: true, force: true });
    });

    it('syncs nothing when the directory was already there', () => {
        const anchor = mkdtempSync(join(tmpdir(), 'byos-anchor-'));
        const synced: string[] = [];
        ensureDurableDirectory(anchor, { fsyncDir: (dir) => synced.push(dir) });
        expect(synced).toEqual([]);
        rmSync(anchor, { recursive: true, force: true });
    });

    it('refuses to create a store whose anchor does not exist', () => {
        /*
         * 없는 조상을 통째로 만들어 놓고 그 체인 전체를 내리는 것은 이 store 가
         * 소유하지 않은 경로를 손대는 일이다. 앵커는 이미 있어야 한다.
         */
        const anchor = mkdtempSync(join(tmpdir(), 'byos-anchor-'));
        expect(() => createByosOfflineReceiptStore(join(anchor, 'missing', 'store')))
            .toThrowError(/anchor/);
        rmSync(anchor, { recursive: true, force: true });
    });

    it('creates its own root under an existing anchor', () => {
        const anchor = mkdtempSync(join(tmpdir(), 'byos-anchor-'));
        const store = createByosOfflineReceiptStore(join(anchor, 'store'));
        expect(store.begin(INTENT)).toEqual({ kind: 'recorded' });
        rmSync(anchor, { recursive: true, force: true });
    });
});

describe('the temporary directory', () => {
    it('does not accumulate files across writes', () => {
        // 게시에 실패하든 성공하든 tmp 는 남지 않는다.
        store.begin(INTENT);
        store.begin(INTENT);
        store.settle(INTENT);
        expect(readdirSync(join(root, 'tmp'))).toHaveLength(0);
    });

    it('leaves what a crash left behind alone', () => {
        /*
         * 기동 시 쓸어버리면 같은 store 를 쓰는 다른 프로세스가 지금 쓴 tmp 를
         * 게시 전에 지울 수 있다. 조각은 아무 이름도 없어 판정에 쓰이지 않으므로
         * 그대로 두는 편이 안전하다 — 정리는 배타 잠금 아래에서만.
         */
        store.begin(INTENT);
        const orphan = join(root, 'tmp', 'left-behind-by-a-crash');
        writeFileSync(orphan, 'partial');
        const reopened = createByosOfflineReceiptStore(root);
        expect(readdirSync(join(root, 'tmp'))).toEqual(['left-behind-by-a-crash']);
        // 그 조각이 있어도 판정은 그대로다.
        expect(reopened.begin(INTENT)).toEqual({ kind: 'in-progress' });
    });
});

describe('settling', () => {
    it('will not settle a record that was never begun', () => {
        expect(store.settle(INTENT)).toEqual({ kind: 'unknown', detail: 'absent' });
    });

    it('will not settle a record whose intent no longer matches', () => {
        store.begin(INTENT);
        expect(store.settle({ ...INTENT, sessionId: 'sess-2' }))
            .toEqual({ kind: 'conflict', reason: 'request-key-conflict' });
    });

    it('is idempotent once settled', () => {
        store.begin(INTENT);
        expect(store.settle(INTENT)).toEqual({ kind: 'settled' });
        expect(store.settle(INTENT)).toEqual({ kind: 'settled' });
    });
});

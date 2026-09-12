/**
 * What this daemon durably remembers about BYOS offline deliveries.
 *
 * One question is being answered across restarts: **has this request already
 * had an effect?** The answer has three values and they must stay apart —
 * "never seen", "started and the outcome is unknown", "settled, and here is the
 * receipt that proves it". Collapsing the middle one into either of the others
 * is the whole failure mode: read as settled, the parent closes a request that
 * may never have run; read as unseen, the same work runs twice.
 *
 * So the record is written **before** the side effect and only marked settled
 * after one. A record that exists but is not settled therefore always means
 * "unknown", including on the first boot after a crash — a missing
 * acknowledgement is never evidence that nothing was sent.
 *
 * The key is `(actorUserId, requestKey)`, and it is **bound to one intent**.
 * The same key arriving with a different project, session, machine, binding
 * version or ciphertext is a conflict, not a repeat: answering it as a repeat
 * would let a key be reused to push different content while the parent records
 * it as already handled.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
    closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync,
    renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** What one delivery is, in full. Every field takes part in the binding. */
export type ByosOfflineIntent = {
    actorUserId: string;
    requestKey: string;
    projectId: string;
    sessionId: string;
    machineId: string;
    /** The sender's view of the binding version; `null` when it had none. */
    bindingVersion: number | null;
    /** sha256 of the sealed bytes, hex. Binds the content, not just the route. */
    ciphertextDigest: string;
};

export type ByosOfflineRecord = ByosOfflineIntent & {
    state: 'pending' | 'delivered';
    recordedAt: number;
    settledAt: number | null;
};

export type ByosOfflineBeginResult =
    /** Newly recorded as pending. The caller may now perform the side effect. */
    | { kind: 'recorded' }
    /** Recorded earlier, never settled. Whether it ran is **not known**. */
    | { kind: 'in-progress' }
    /** Settled, with the receipt that proves it. Only this may answer `accepted`. */
    | { kind: 'settled'; record: ByosOfflineRecord }
    | { kind: 'conflict'; reason: 'request-key-conflict' | 'request-key-malformed' }
    | { kind: 'unknown'; detail: string };

export type ByosOfflineSettleResult =
    | { kind: 'settled' }
    | { kind: 'conflict'; reason: 'request-key-conflict' | 'request-key-malformed' }
    | { kind: 'unknown'; detail: string };

/**
 * Both halves reach us from the network and become part of a path, so they are
 * validated and then hashed — no key content, traversal sequences included,
 * ever reaches the filesystem. The actor is part of the hash because the
 * server's uniqueness scope is `(actor, requestKey)`: two actors may
 * legitimately send the same string.
 */
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const ACTOR_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function byosOfflineReceiptFileName(
    input: { actorUserId: string; requestKey: string },
): string | null {
    if (!REQUEST_KEY_PATTERN.test(input.requestKey)) return null;
    if (!ACTOR_PATTERN.test(input.actorUserId)) return null;
    // The separator is outside both patterns, so no two pairs can collide.
    const digest = createHash('sha256')
        .update(input.actorUserId).update('/').update(input.requestKey)
        .digest('hex');
    return `${digest}.json`;
}

/** True when the stored record describes exactly this intent. */
function sameIntent(record: ByosOfflineRecord, intent: ByosOfflineIntent): boolean {
    return record.actorUserId === intent.actorUserId
        && record.requestKey === intent.requestKey
        && record.projectId === intent.projectId
        && record.sessionId === intent.sessionId
        && record.machineId === intent.machineId
        && record.bindingVersion === intent.bindingVersion
        && record.ciphertextDigest === intent.ciphertextDigest;
}

function parseRecord(value: unknown): ByosOfflineRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const text = (key: string) => typeof raw[key] === 'string' && (raw[key] as string) !== '';
    if (!text('actorUserId') || !text('requestKey') || !text('projectId')) return null;
    if (!text('sessionId') || !text('machineId') || !text('ciphertextDigest')) return null;
    if (raw.state !== 'pending' && raw.state !== 'delivered') return null;
    if (raw.bindingVersion !== null && !Number.isSafeInteger(raw.bindingVersion)) return null;
    if (!Number.isSafeInteger(raw.recordedAt)) return null;
    /*
     * 상태와 시각은 **함께만** 성립한다. `delivered` 인데 정산 시각이 없는
     * 기록은 어느 경로로도 쓰이지 않으며, 그것을 통과시키면 정산됐다는 증거
     * 없이 settled 로 읽혀 실행되지 않았을 수도 있는 요청에 `accepted` 가
     * 나간다. 판정 불가로 접어 held 로 남긴다.
     */
    if (raw.state === 'delivered' && !Number.isSafeInteger(raw.settledAt)) return null;
    if (raw.state === 'pending' && raw.settledAt !== null) return null;
    return raw as unknown as ByosOfflineRecord;
}

function fsyncDirectory(dir: string): void {
    const fd = openSync(dir, 'r');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/**
 * Creates a directory and makes its **existence** durable.
 *
 * `fsync` on a file persists the file's contents; it does not persist the
 * directory entry that names it, and it does not persist the directory itself
 * in *its* parent. A record written before a side effect is only worth
 * something if the directory holding it survives the same power loss, so every
 * level this call creates is synced from the top down.
 *
 * Only newly created levels are touched. Syncing ancestors this store does not
 * own would be reaching outside it, so the parent of the topmost created level
 * — the anchor — must already exist; it is synced once, because that is where
 * the new entry landed.
 */
export function ensureDurableDirectory(
    path: string,
    deps: { fsyncDir?: (dir: string) => void } = {},
): void {
    const fsyncDir = deps.fsyncDir ?? fsyncDirectory;
    const first = mkdirSync(path, { recursive: true, mode: 0o700 });
    // 이미 있었다면 내릴 것이 없다 — 그 존재는 이전에 내구화됐다.
    if (first === undefined) return;
    fsyncDir(dirname(first));
    let current = first;
    for (const segment of relative(first, path).split(sep).filter((part) => part !== '')) {
        fsyncDir(current);
        current = join(current, segment);
    }
    fsyncDir(current);
}

export function createByosOfflineReceiptStore(root: string, now: () => number = Date.now) {
    const receiptsDir = join(root, 'receipts');
    const tmpDir = join(root, 'tmp');

    /*
     * 앵커는 **이미 있어야 한다.** 없는 조상까지 만들어 그 체인을 통째로
     * 내리는 것은 이 store 가 소유하지 않은 경로를 손대는 일이다.
     */
    const anchor = dirname(root);
    if (!existsSync(anchor)) {
        throw new Error(`byos offline receipt store anchor does not exist: ${anchor}`);
    }

    const ensureDirs = () => {
        ensureDurableDirectory(receiptsDir);
        ensureDurableDirectory(tmpDir);
    };

    /*
     * **남은 tmp 조각은 그대로 둔다.** 이전 프로세스가 게시 전에 죽으면 조각이
     * 남지만, 그것은 아무 이름도 갖지 못한 바이트라 판정에 쓰이지 않는다.
     *
     * 기동할 때 쓸어버리고 싶어지지만 그러면 안 된다 — 같은 store 를 쓰는 다른
     * 프로세스가 지금 막 쓴 tmp 를 link/rename 하기 **전에** 지워, 그쪽의
     * 기록이나 정산을 실패시킨다. 부수효과가 두 번 일어나지는 않지만, 멀쩡한
     * 전달이 `unknown` 으로 접혀 사람 손을 기다리게 된다.
     *
     * 정리는 실제 배타 잠금(daemon writer lock) 아래에서만 안전하다.
     */

    /** Writes the whole file and forces it to disk **before** it is published. */
    const writeTmp = (value: unknown): string => {
        ensureDirs();
        const path = join(tmpDir, randomBytes(16).toString('hex'));
        const fd = openSync(path, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify(value));
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        return path;
    };

    const fsyncDir = fsyncDirectory;

    const read = (
        path: string,
    ): { kind: 'absent' } | { kind: 'ok'; record: ByosOfflineRecord } | { kind: 'unknown'; detail: string } => {
        let raw: string;
        try {
            raw = readFileSync(path, 'utf8');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            /*
             * 파일이 **없을 때만** "본 적 없다" 이다. EACCES/EIO 는 기록이 있고
             * 무언가를 말하고 있는데 못 읽는 것이므로 덮어쓰면 안 된다.
             */
            if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
            return { kind: 'unknown', detail: code ?? 'read failed' };
        }
        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(raw);
        } catch {
            return { kind: 'unknown', detail: 'not JSON' };
        }
        const record = parseRecord(parsedJson);
        return record ? { kind: 'ok', record } : { kind: 'unknown', detail: 'failed validation' };
    };

    const resolve = (intent: ByosOfflineIntent): string | null => {
        const name = byosOfflineReceiptFileName(intent);
        return name === null ? null : join(receiptsDir, name);
    };

    return {
        /** Records the intent as pending. Call **before** the side effect. */
        begin(intent: ByosOfflineIntent): ByosOfflineBeginResult {
            const path = resolve(intent);
            if (path === null) return { kind: 'conflict', reason: 'request-key-malformed' };
            const record: ByosOfflineRecord = {
                ...intent, state: 'pending', recordedAt: now(), settledAt: null,
            };
            const tmp = writeTmp(record);
            try {
                linkSync(tmp, path);
                fsyncDir(receiptsDir);
                return { kind: 'recorded' };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const existing = read(path);
                if (existing.kind !== 'ok') {
                    // 있는데 못 읽는다. 다시 만들면 그 요청이 두 번 실행된다.
                    return {
                        kind: 'unknown',
                        detail: existing.kind === 'absent' ? 'vanished' : existing.detail,
                    };
                }
                if (!sameIntent(existing.record, intent)) {
                    return { kind: 'conflict', reason: 'request-key-conflict' };
                }
                return existing.record.state === 'delivered'
                    ? { kind: 'settled', record: existing.record }
                    : { kind: 'in-progress' };
            } finally {
                try {
                    unlinkSync(tmp);
                } catch {
                    // 남은 tmp 는 다음 기동에서 정리된다. 여기서 실패를 만들지 않는다.
                }
            }
        },

        /** Marks the record settled. Only a settled record may answer `accepted`. */
        settle(intent: ByosOfflineIntent): ByosOfflineSettleResult {
            const path = resolve(intent);
            if (path === null) return { kind: 'conflict', reason: 'request-key-malformed' };
            const existing = read(path);
            if (existing.kind === 'absent') return { kind: 'unknown', detail: 'absent' };
            if (existing.kind !== 'ok') return { kind: 'unknown', detail: existing.detail };
            if (!sameIntent(existing.record, intent)) {
                return { kind: 'conflict', reason: 'request-key-conflict' };
            }
            if (existing.record.state === 'delivered') return { kind: 'settled' };
            const tmp = writeTmp({ ...existing.record, state: 'delivered', settledAt: now() });
            renameSync(tmp, path);
            fsyncDir(receiptsDir);
            return { kind: 'settled' };
        },
    };
}

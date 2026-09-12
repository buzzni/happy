/**
 * specs/managed-cloud-byos §5.36 — 세대 launch/종료의 durable 원장.
 *
 * `fencingBackend.proveGenerationStopped({belowEpoch})` 는 run/attempt 를 받지
 * 않는다. teardown 은 `Number.MAX_SAFE_INTEGER` 로 부른다 — "내가 띄운 것 중
 * 그 epoch 미만이 전부 끝났는가" 라는 질문이다. 그래서 이 원장은 **띄운 것**과
 * **끝난 것**을 둘 다 기록한다.
 *
 * 띄운 적 없는 세대는 증명할 대상이 아니다. 띄웠는데 종료 기록이 없으면
 * **모른다**(재시작 뒤에도 launch 기록이 디스크에 남으므로 그 구분이 유지된다).
 * 원장을 못 읽으면 그것도 모른다 — 비어 있다고 읽으면 아무것도 안 띄운 것처럼
 * 보여 fencing 이 통과한다.
 *
 * 파일명은 scope 의 canonical digest 다. 구분자를 쓰면 id 안의 구분자로 두 scope
 * 가 같은 이름이 된다(`a__b` + `c` 와 `a` + `b__c`).
 *
 * 쓰기는 tmp(O_EXCL, 임의 이름) → fsync → rename → 디렉터리 fsync 다. 파일만
 * fsync 하면 이름이 디스크에 없을 수 있고, rename 만 하면 내용이 없을 수 있다.
 */
import {
    closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
    readSync, readdirSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';

export type GenerationKey = {
    runId: string;
    attemptId: string;
    epoch: number;
};

export type GenerationRecord = {
    version: 1;
    runId: string;
    attemptId: string;
    epoch: number;
    launchedAt: number;
    /**
     * 정지를 **요청한** 시각. 요청과 관측 사이에서 죽으면 이 값만 남고, 그때
     * cgroup 이 없다는 사실은 "치웠다" 가 아니라 "재조정이 필요하다" 는 뜻이다.
     */
    terminationRequestedAt: number | null;
    /** cgroup 이 비었고 제거까지 성공한 시각. 없으면 아직 관측하지 못했다. */
    observedEmptyAt: number | null;
    /**
     * 이 세대의 종료를 **증명한** 관측. 없으면 아무도 관측하지 않았거나 예전
     * 기록이다 — 어느 쪽도 "native 세션이 없었다" 가 아니다.
     *
     * 구버전으로 내려가는 것은 **지원하지 않는다**: 예전 reader 는 이 key 를
     * 버리고, 바로 다음 `upsert` 가 record 를 통째로 다시 써서 관측을 지운다.
     * 이 파일의 writer 들은 전부 이 field 를 보존하지만, 예전 바이너리는 그러지
     * 않는다.
     */
    nativeObservation?: GenerationNativeObservation;
};

/**
 * What this runtime **proved** about a generation's end, and which native session
 * it named while proving it.
 *
 * Only a proven stop is recordable — `awaitGracefulStop`'s `stopped: true`, which
 * it grants only after a clean ACK, the child's own exit 0 and an empty cgroup. Its
 * refusals (`timeout`, `exit-unobserved`, `still-populated`, …) are "not proven
 * **yet**", they are retried, and freezing the first one would block the proof that
 * follows.
 */
export type GenerationNativeObservation = {
    /** When it was first proven. */
    observedAt: number;
    outcome:
        /** Proven stop, and the child reported an identity. */
        | 'clean-stopped'
        /**
         * Proven stop, and **no identity was reported**. Not "used no session":
         * an older peer predates the field and a provider need not send one, so
         * this is unknown identity, exactly like an absent observation.
         */
        | 'native-unreported'
        /** Proven stop, and two identities were claimed. Identity discarded. */
        | 'conflict';
    /** Exactly as the child spelled it; only ever set for `clean-stopped`. */
    nativeId: string | null;
    /**
     * The **proof result's** own code (`awaitGracefulStop` answers `stopped`),
     * not the child's ACK verdict. The two answer different questions and mixing
     * them would record the claim as though it were the proof.
     */
    detail: string;
};

export type GenerationNativeRefusal =
    /** No record for this key. An observation must not manufacture a launch. */
    | 'never-launched'
    | 'record-unreadable'
    /** The observation itself is not of the shape this ledger stores. */
    | 'observation-invalid'
    /** Failed before the rename: what was on disk is untouched. */
    | 'write-refused'
    /** Renamed, but the directory barrier failed: durability is not established. */
    | 'durability-unknown';

export type GenerationProof =
    | { proven: true; record: GenerationRecord }
    | {
        proven: false;
        detail:
            /** 이 supervisor 가 띄운 적이 없다. 증명할 대상이 아니다. */
            | 'never-launched'
            /** 띄웠는데 종료를 관측하지 못했다. */
            | 'termination-unknown'
            /** 정지를 요청했지만 관측 전에 끊겼다. 재조정 대상이다. */
            | 'termination-pending'
            /** 기록이 있는데 읽을 수 없다. 부재로 접지 않는다. */
            | 'record-unreadable';
    };

export type LaunchRefusal = 'already-launched' | 'already-terminated' | 'record-unreadable';

export type GenerationManifest = {
    /**
     * 세대를 띄우기 **전에** 기록한다. 같은 세대의 재기동은 거부다 — 종료된
     * 기록을 남긴 채 다시 띄우면 살아 있는 workload 가 `proven stopped` 로 보인다.
     */
    recordLaunch: (input: { key: GenerationKey; launchedAt: number }) =>
        { ok: true } | { ok: false; reason: LaunchRefusal };
    /** 정지 요청을 kill 보다 **먼저** 남긴다. */
    recordTerminationRequested: (input: { key: GenerationKey; requestedAt: number }) => void;
    recordTermination: (input: { key: GenerationKey; observedEmptyAt: number }) => void;
    proveStopped: (key: GenerationKey) => GenerationProof;
    /** 띄운 것 중 `belowEpoch` 미만이 전부 종료로 관측됐는가. */
    proveAllBelow: (belowEpoch: number) => { proven: boolean; detail: string };
    /**
     * 증명된 종료 관측을 기록한다. 없던 기록을 만들지 않는다.
     *
     * 같은 증명을 다시 기록하는 것은 값을 알아보는 일이 아니라 **내구성 장벽을
     * 다시 시도하는** 일이다: rename 은 성공했는데 디렉터리 fsync 가 실패한
     * 뒤라면 바이트는 있지만 살아남는다는 보장이 없고, 값만 보고 `ok` 라고
     * 답하면 아무것도 하지 않은 채 성공을 보고하는 것이 된다.
     */
    recordNativeObservation: (input: { key: GenerationKey; observation: GenerationNativeObservation })
        => { ok: true; stored: 'first' | 'first-conflicted' | 'duplicate-ignored' | 'conflict-kept' }
        | { ok: false; reason: GenerationNativeRefusal };
    /** 아직 종료를 관측하지 못한 세대들. 재시작 재조정이 이것으로 시작한다. */
    listOpen: () => { records: GenerationRecord[]; unreadable: number };
    /**
     * 이 원장이 가진 **모든** 기록 — 열린 것과 닫힌 것 모두.
     *
     * 이것은 launch intent 와 종료 관측의 기록이다. SDK 가 실제로 시작했다거나
     * native ACK 가 있었다거나 history 전체를 가졌다는 증거가 아니다.
     */
    listAll: () => { records: GenerationRecord[]; unreadable: number };
};

const MAX_RECORD_BYTES = 4096;
const FILE_SUFFIX = '.json';

function isSafeSegment(value: string): boolean {
    return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function assertKey(key: GenerationKey): void {
    if (!isSafeSegment(key.runId) || !isSafeSegment(key.attemptId)) {
        throw new Error('generation manifest requires safe id segments');
    }
    if (!Number.isSafeInteger(key.epoch) || key.epoch < 0) {
        throw new Error('generation manifest requires a non-negative safe epoch');
    }
}

/** scope 전체의 digest. 구분자 충돌이 원리적으로 없다. */
export function generationScopeDigest(key: GenerationKey): string {
    assertKey(key);
    return createHash('sha256')
        .update(JSON.stringify([key.runId, key.attemptId, key.epoch]))
        .digest('hex');
}

/**
 * 원장 디렉터리가 신뢰할 수 있는지 본다.
 *
 * symlink 나 타 사용자 쓰기 가능 디렉터리를 그대로 쓰면, agent 가 원장을
 * 갈아 끼워 "전부 종료됨" 을 만들어 낼 수 있다.
 */
/**
 * 조상 전체를 검사한다. leaf 만 보면 agent 소유 조상이 leaf 를 rename 해
 * 원장을 통째로 갈아끼울 수 있다(§5.6 의 같은 계약).
 *
 * 먼저 심볼릭 링크를 **해소한 뒤** 그 실제 경로의 조상을 훑는다. 시스템 경로에
 * 링크가 있는 것 자체는 위협이 아니다(예: macOS 의 `/var`) — 위협은 남이 쓸 수
 * 있는 조상이다. 다만 leaf 가 링크인 것은 거부한다: 원장이 가리키는 곳이 통째로
 * 바뀔 수 있다.
 */
function assertTrustedRoot(root: string, ownerUid: number): void {
    if (lstatSync(root).isSymbolicLink()) {
        throw new Error('generation manifest root must not be a symlink');
    }
    const resolved = realpathSync(root);
    const segments = resolved.split(sep).filter(Boolean);
    let current: string = sep;
    for (const segment of [...segments, null]) {
        if (segment !== null) current = join(current, segment);
        const stat = lstatSync(current);
        // root 소유이거나 이 프로세스 소유여야 한다. 그 밖의 사용자가 소유한
        // 조상은 그 사용자가 아래를 통째로 갈아끼울 수 있다는 뜻이다.
        if (stat.uid !== 0 && stat.uid !== ownerUid) {
            throw new Error(`generation manifest ancestor ${current} has an unexpected owner`);
        }
        if ((stat.mode & 0o022) !== 0) {
            throw new Error(`generation manifest ancestor ${current} is writable by others`);
        }
    }
    if (!lstatSync(resolved).isDirectory()) {
        throw new Error('generation manifest root must be a directory');
    }
}

/** The channel's own grammar, not a new one: shared Claude/Codex, case kept. */
const OBSERVED_NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBSERVED_DETAIL = /^[a-z-]{1,40}$/;
const OBSERVED_OUTCOMES = new Set(['clean-stopped', 'native-unreported', 'conflict']);

function validObservation(value: unknown): GenerationNativeObservation | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const observation = value as Record<string, unknown>;
    if (typeof observation.outcome !== 'string' || !OBSERVED_OUTCOMES.has(observation.outcome)) return null;
    if (!Number.isSafeInteger(observation.observedAt) || (observation.observedAt as number) <= 0) return null;
    if (typeof observation.detail !== 'string' || !OBSERVED_DETAIL.test(observation.detail)) return null;
    const nativeId = observation.nativeId;
    if (nativeId !== null) {
        // 신원은 `clean-stopped` 에만 붙는다. 보고되지 않았거나 버려진 신원이
        // 값으로 남아 있으면 그 둘의 구분이 사라진다.
        if (observation.outcome !== 'clean-stopped') return null;
        if (typeof nativeId !== 'string' || !OBSERVED_NATIVE_ID.test(nativeId)) return null;
    } else if (observation.outcome === 'clean-stopped') {
        return null;
    }
    return {
        observedAt: observation.observedAt as number,
        outcome: observation.outcome as GenerationNativeObservation['outcome'],
        nativeId: nativeId as string | null,
        detail: observation.detail,
    };
}

/** 같은 증명인가. `observedAt` 은 증명마다 새로 찍히므로 비교에서 뺀다. */
function sameObservation(a: GenerationNativeObservation, b: GenerationNativeObservation): boolean {
    // 철자까지 같아야 같은 세션이다 — 아래층은 전부 정확히 비교한다.
    return a.outcome === b.outcome && a.nativeId === b.nativeId && a.detail === b.detail;
}

function parseRecord(raw: string, key: GenerationKey): GenerationRecord | 'unreadable' {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 'unreadable';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return 'unreadable';
    if (typeof record.runId !== 'string' || typeof record.attemptId !== 'string') return 'unreadable';
    if (!Number.isSafeInteger(record.epoch) || (record.epoch as number) < 0) return 'unreadable';
    if (!Number.isSafeInteger(record.launchedAt) || (record.launchedAt as number) <= 0) return 'unreadable';
    const requested = record.terminationRequestedAt;
    if (requested !== null && requested !== undefined
        && (!Number.isSafeInteger(requested) || (requested as number) <= 0)) return 'unreadable';
    const empty = record.observedEmptyAt;
    if (empty !== null && (!Number.isSafeInteger(empty) || (empty as number) <= 0)) return 'unreadable';
    // digest 가 맞아도 내용이 다른 scope 를 가리키면 그 파일은 이 질문의 답이 아니다.
    if (record.runId !== key.runId || record.attemptId !== key.attemptId
        || record.epoch !== key.epoch) {
        return 'unreadable';
    }
    let nativeObservation: GenerationNativeObservation | undefined;
    if (record.nativeObservation !== undefined) {
        const parsedObservation = validObservation(record.nativeObservation);
        // 있는데 읽을 수 없는 field 는 없는 것이 아니다.
        if (parsedObservation === null) return 'unreadable';
        nativeObservation = parsedObservation;
    }
    return {
        version: 1,
        runId: record.runId,
        attemptId: record.attemptId,
        epoch: record.epoch as number,
        launchedAt: record.launchedAt as number,
        terminationRequestedAt: requested === null || requested === undefined
            ? null
            : (requested as number),
        observedEmptyAt: empty === null ? null : (empty as number),
        ...(nativeObservation === undefined ? {} : { nativeObservation }),
    };
}

/**
 * 기록의 파일명. id 가 안전하지 않으면 digest 계산이 **던진다** — 조작된 기록
 * 하나가 목록 전체를 예외로 끝낼 수 있었다. 그런 기록은 읽을 수 없는 기록이다.
 */
function recordFileName(record: GenerationRecord): string | null {
    if (!isSafeSegment(record.runId) || !isSafeSegment(record.attemptId)) return null;
    return `${generationScopeDigest(record)}${FILE_SUFFIX}`;
}

function parseAny(raw: string): GenerationRecord | 'unreadable' {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 'unreadable';
    }
    if (!parsed || typeof parsed !== 'object') return 'unreadable';
    const record = parsed as Record<string, unknown>;
    if (typeof record.runId !== 'string' || typeof record.attemptId !== 'string') return 'unreadable';
    if (!Number.isSafeInteger(record.epoch)) return 'unreadable';
    return parseRecord(raw, {
        runId: record.runId, attemptId: record.attemptId, epoch: record.epoch as number,
    });
}

export function createGenerationManifest(
    root: string,
    options: {
        ownerUid?: number;
        /**
         * 내용이 쓰인 **뒤에** 실패할 수 있는 두 연산.
         *
         * 주입 지점이 없으면 "rename 은 성공했는데 디렉터리 장벽이 실패한" 상태를
         * 시험할 방법이 없고, 그 상태가 바로 이 증분이 구분하려는 상태다. 기본값은
         * 실제 `fs` 이며 제품 호출부는 그대로다.
         */
        io?: { rename?: typeof renameSync; fsync?: typeof fsyncSync };
    } = {},
): GenerationManifest {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const ownerUid = options.ownerUid ?? (process.getuid?.() ?? 0);
    assertTrustedRoot(root, ownerUid);

    function pathFor(key: GenerationKey): string {
        return join(root, `${generationScopeDigest(key)}${FILE_SUFFIX}`);
    }

    function readRaw(path: string): string | null {
        let fd: number;
        try {
            fd = openSync(path, 'r');
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
            throw error;
        }
        try {
            // 열어 둔 fd 로 확인한다. 경로를 다시 보면 그 사이에 바뀔 수 있다.
            const stat = fstatSync(fd);
            if (!stat.isFile()) throw new Error('manifest entry is not a regular file');
            if (stat.uid !== ownerUid) throw new Error('manifest entry has an unexpected owner');
            // 상한을 두고 읽는다. 원장 파일 하나가 임의 크기 입력이 되지 않게.
            const buffer = Buffer.allocUnsafe(MAX_RECORD_BYTES + 1);
            // read(2) 는 요청보다 적게 줄 수 있다. 한 번 호출로 끝내지 않는다.
            let total = 0;
            for (;;) {
                const read = readSync(fd, buffer, total, buffer.length - total, total);
                if (read <= 0) break;
                total += read;
                if (total > MAX_RECORD_BYTES) return 'oversize';
            }
            return buffer.subarray(0, total).toString('utf8');
        } finally {
            closeSync(fd);
        }
    }

    function load(key: GenerationKey): GenerationRecord | null | 'unreadable' {
        let raw: string | null;
        try {
            raw = readRaw(pathFor(key));
        } catch {
            return 'unreadable';
        }
        if (raw === null) return null;
        if (raw === 'oversize') return 'unreadable';
        return parseRecord(raw, key);
    }

    const renameFile = options.io?.rename ?? renameSync;
    const syncFd = options.io?.fsync ?? fsyncSync;

    /** 디렉터리 항목을 안정 저장소에 올린다. 재시도의 장벽도 이것이다. */
    function syncDirectory(): void {
        const dir = openSync(root, 'r');
        try {
            syncFd(dir);
        } finally {
            closeSync(dir);
        }
    }

    /** tmp(O_EXCL, 임의 이름) → fsync → rename → 디렉터리 fsync. */
    function writeDurably(path: string, data: string): void {
        // 짧은 쓰기가 있을 수 있다. 다 나갈 때까지 반복한다.
        const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
        const fd = openSync(tmp, 'wx', 0o600);
        try {
            const bytes = Buffer.from(data, 'utf8');
            let written = 0;
            while (written < bytes.length) {
                written += writeSync(fd, bytes, written, bytes.length - written);
            }
            syncFd(fd);
        } finally {
            closeSync(fd);
        }
        try {
            renameFile(tmp, path);
        } catch (error) {
            try { unlinkSync(tmp); } catch { /* 정리 실패는 기록 실패가 아니다 */ }
            throw error;
        }
        /*
         * rename 은 이미 보였다. 여기서 실패하면 이전 바이트로 되돌릴 수 없고,
         * 되돌리는 척하는 것이 더 나쁘다 — 실패한 단계를 이름으로 남겨 호출부가
         * "쓰이지 않았다" 와 "쓰였는지 남는지 모른다" 를 구분하게 한다.
         */
        try {
            syncDirectory();
        } catch (error) {
            throw Object.assign(error as Error, { generationWritePhase: 'after-rename' as const });
        }
    }

    function upsert(key: GenerationKey, mutate: (existing: GenerationRecord | null) => GenerationRecord): void {
        const existing = load(key);
        // 읽지 못한 기록을 조용히 덮으면 무슨 일이 있었는지 영영 모른다.
        if (existing === 'unreadable') {
            throw new Error('generation manifest record is unreadable; refusing to overwrite it');
        }
        writeDurably(pathFor(key), JSON.stringify(mutate(existing)));
    }

    /**
     * 원장 디렉터리 한 번 훑기. 두 독자가 같은 판단을 쓰도록 여기 한 곳에 둔다.
     *
     * 항목마다 세 가지 중 하나다: 이 원장의 기록이 아니라 건너뛸 것(`skip`),
     * 있는데 읽을 수 없는 것(`unreadable`), 읽은 기록(`record`). 디렉터리 자체를
     * 읽지 못하는 것은 항목이 아니라 통째의 실패이므로 `null` 로 구분한다.
     */
    type ScannedEntry = { entry: string; outcome: 'unreadable' | GenerationRecord };

    function scanEntries(): ScannedEntry[] | null {
        let entries: string[];
        try {
            entries = readdirSync(root);
        } catch {
            return null;
        }
        return entries.flatMap((entry): ScannedEntry[] => {
            if (!entry.endsWith(FILE_SUFFIX)) return [];
            // 파일명은 내용의 digest 여야 한다. 아니면 누가 갖다 놓은 것이다.
            if (!/^[0-9a-f]{64}\.json$/.test(entry)) return [{ entry, outcome: 'unreadable' as const }];
            let raw: string | null;
            try {
                raw = readRaw(join(root, entry));
            } catch {
                return [{ entry, outcome: 'unreadable' as const }];
            }
            if (raw === null) return [];
            if (raw === 'oversize') return [{ entry, outcome: 'unreadable' as const }];
            const record = parseAny(raw);
            if (record === 'unreadable') return [{ entry, outcome: 'unreadable' as const }];
            if (recordFileName(record) !== entry) return [{ entry, outcome: 'unreadable' as const }];
            return [{ entry, outcome: record }];
        });
    }

    function listAllRecords(): { records: GenerationRecord[]; unreadable: number } {
        const scanned = scanEntries();
        // 디렉터리를 못 읽었다는 사실을 "기록이 없다" 로 내놓지 않는다.
        if (scanned === null) return { records: [], unreadable: 1 };
        const records: GenerationRecord[] = [];
        let unreadable = 0;
        for (const { outcome } of scanned) {
            if (outcome === 'unreadable') { unreadable += 1; continue; }
            records.push(outcome);
        }
        return { records, unreadable };
    }

    return {
        recordLaunch({ key, launchedAt }) {
            assertKey(key);
            const existing = load(key);
            if (existing === 'unreadable') return { ok: false, reason: 'record-unreadable' };
            // 세대는 한 번만 쓴다. 종료된 세대를 다시 띄우면 살아 있는 workload 가
            // 이전 종료 기록 덕분에 `proven stopped` 로 보인다.
            if (existing !== null) {
                return {
                    ok: false,
                    reason: existing.observedEmptyAt !== null ? 'already-terminated' : 'already-launched',
                };
            }
            writeDurably(pathFor(key), JSON.stringify({
                version: 1,
                runId: key.runId,
                attemptId: key.attemptId,
                epoch: key.epoch,
                launchedAt,
                terminationRequestedAt: null,
                observedEmptyAt: null,
            } satisfies GenerationRecord));
            return { ok: true };
        },

        recordNativeObservation({ key, observation }) {
            assertKey(key);
            const incoming = validObservation(observation);
            if (incoming === null) return { ok: false, reason: 'observation-invalid' };

            const existing = load(key);
            // 관측이 없던 기록을 만들어 내면 일어나지 않은 launch 가 생긴다.
            if (existing === null) return { ok: false, reason: 'never-launched' };
            if (existing === 'unreadable') return { ok: false, reason: 'record-unreadable' };

            const stored = existing.nativeObservation;
            const write = (
                next: GenerationNativeObservation,
                outcome: 'first' | 'first-conflicted',
            ): ReturnType<GenerationManifest['recordNativeObservation']> => {
                try {
                    writeDurably(pathFor(key), JSON.stringify({ ...existing, nativeObservation: next }));
                } catch (error) {
                    return {
                        ok: false,
                        reason: (error as { generationWritePhase?: string })?.generationWritePhase === 'after-rename'
                            ? 'durability-unknown'
                            : 'write-refused',
                    };
                }
                return { ok: true, stored: outcome };
            };

            if (stored === undefined) return write(incoming, 'first');

            /*
             * 이미 있는 관측을 다시 쓰지 않을 때에도 **장벽은 다시 시도한다**.
             * 앞선 시도가 rename 뒤 디렉터리 fsync 에서 실패했다면 바이트는 있고
             * 내구성만 없는 상태이며, 값이 같다는 이유로 `ok` 를 돌려주면 아무것도
             * 하지 않은 채 성공을 보고하게 된다. 파일이 있다는 관측은 rename 이
             * 됐다는 사실일 뿐 항목이 안정 저장소에 있다는 증거가 아니다.
             */
            const keep = (
                outcome: 'duplicate-ignored' | 'conflict-kept',
            ): ReturnType<GenerationManifest['recordNativeObservation']> => {
                try {
                    syncDirectory();
                } catch {
                    return { ok: false, reason: 'durability-unknown' };
                }
                return { ok: true, stored: outcome };
            };

            // 한 번 모순을 말한 기록은 어느 한쪽을 다시 말해도 회복되지 않는다.
            if (stored.outcome === 'conflict') return keep('conflict-kept');
            if (sameObservation(stored, incoming)) return keep('duplicate-ignored');

            /*
             * 한 세대에 대한 두 증명이 서로 다르다. 뒤의 것으로 덮으면 순서만
             * 바꿔도 결론이 바뀌므로, 신원을 버리고 모순을 남긴다. 처음 증명된
             * 시각은 그대로 둔다 — 그것이 이 사실이 처음 증명된 때다.
             */
            return write({
                observedAt: stored.observedAt,
                outcome: 'conflict',
                nativeId: null,
                detail: stored.detail,
            }, 'first-conflicted');
        },

        recordTerminationRequested({ key, requestedAt }) {
            assertKey(key);
            upsert(key, (existing) => ({
                version: 1,
                runId: key.runId,
                attemptId: key.attemptId,
                epoch: key.epoch,
                launchedAt: existing?.launchedAt ?? requestedAt,
                terminationRequestedAt: existing?.terminationRequestedAt ?? requestedAt,
                observedEmptyAt: existing?.observedEmptyAt ?? null,
                // 이 writer 들은 record 를 통째로 다시 만든다. 옮겨 싣지 않으면
                // 평범한 종료 기록 하나가 관측을 지운다.
                ...(existing?.nativeObservation === undefined
                    ? {}
                    : { nativeObservation: existing.nativeObservation }),
            }));
        },

        recordTermination({ key, observedEmptyAt }) {
            assertKey(key);
            upsert(key, (existing) => {
                // 첫 관측이 권위다. 나중 기록이 덮으면 재증명이 멱등이 아니다.
                if (existing && existing.observedEmptyAt !== null) return existing;
                return {
                    version: 1,
                    runId: key.runId,
                    attemptId: key.attemptId,
                    epoch: key.epoch,
                    launchedAt: existing?.launchedAt ?? observedEmptyAt,
                    terminationRequestedAt: existing?.terminationRequestedAt ?? null,
                    observedEmptyAt,
                    ...(existing?.nativeObservation === undefined
                        ? {}
                        : { nativeObservation: existing.nativeObservation }),
                };
            });
        },

        proveStopped(key) {
            assertKey(key);
            const record = load(key);
            if (record === null) return { proven: false, detail: 'never-launched' };
            if (record === 'unreadable') return { proven: false, detail: 'record-unreadable' };
            if (record.observedEmptyAt === null) {
                return {
                    proven: false,
                    detail: record.terminationRequestedAt !== null
                        ? 'termination-pending'
                        : 'termination-unknown',
                };
            }
            return { proven: true, record };
        },

        proveAllBelow(belowEpoch) {
            if (!Number.isSafeInteger(belowEpoch) || belowEpoch < 0) {
                return { proven: false, detail: 'invalid-epoch' };
            }
            /*
             * 여기서는 공용 scanner 를 쓰지 않는다. 이 증명은 **첫** 미관측
             * 세대에서 멈추는 것이 계약이고, 목록용 훑기는 항목을 전부 읽는다.
             * 공유하면 거절 순서는 같아 보여도 읽는 파일 수가 달라진다.
             */
            let entries: string[];
            try {
                entries = readdirSync(root);
            } catch {
                // 원장을 못 읽는 것을 "아무것도 안 띄웠다" 로 읽으면 fencing 이 뚫린다.
                return { proven: false, detail: 'manifest-unreadable' };
            }
            for (const entry of entries) {
                if (!entry.endsWith(FILE_SUFFIX)) continue;
                // 파일명은 내용의 digest 여야 한다. 아니면 누가 갖다 놓은 것이다.
                if (!/^[0-9a-f]{64}\.json$/.test(entry)) {
                    return { proven: false, detail: 'record-unreadable' };
                }
                let raw: string | null;
                try {
                    raw = readRaw(join(root, entry));
                } catch {
                    return { proven: false, detail: 'record-unreadable' };
                }
                if (raw === null) continue;
                if (raw === 'oversize') return { proven: false, detail: 'record-unreadable' };
                const record = parseAny(raw);
                if (record === 'unreadable') return { proven: false, detail: 'record-unreadable' };
                if (recordFileName(record) !== entry) {
                    return { proven: false, detail: 'record-unreadable' };
                }
                if (record.epoch >= belowEpoch) continue;
                if (record.observedEmptyAt === null) {
                    return {
                        proven: false,
                        detail: record.terminationRequestedAt !== null
                            ? 'termination-pending'
                            : 'termination-unknown',
                    };
                }
            }
            return { proven: true, detail: 'all-launched-generations-observed-empty' };
        },

        listOpen() {
            // 열린 것은 전체의 부분집합이다 — 같은 훑기, 같은 집계.
            const all = listAllRecords();
            return {
                records: all.records.filter((record) => record.observedEmptyAt === null),
                unreadable: all.unreadable,
            };
        },

        listAll: listAllRecords,
    };
}

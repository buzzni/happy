/**
 * specs/managed-cloud-byos F2 phase 2 — supervisor instance attestation 파일.
 *
 * 이 파일이 세우는 것은 **과거 한 시점**의 사실뿐이다: 그때 supervisor 인스턴스의
 * nonce·정체·소켓이 이것이었다. 지금 그 supervisor 가 살아 있는지, 그 소켓 뒤에 누가
 * 있는지는 **말하지 않는다.** 그 답은 살아 있는 왕복(`hello`)에서만 나오고, 이 파일이
 * 읽혔다는 사실은 어떤 것도 `verified` 로 만들지 않는다.
 *
 * ## 이 모듈이 증명하지 않는 것
 *
 * 발행 순간 그 runtime 이 **현재 권위였는가**는 여기서 판정하지 않는다. 그 판정은
 * 호출부(향후 supervisor runtime 의 동기 임계구역: `!stopping`, lock 보유, listen 성공)
 * 의 몫이다. 이 API 는 그 보호를 **가정할 뿐 증명하지 않으며**, 스스로도 그렇게 말하지
 * 않는다.
 *
 * ## 왜 교체 가능한가
 *
 * launcher binding 은 write-once 다(`O_EXCL` + `link`): 그 안의 boot token 은 supervisor
 * 재시작을 가로질러 재사용되는 값이라, 덮어쓰면 daemon 과 supervisor 가 서로 다른 토큰을
 * 들게 된다. 반면 instance nonce 는 **인스턴스마다 달라야** 의미가 있다. 그래서 이 기록만
 * 교체 가능하고, 교체는 원자적이어야 한다 — 반쯤 쓰인 기록을 읽은 daemon 은 살아 있는
 * runtime 을 불일치로 판정한다.
 *
 * ## 임시 이름이 고정인 이유
 *
 * 난수 이름은 실패할 때마다 조용히 쌓인다. 고정 이름은 남아 있으면 **보인다** — 그리고
 * 그때는 발행을 거절한다. 남의 임시 파일을 지우지 않는다: 그것이 살아 있는 발행의 것이면
 * 밟는 것이고, 이전 크래시의 것이면 사람이 볼 근거다.
 */
import {
    closeSync as realCloseSync,
    constants,
    fsyncSync as realFsyncSync,
    openSync as realOpenSync,
    renameSync as realRenameSync,
    unlinkSync as realUnlinkSync,
    writeSync as realWriteSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
    readRootProtectedFile,
    trustedPathRefusal,
    type ManagedProvisioningDeps,
    type ProvisioningStat,
    type ManagedIdentityRefusal,
} from '@/daemon/managedRuntimeIdentity';

export const MANAGED_SUPERVISOR_ATTESTATION_VERSION = 1;

/**
 * 읽기 전 gate 와 쓰기 전 직렬화 양쪽에 같은 값으로 적용한다.
 *
 * **유효한 모양의 기록도 이 상한을 넘을 수 있다** — `socketPath` 하나가 경로 상한까지
 * 갈 수 있기 때문이다. 넘는 것은 불가능한 일이 아니라 일어날 수 있는 결과이고,
 * 그때는 성공으로 접지 않고 거절한다.
 */
export const MAX_ATTESTATION_BYTES = 8192;

export function managedSupervisorAttestationPath(stateDir: string): string {
    return join(stateDir, 'supervisor-attestation.json');
}

/** 고정 이름. 난수 이름이 아니다 — 위 주석 참고. */
function temporaryPath(stateDir: string): string {
    return `${managedSupervisorAttestationPath(stateDir)}.tmp`;
}

export type ManagedSupervisorAttestation = {
    version: typeof MANAGED_SUPERVISOR_ATTESTATION_VERSION;
    /** 이 모듈이 발행하는 값이므로 이 모듈이 문법을 정한다. **비밀이 아니다.** */
    instanceNonce: string;
    /** 절대경로이고, canonical resolve 결과가 `stateDir` 의 **하위**여야 한다. */
    socketPath: string;
    /** marker 축 그대로: trim 후 비어 있지 않은 200자 이하의 **불투명** 문자열. */
    runtimeId: string;
    provisioningOperationId: string;
    /** marker 를 읽은 그 바이트의 digest, lowercase hex. */
    markerSha256: string;
};

export type ManagedSupervisorAttestationWriteOutcome =
    | { ok: true }
    | {
        ok: false;
        stage:
        /** 대상 디렉터리 사슬이 root 전용이 아니다. **아무것도 만들지 않았다.** */
        | 'untrusted'
        /** 스키마가 아니다. 아무것도 쓰지 않았다. */
        | 'schema'
        /** 직렬화가 상한을 넘는다. 아무것도 쓰지 않았다. */
        | 'too-large'
        /** 고정 임시 이름이 이미 있다. 남의 것을 지우지 않고 거절한다. */
        | 'temporary-exists'
        /** tmp 생성/쓰기/fsync 실패. **이전 파일 그대로.** */
        | 'staged'
        /** rename 실패. **이전 파일 그대로.** */
        | 'promote'
        /**
         * rename 은 성공했고 디렉터리 fsync 가 실패했다. **새 파일은 이미 보인다**
         * — 크래시 뒤에도 남을지는 모른다. 되돌리지도, 성공으로 접지도 않는다.
         */
        | 'durability-unknown';
    };

export type ManagedSupervisorAttestationReadOutcome =
    | { ok: true; attestation: ManagedSupervisorAttestation }
    /**
     * `absent` 는 **모른다**는 뜻이다.
     *
     * 아직 아무 인스턴스도 발행하지 않아서일 수도 있고, 발행된 기록이 지워져서일
     * 수도 있다. 이 둘을 파일 부재로 가를 방법이 없으므로, "아무도 발행하지
     * 않았다"는 증거로 읽지 않는다. 훼손과는 구분한다.
     */
    | { ok: false; reason: 'absent' | 'untrusted' | 'unusable' };

/** 주입되는 것은 **I/O 뿐**이다. 판정은 어느 경우에도 아래 코드가 한다. */
export type ManagedSupervisorAttestationWriteDeps = {
    openSync: (path: string, flags: number, mode?: number) => number;
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => number;
    fsyncSync: (fd: number) => void;
    closeSync: (fd: number) => void;
    renameSync: (from: string, to: string) => void;
    unlinkSync: (path: string) => void;
};

const defaultWriteDeps: ManagedSupervisorAttestationWriteDeps = {
    openSync: realOpenSync,
    writeSync: realWriteSync,
    fsyncSync: realFsyncSync,
    closeSync: realCloseSync,
    renameSync: realRenameSync,
    unlinkSync: realUnlinkSync,
};

/**
 * 정확히 `0600` 인 root 소유 정규 파일만.
 *
 * 공용 `assertProvisioningStat` 은 group/other **쓰기** 비트만 보므로 `0640`·`0644` 도
 * 통과시킨다. 이 기록은 그룹 독자를 아직 갖지 않기로 한 파일이라 그 gate 를 쓸 수 없다.
 */
function exactlyRootOwned0600(
    stat: ProvisioningStat,
): { reason: ManagedIdentityRefusal } | null {
    if (!stat.isFile) return { reason: 'not-a-regular-file' };
    if (stat.uid !== 0) return { reason: 'not-root-owned' };
    if ((stat.mode & 0o777) !== 0o600) return { reason: 'world-or-group-writable' };
    if (stat.size > MAX_ATTESTATION_BYTES) return { reason: 'too-large' };
    return null;
}

/**
 * 같은 규칙을 reader 와 writer 가 함께 쓴다.
 *
 * `managedLauncherBinding` 에 같은 세 줄이 있지만 그것은 private 이고, 이 증분은 기존
 * 파일을 수정하지 않는다. 두 번째 사본이며 세 번째가 생기면 그때 공통화한다.
 */
function isInsideDirectory(directory: string, target: string): boolean {
    const root = resolve(directory);
    const path = resolve(target);
    return path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep);
}

const NONCE_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;
const DIGEST_SHAPE = /^[a-f0-9]{64}$/;

/** marker 축과 같은 규칙(`readString`): trim 후 비어 있지 않고 200자 이하. */
function opaqueId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 200 ? trimmed : null;
}

/**
 * 하나의 문법, 두 방향.
 *
 * 쓰기가 읽기보다 느슨하면 자기가 읽지 못할 기록을 남기고, 반대면 자기가 쓴 것을
 * 거절한다. 그래서 같은 함수를 지난다.
 */
function parseAttestation(
    value: unknown,
    stateDir: string,
): ManagedSupervisorAttestation | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const known = [
        'version', 'instanceNonce', 'socketPath',
        'runtimeId', 'provisioningOperationId', 'markerSha256',
    ];
    // 모르는 키가 있으면 거절한다. 읽지 않은 내용을 담은 기록을 읽었다고 하지 않는다.
    if (Object.keys(record).some((key) => !known.includes(key))) return null;
    if (record.version !== MANAGED_SUPERVISOR_ATTESTATION_VERSION) return null;

    const instanceNonce = typeof record.instanceNonce === 'string' ? record.instanceNonce : '';
    if (!NONCE_SHAPE.test(instanceNonce)) return null;
    const markerSha256 = typeof record.markerSha256 === 'string' ? record.markerSha256 : '';
    if (!DIGEST_SHAPE.test(markerSha256)) return null;

    const runtimeId = opaqueId(record.runtimeId);
    const provisioningOperationId = opaqueId(record.provisioningOperationId);
    if (!runtimeId || !provisioningOperationId) return null;

    /*
     * **파일시스템 경로는 trim 하지 않는다.** 끝에 공백이 있는 이름은 정당한
     * 이름이고, 다듬는 순간 기록된 것과 다른 파일을 가리키게 된다. 그리고
     * canonical 이어야 한다: `a/../b` 는 담고 있는 사실이 `b` 와 같지만 문자열로는
     * 다르므로, 그대로 두면 같은 소켓이 두 표기로 기록되고 비교가 갈린다.
     */
    const socketPath = typeof record.socketPath === 'string' ? record.socketPath : '';
    if (socketPath === '' || !isAbsolute(socketPath)) return null;
    /*
     * NUL 이 박힌 문자열은 **OS 경로가 될 수 없다**. JSON 은 그것을 실어 나를 수
     * 있으므로 여기서 막지 않으면 기록과 판독은 통과하고 그 값을 실제로 쓰려는
     * 쪽에서야 터진다. 넓은 유니코드 규칙을 만들지 않는다 — 막는 것은 이 한 축이다.
     */
    if (socketPath.includes('\0')) return null;
    if (resolve(socketPath) !== socketPath) return null;
    if (!isInsideDirectory(stateDir, socketPath)) return null;

    return {
        version: MANAGED_SUPERVISOR_ATTESTATION_VERSION,
        instanceNonce,
        socketPath,
        runtimeId,
        provisioningOperationId,
        markerSha256,
    };
}

/**
 * 동기 발행. `tmp(O_EXCL,0600) → write → fsync → rename → 디렉터리 fsync`.
 *
 * 전부 동기인 것이 계약이다: 호출부의 임계구역에 `await` 이 하나도 없어야, 멈추는 중인
 * 옛 인스턴스가 새 인스턴스의 기록을 뒤늦게 덮는 일이 구조적으로 생기지 않는다.
 */
export function writeManagedSupervisorAttestation(input: {
    stateDir: string;
    record: ManagedSupervisorAttestation;
    /** 조상 신뢰 판정에 쓴다. 판독과 **같은 규칙**이다. */
    provisioning: ManagedProvisioningDeps;
    deps?: ManagedSupervisorAttestationWriteDeps;
}): ManagedSupervisorAttestationWriteOutcome {
    const deps = input.deps ?? defaultWriteDeps;
    const parsed = parseAttestation(input.record, input.stateDir);
    if (!parsed) return { ok: false, stage: 'schema' };

    /*
     * **쓰기 전에** 조상을 건다. 판독에서만 거절하면 늦다: 그때는 root 가 이미
     * 남의 디렉터리에 파일을 만든 뒤이고, 그 임시 이름의 소유권도 이쪽이 아니다.
     * 상대 경로와 `stateDir` 밖은 여기서 끝난다.
     */
    const path = managedSupervisorAttestationPath(input.stateDir);
    if (!isAbsolute(input.stateDir)
        || !isInsideDirectory(input.stateDir, path)
        || trustedPathRefusal(dirname(resolve(path)), 0, 'not-root-owned', input.provisioning)) {
        return { ok: false, stage: 'untrusted' };
    }

    const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
    if (bytes.byteLength > MAX_ATTESTATION_BYTES) return { ok: false, stage: 'too-large' };

    const temporary = temporaryPath(input.stateDir);

    // **이 호출이 만든 tmp 만** 정리한다. 남의 것은 건드리지 않는다.
    let created = false;
    let staged = false;
    let fd: number | null = null;
    try {
        try {
            fd = deps.openSync(
                temporary,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
                0o600,
            );
            created = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                // 남아 있는 것은 다른 호출이나 이전 크래시의 것이다. 지우지 않는다.
                return { ok: false, stage: 'temporary-exists' };
            }
            return { ok: false, stage: 'staged' };
        }
        // 짧은 쓰기가 있을 수 있다. 다 나갈 때까지 반복한다.
        let written = 0;
        while (written < bytes.byteLength) {
            const progress = deps.writeSync(fd, bytes, written, bytes.byteLength - written);
            /*
             * 진행이 없으면 **멈춘다.** 이 함수는 동기 임계구역에서 불리므로,
             * 0 을 계속 돌려주는 descriptor 를 만나면 루프가 프로세스를 잡는다.
             */
            if (!(progress > 0)) throw new Error('no progress');
            written += progress;
        }
        deps.fsyncSync(fd);
        staged = true;
    } catch {
        // 아래에서 거둔다.
    } finally {
        if (fd !== null) {
            try { deps.closeSync(fd); } catch { /* 닫기 실패는 여기서 끝난다 */ }
        }
    }
    /*
     * 여기서부터의 정리는 **이 호출이 만든 tmp** 에 한정된다(`created`). 아직
     * promote 되지 않았으므로 그 이름은 이 호출의 것이다.
     */
    if (!staged) {
        if (created) {
            try { deps.unlinkSync(temporary); } catch { /* 만들다 만 것이 없을 수도 있다 */ }
        }
        return { ok: false, stage: 'staged' };
    }

    try {
        deps.renameSync(temporary, path);
    } catch {
        if (created) {
            try { deps.unlinkSync(temporary); } catch { /* 이미 사라졌을 수 있다 */ }
        }
        // **이전 파일 그대로다.**
        return { ok: false, stage: 'promote' };
    }

    /*
     * 디렉터리 항목까지 내려야 크래시 뒤에도 남는다. 여기서 실패하면 **새 파일은 이미
     * 보이고** 있으며, 되돌릴 이전 바이트는 없다. 모르는 것을 모른다고 남긴다.
     */
    let dir: number | null = null;
    try {
        dir = deps.openSync(dirname(path), constants.O_RDONLY);
        deps.fsyncSync(dir);
    } catch {
        return { ok: false, stage: 'durability-unknown' };
    } finally {
        if (dir !== null) {
            try { deps.closeSync(dir); } catch { /* 닫기 실패는 여기서 끝난다 */ }
        }
    }
    return { ok: true };
}

/**
 * 판독. 조상 경로는 **root 전용**으로 걷고, 파일은 정확히 `0600` 이어야 한다.
 *
 * 사유에 경로·nonce 를 싣지 않는다: 이 값은 로그와 RPC 응답으로 흘러간다.
 */
export function readManagedSupervisorAttestation(input: {
    stateDir: string;
    deps: ManagedProvisioningDeps;
}): ManagedSupervisorAttestationReadOutcome {
    /*
     * 상대 `stateDir` 은 **아무것도 건드리기 전에** 거절한다. `resolve` 는 그것을
     * 프로세스의 cwd 기준으로 펴므로, 그대로 두면 이 reader 가 호출자의 현재
     * 디렉터리에 따라 다른 파일을 연다. 쓰기와 같은 계약이다.
     */
    if (!isAbsolute(input.stateDir)) return { ok: false, reason: 'untrusted' };
    const path = managedSupervisorAttestationPath(input.stateDir);
    // 열기 전에 조상부터. 디렉터리를 쓸 수 있는 주체는 이 파일을 고를 수 있다.
    if (trustedPathRefusal(dirname(resolve(path)), 0, 'not-root-owned', input.deps)) {
        return { ok: false, reason: 'untrusted' };
    }
    // 정책은 **언제나** 이것이다. 호출자가 gate 를 고를 수 있으면 이 파일의 계약이
    // 호출자 마음이 된다.
    const file = readRootProtectedFile(path, exactlyRootOwned0600);
    if (file.kind === 'absent') return { ok: false, reason: 'absent' };
    if (file.kind === 'refused') {
        /*
         * 크기 초과는 **신뢰 문제가 아니라 쓸 수 없는 기록**이다 — 소유자·모드는
         * 맞는데 이 reader 가 다루기로 한 한계를 넘은 것이다. 그 둘을 한 코드로
         * 접으면 "누가 건드렸다" 와 "너무 크다" 가 구분되지 않는다.
         */
        return { ok: false, reason: file.reason === 'too-large' ? 'unusable' : 'untrusted' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(file.content);
    } catch {
        return { ok: false, reason: 'unusable' };
    }
    const attestation = parseAttestation(parsed, input.stateDir);
    if (!attestation) return { ok: false, reason: 'unusable' };
    return { ok: true, attestation };
}

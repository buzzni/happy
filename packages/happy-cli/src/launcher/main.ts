/**
 * specs/managed-cloud-byos §5.36 — supervisor 진입점.
 *
 * root 로 돌며 세 가지를 계속 소유한다: IPC 응답, lease watchdog tick, 그리고
 * durable 원장. **daemon 의 생사와 무관하게** 돈다 — daemon 을 죽이는 것이
 * lease 무한 연장이 되면 안 된다.
 *
 * 이 프로세스는 세대 cgroup 에 들어가지 않는다.
 */
import { logger } from '@/ui/logger';
import {
    createManagedProviderQuiescenceGate,
    endInputForLiveGenerations,
    type GenerationTerminalObservation,
    type ProviderQuiescenceGate,
} from '@/managed/checkpoint/managedProviderQuiescence';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';

import { parseManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';
import {
    parseManagedCheckpointTargetEnvelope,
    wireStateForAcceptance,
    type ManagedCheckpointReceipt,
    type ManagedCheckpointTargetAcceptance,
    type ManagedCheckpointTargetDelivery,
} from '@/managed/checkpoint/managedCheckpointTargetInbox';
import {
    MANAGED_REPORT_CHILD_FD,
    parseManagedReportCredential,
} from '@/daemon/launch/managedReportCredential';
import {
    assertDistinctManagedFds,
    MANAGED_CONTROL_CHILD_FD,
} from '@/managed/managedControlChannel';
import {
    createManagedGenerationLauncher,
    sameManagedOrigin,
    type ManagedGenerationLaunchConfig,
    type ManagedGenerationLauncher,
    type ManagedGenerationPrepared,
} from './managedGenerationLaunch';

import {
    createGenerationManifest,
    type GenerationKey,
    type GenerationNativeObservation,
} from './generationManifest';
import { MANAGED_GRANT_PARAMS_MAX_BYTES, createIpcServer, type SupervisorHello } from './ipcServer';
import {
    MANAGED_SUPERVISOR_ATTESTATION_VERSION,
    writeManagedSupervisorAttestation,
    type ManagedSupervisorAttestationWriteOutcome,
} from '@/managed/managedSupervisorAttestation';
import {
    defaultProvisioningDeps,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';

/**
 * What a publication attempt answers.
 *
 * The write half is **derived from the writer's own stage union**, not a copy
 * of it: a stage added there is a compile error here rather than a silent gap.
 */
export type ManagedSupervisorPublishOutcome =
    | 'published'
    | 'refused-not-current'
    | 'refused-no-scope'
    | `refused-write:${Extract<ManagedSupervisorAttestationWriteOutcome, { ok: false }>['stage']}`;
import {
    acquireSupervisorLock,
    createLeaseWatchdog,
    createSupervisor,
    defaultSupervisorDeps,
    type LaunchHandle,
    type SupervisorConfig,
} from './supervisor';

export type SupervisorRuntimeOptions = {
    config: SupervisorConfig;
    manifestRoot: string;
    /** root 소유 스테이징 디렉터리. bootstrap 봉투가 잠깐 여기 놓인다. */
    stagingRoot: string;
    socketPath: string;
    watchdogIntervalMs: number;
    /** 준비 뒤 놓아주지 않으면 자동으로 접는다. */
    releaseDeadlineMs: number;
    /** 배타 잠금 이름. 두 supervisor 가 같은 원장을 쓰지 못하게 한다. */
    runtimeId: string;
    /**
     * What this runtime needs to attest to being the instance on this socket.
     *
     * **Optional, and one object rather than loose fields.** This factory has
     * consumers outside managed mode; requiring a marker digest from them would
     * have them invent an identity to satisfy a type, and half-supplied axes
     * would be a record with a hole in it. Absent, `publishAttestation()`
     * refuses with `refused-no-scope` and writes nothing.
     *
     * The managed boot always supplies it — that path is typed end to end.
     */
    attestation?: {
        stateDir: string;
        provisioningOperationId: string;
        /** The digest of the bytes the marker was parsed from, handed down. */
        markerSha256: string;
        /** Ancestry is judged live, at publish time, by the writer's own rule. */
        provisioning?: ManagedProvisioningDeps;
    };
    /**
     * 잠금 획득. 기본은 Linux 추상 소켓이며 운영에서는 그것만 쓴다.
     * Root boot also uses this to take the exact lock held since before credential adoption.
     * Generic runtimes acquire their own lock; fixtures may replace the observation.
     */
    acquireLock?: (input: { runtimeId: string; manifestRoot: string; cgroupRoot: string }) => Promise<
        { ok: true; release: () => Promise<void> } | { ok: false; reason: string }
    >;
    /** Stop new ticks and await local checkpoint work; a timeout is not permission to release ownership. */
    stopCheckpointWork?: () => Promise<{ pendingPublication: boolean }>;
    /** helper 에게 상속시킬 bootstrap fd 번호. */
    bootstrapFd?: number;
    /** daemon 이 속한 신뢰 그룹. 소켓의 group 을 여기로 옮긴다. */
    daemonGid?: number;
    /**
     * 부모가 발급한 checkpoint target 의 도착지.
     *
     * RPC 는 daemon 이 받지만 inbox 는 **이 프로세스**에 있다 — checkpoint runner
     * 가 tool session 과 같은 drain 객체를 공유해야 하고, 두 프로세스는 메모리를
     * 공유하지 않는다. 없으면 이 runtime 은 checkpoint 를 하지 않으며, 그렇게
     * 답한다(받아 두고 아무도 쓰지 않으면 발급된 자격이 조용히 만료된다).
     */
    /**
     * Hands a parsed delivery to the runtime's checkpoint inbox.
     *
     * The answer matters: two of its states mean no archive will start from
     * this delivery, and the parent must be told which one so it knows whether
     * to ask again. A `void` here would have made both look like acceptance.
     */
    acceptCheckpointTarget?: (
        target: ManagedCheckpointTargetDelivery,
        receipt: ManagedCheckpointReceipt,
    ) => ManagedCheckpointTargetAcceptance | void;
    /**
     * Establishes that the parent issued this target, using the boot marker.
     *
     * **Required for any acceptance.** A supervisor composed without it has
     * nothing to check a relayed document against, and queueing one anyway
     * would put an unauthenticated set of upload destinations in front of a
     * checkpoint while every log read as wired.
     */
    authenticateCheckpointTarget?: (input: {
        rawParams: Record<string, unknown>;
        dispatchToken: string;
        checkpointId: string;
    }) => { ok: true; receipt: ManagedCheckpointReceipt } | { ok: false; reason: string };
    /**
     * Records the parent's runtime-lease statement, using the boot marker.
     *
     * **Required for any admission.** A supervisor composed without it has no
     * way to establish who issued a grant, and answering anything but a refusal
     * would let the daemon ACK a lease nothing observed.
     */
    admitRuntimeGrant?: (input: {
        rawParams: Record<string, unknown>;
        dispatchToken: string;
    }) => { ok: true } | { ok: false; reason: string };
    /**
     * Drops the runtime grant snapshot when this supervisor stops speaking for
     * the runtime.
     *
     * Called **after** the IPC drain and after the lock is released, and only
     * on a stop that proved itself. Earlier would be undone by a handler the
     * drain is still waiting for; on an unproven stop the lock is kept, so the
     * record of what this supervisor was told is kept with it.
     */
    clearRuntimeGrant?: () => void;
    token?: string;
    /**
     * managed 실행 설정. **없으면 `prepare-launch` 는 거부한다.**
     *
     * 이것 없이 park 하면 runtime 의 고정 workload 를 고정 환경으로 띄우게 된다 —
     * broker 도, provider plan 도, 별도 executor uid 도 없이. managed run 처럼
     * 보이는데 아닌 것보다 안 띄우는 편이 낫다.
     *
     * `createProviderSupervisor` 는 여기서 채운다: run 마다 config 는 다르되
     * **원장과 watchdog 은 runtime 의 것 하나**를 공유해야 한다.
     */
    managedRun?: Omit<ManagedGenerationLaunchConfig, 'createProviderSupervisor'>;
};

/**
 * bootstrap 봉투를 root 소유 디렉터리에 잠깐 놓고 **읽기 전용으로 연 뒤 곧바로
 * 지운다.**
 *
 * 경로가 사라지므로 agent 가 다시 열 수 없고, 이미 열린 fd 만 유효하다. 재시작
 * 후 재사용하지 않으므로 `fsync` 로 내구성을 주장하지 않는다 — 여기서 필요한
 * 것은 배타 생성과 즉시 제거뿐이다.
 */
function assertTrustedStagingRoot(root: string, ownerUid: number): void {
    if (lstatSync(root).isSymbolicLink()) {
        throw new Error('staging root must not be a symlink');
    }
    const resolved = realpathSync(root);
    const segments = resolved.split(sep).filter(Boolean);
    let current: string = sep;
    for (const segment of [...segments, null]) {
        if (segment !== null) current = join(current, segment);
        const stat = lstatSync(current);
        // 남이 소유하거나 남이 쓸 수 있는 조상은 아래를 통째로 갈아끼울 수 있다.
        if (stat.uid !== 0 && stat.uid !== ownerUid) {
            throw new Error(`staging ancestor ${current} has an unexpected owner`);
        }
        if ((stat.mode & 0o022) !== 0) {
            throw new Error(`staging ancestor ${current} is writable by others`);
        }
    }
    if (!lstatSync(resolved).isDirectory()) throw new Error('staging root must be a directory');
}

function stageBootstrap(root: string, bootstrap: Buffer): number {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertTrustedStagingRoot(root, process.getuid?.() ?? 0);
    const path = join(root, `${randomBytes(16).toString('hex')}.envelope`);
    const write = openSync(path, 'wx', 0o600);
    try {
        let written = 0;
        while (written < bootstrap.length) {
            written += writeSync(write, bootstrap, written, bootstrap.length - written);
        }
    } catch (error) {
        // 실패한 스테이징 파일을 남기지 않는다.
        try { unlinkSync(path); } catch { /* 이미 없다 */ }
        throw error;
    } finally {
        closeSync(write);
    }
    let read: number;
    try {
        read = openSync(path, 'r');
    } catch (error) {
        try { unlinkSync(path); } catch { /* 이미 없다 */ }
        throw error;
    }
    try {
        // release 보다 **먼저** 지운다. 자식이 살아 있는 동안 경로가 남아 있으면
        // 그 경로로 다시 열 수 있다.
        unlinkSync(path);
    } catch (error) {
        closeSync(read);
        throw error;
    }
    return read;
}

/**
 * 한 세대의 종료 답을 원장이 저장하는 관측으로 옮긴다. 증명된 정지만 옮긴다.
 *
 * `stopped: false` 는 사실이 아니라 **아직 증명되지 않음**이다 — `timeout`,
 * `exit-unobserved`, `still-populated` 는 모두 재시도되는 상태이고, 그중 첫 번째를
 * 남기면 뒤따라오는 진짜 증명이 들어갈 자리가 막힌다.
 *
 * 충돌을 신원보다 **먼저** 본다. 지금은 게이트가 충돌 시 id 를 비워 주지만, 그
 * 사실에 기대면 게이트가 바뀔 때 이 매핑이 조용히 틀려진다.
 */
function nativeObservationFor(
    observation: GenerationTerminalObservation,
    observedAt: number,
): GenerationNativeObservation | null {
    if (!observation.stopped) return null;
    if (observation.identity === 'conflict') {
        return { observedAt, outcome: 'conflict', nativeId: null, detail: observation.detail };
    }
    // 신원이 없는 것은 "세션을 쓰지 않았다" 가 아니라 **보고되지 않았다** 이다:
    // 예전 peer 는 이 field 자체가 없었고, provider 가 보내지 않아도 정상이다.
    if (observation.nativeId === null) {
        return { observedAt, outcome: 'native-unreported', nativeId: null, detail: observation.detail };
    }
    return {
        observedAt,
        outcome: 'clean-stopped',
        nativeId: observation.nativeId,
        detail: observation.detail,
    };
}

export function createSupervisorRuntime(options: SupervisorRuntimeOptions) {
    const manifest = createGenerationManifest(options.manifestRoot);
    // watchdog 은 supervisor 보다 먼저 있어야 한다 — supervisor 가 release 전에
    // 여기에 등록하기 때문이다. 그래서 참조를 지연시켜 묶는다.
    let watchdogRef: ReturnType<typeof createLeaseWatchdog> | null = null;
    const supervisor = createSupervisor(options.config, {
        ...defaultSupervisorDeps,
        manifest,
        enrollWatchdog: (entry) => { watchdogRef?.arm(entry); },
    });
    /** 지연 참조: launcher 는 watchdog 다음에 만들어진다. */
    let managedLauncherRef: ManagedGenerationLauncher | null = null;
    const watchdog = createLeaseWatchdog({
        supervisor,
        monotonicNow: defaultSupervisorDeps.monotonicNow,
        intervalMs: options.watchdogIntervalMs,
        /*
         * 세대를 비우는 것으로 끝이 아니다. 그 run 의 broker 와 grant 는 이
         * launcher 가 들고 있고, 여기서 내리지 않으면 TTL 까지 열려 있는다.
         * 내리지 못하면 감시를 놓지 않는다 — 놓는 순간 아무도 다시 시도하지 않는다.
         */
        afterStop: ({ key, outcome }) => {
            const handle = managedLauncherRef?.handleForKey(key);
            if (!handle) return;
            void managedLauncherRef!.close(handle).then((proof) => {
                if (!proof.proven || !outcome.stopped) {
                    watchdogRef?.arm({ key, leaseExpiresMonotonic: 0 });
                }
            });
        },
    });
    watchdogRef = watchdog;
    /**
     * run 마다 config 가 다른 supervisor 를 만들되 원장과 watchdog 은 하나를
     * 공유한다. 원장이 갈라지면 정지 증명과 lease 집행이 서로 다른 세계를 본다.
     */
    const managedLauncher = options.managedRun
        ? createManagedGenerationLauncher({
            ...options.managedRun,
            createProviderSupervisor: (config: Parameters<typeof createSupervisor>[0]) => createSupervisor(config, {
                ...defaultSupervisorDeps,
                manifest,
                enrollWatchdog: (entry) => { watchdogRef?.arm(entry); },
            }),
        })
        : null;
    managedLauncherRef = managedLauncher;
    let releaseLock: (() => Promise<void>) | null = null;
    /**
     * Instance-local, never module-scope: two runtimes in one process are two
     * supervisors, and one stopping must not silence the other.
     *
     * `stopping` is set on `stop()`'s first line and **never reset** — a stop
     * that could not prove itself has still begun.
     */
    let stopping = false;
    const stopCheckpointWork = options.stopCheckpointWork;
    /** True only after `await ipc.listen()` has returned successfully. */
    let listenSucceeded = false;
    /**
     * This instance's own nonce and its own copies of the record's axes.
     *
     * Copied at construction rather than read through `options` at publish
     * time: a caller that mutates the object afterwards must not be able to
     * change what a later publish records.
     */
    const instanceNonce = randomBytes(24).toString('base64url');
    const attestationScope = options.attestation
        ? {
            stateDir: options.attestation.stateDir,
            provisioningOperationId: options.attestation.provisioningOperationId,
            markerSha256: options.attestation.markerSha256,
            provisioning: options.attestation.provisioning,
            socketPath: options.socketPath,
            runtimeId: options.runtimeId,
        }
        : null;
    // Only captured scalars leave the runtime; each observation is a fresh object.
    const hello = (): SupervisorHello | null => {
        if (stopping || releaseLock === null || !listenSucceeded || !attestationScope) return null;
        return {
            instanceNonce,
            runtimeId: attestationScope.runtimeId,
            provisioningOperationId: attestationScope.provisioningOperationId,
            markerSha256: attestationScope.markerSha256,
        };
    };
    /** 준비돼 park 된 세대들. handle 은 일회용이다. */
    const parked = new Map<string, {
        key: GenerationKey;
        leaseExpiresMonotonic: number;
        bootstrapFd: number;
        /** 자격 문서의 부모 쪽 fd. 봉투와 같은 수명이다. */
        reportFd: number;
        timer: NodeJS.Timeout;
    }>();

    const closeFd = (fd: number) => { try { closeSync(fd); } catch { /* 이미 닫혔다 */ } };

    const ipc = createIpcServer({
        socketPath: options.socketPath,
        token: options.token,
        ...(options.daemonGid !== undefined ? { daemonGid: options.daemonGid } : {}),
        handlers: {
            hello,
            proveStopped: (key: GenerationKey) => manifest.proveStopped(key),
            // runtime 전체 질문이다. run/attempt 로 좁히지 않는다.
            proveBelow: ({ belowEpoch }) => manifest.proveAllBelow(belowEpoch),
            async prepareLaunch({ key, leaseExpiresMonotonic, bootstrap, reportCredential }) {
                // 봉투가 실제 B2 모양인지 여기서 본다. 모양을 안 보고 넘기면
                // 자식이 무엇을 받는지 supervisor 가 모르게 된다.
                let envelope;
                try {
                    envelope = parseManagedSpawnEnvelope(JSON.parse(bootstrap.toString('utf8')), Date.now());
                } catch {
                    // 봉투 내용은 어디에도 남기지 않는다.
                    return { prepared: false, detail: 'bootstrap-invalid' };
                }
                // 봉투가 유효해도 격리 설정이 없으면 띄우지 않는다.
                if (!managedLauncher) return { prepared: false, detail: 'managed-run-unconfigured' };
                /*
                 * 이 runtime 이 provision 된 Happy 가 아니면 여기서 끝낸다.
                 *
                 * **stageBootstrap 앞이어야 한다.** 그 뒤로 가면 scoped bearer 가
                 * 담긴 문서가 이미 디스크에 있고, 자식은 그 봉투의 origin 으로
                 * 그것을 보낸다 — 자식이 attach 를 시도하기 전에 이미 늦다.
                 *
                 * 저장된 origin 과 비교한다. 봉투를 봉투와 비교하면 항상 같다.
                 */
                if (!options.managedRun
                    || !sameManagedOrigin(envelope.bootstrap.serverOrigin, options.managedRun.serverOrigin)) {
                    // 축 이름만. 두 origin 도 그 옆의 token 도 daemon 이 돌려줄 것이 아니다.
                    return { prepared: false, detail: 'envelope-origin-untrusted' };
                }
                // 자격 문서도 모양을 여기서 본다. 자식이 읽지 못할 문서를 들려
                // 보내면 그 자식의 보고는 전부 거부되고, 이유는 자식 안에만 남는다.
                try {
                    parseManagedReportCredential(reportCredential);
                } catch {
                    return { prepared: false, detail: 'report-credential-invalid' };
                }
                const childFd = options.bootstrapFd ?? 3;
                /*
                 * The descriptors this launch will use, checked **before the
                 * first one is staged**.
                 *
                 * Order is the point, not decoration: `stageBootstrap` opens a
                 * descriptor per document, and the refusal below returns
                 * without closing anything. Running this after staging leaked
                 * two credential descriptors on every refused launch — one
                 * holding the envelope, one holding the report credential.

                 *
                 * `options.bootstrapFd` is configurable, so they cannot be
                 * assumed distinct. Two documents on one descriptor means the
                 * child reads one as the other, and the failure surfaces far
                 * away — as an unparseable envelope, or as a control channel
                 * that never speaks.
                 */
                try {
                    assertDistinctManagedFds({
                        bootstrap: childFd,
                        report: MANAGED_REPORT_CHILD_FD,
                        control: MANAGED_CONTROL_CHILD_FD,
                        status: 9,
                        release: 8,
                    });
                } catch {
                    // The axis only. The numbers are configuration, and the
                    // parent gets a code it can act on.
                    return { prepared: false, detail: 'descriptor-conflict' };
                }
                let bootstrapFd: number;
                try {
                    bootstrapFd = stageBootstrap(options.stagingRoot, bootstrap);
                } catch {
                    return { prepared: false, detail: 'staging-failed' };
                }
                let reportFd: number;
                try {
                    // 봉투와 같은 방식으로, **다른** 파일에 놓는다.
                    reportFd = stageBootstrap(options.stagingRoot, reportCredential);
                } catch {
                    closeFd(bootstrapFd);
                    return { prepared: false, detail: 'staging-failed' };
                }
                let prepared: ManagedGenerationPrepared;
                try {
                    prepared = await managedLauncher.prepare({
                        key,
                        envelope,
                        leaseExpiresMonotonic,
                        statusFd: 9,
                        releaseFd: 8,
                        // 자식은 약속된 번호로 받고, 그 자리에 방금 연 fd 를 붙인다.
                        inherit: [
                            { childFd, parentFd: bootstrapFd },
                            { childFd: MANAGED_REPORT_CHILD_FD, parentFd: reportFd },
                        ],
                    });
                } catch {
                    closeFd(bootstrapFd);
                    closeFd(reportFd);
                    return { prepared: false, detail: 'prepare-failed' };
                }
                if (!prepared.prepared) {
                    closeFd(bootstrapFd);
                    closeFd(reportFd);
                    return { prepared: false, detail: prepared.detail };
                }
                const handle = prepared.handle;
                const timer = setTimeout(() => {
                    const entry = parked.get(handle);
                    if (!entry) return;
                    parked.delete(handle);
                    void managedLauncher.abandon(handle);
                    closeFd(entry.bootstrapFd);
                    closeFd(entry.reportFd);
                }, options.releaseDeadlineMs);
                timer.unref?.();
                parked.set(handle, { key, leaseExpiresMonotonic, bootstrapFd, reportFd, timer });
                return { prepared: true, pid: prepared.pid, handle };
            },

            async releaseLaunch(handle) {
                const entry = parked.get(handle);
                // 일회용이다. 같은 handle 을 두 번 쓰지 못한다.
                if (!entry) return { released: false, detail: 'unknown-handle' };
                parked.delete(handle);
                clearTimeout(entry.timer);
                try {
                    // 등록이 끝났다는 뜻이다. 합성이 기다리던 게이트를 연다.
                    return managedLauncher
                        ? await managedLauncher.release(handle)
                        : { released: false, detail: 'managed-run-unconfigured' };
                } finally {
                    // 성공이든 실패든 부모 쪽 fd 는 놓는다.
                    closeFd(entry.bootstrapFd);
                    closeFd(entry.reportFd);
                }
            },

            ...(options.acceptCheckpointTarget ? {
                acceptCheckpointTarget: composeCheckpointTargetHandler({
                    authenticate: options.authenticateCheckpointTarget,
                    accept: options.acceptCheckpointTarget,
                }),
            } : {}),

            acceptRuntimeGrant: composeRuntimeGrantHandler({ admit: options.admitRuntimeGrant }),

            renew: ({ key, renewalSeq, leaseExpiresMonotonic }) => {
                /*
                 * 이 세대를 띄운 supervisor 가 그 세대의 deadline 을 들고 있다.
                 * 다른 인스턴스에 물으면 deadline 이 **없고**, 없다는 것은 거절할
                 * 근거가 없다는 뜻이 되어 이미 만료된 세대가 되살아난다.
                 * 그 권위가 없을 때만 기본 supervisor 로 내려간다 — 이 launcher 가
                 * 띄운 적이 없는 세대라는 뜻이고, 거기엔 원장 기반 판정이 남아 있다.
                 */
                const managed = managedLauncher?.renewGeneration({ key, renewalSeq, leaseExpiresMonotonic });
                if (managed && !(managed.renewed === false && managed.detail === 'no-generation-authority')) {
                    return managed.renewed
                        ? { renewed: true }
                        : { renewed: false, detail: managed.detail };
                }
                const result = supervisor.renewLease({ key, renewalSeq, leaseExpiresMonotonic });
                return result.renewed
                    ? { renewed: true }
                    : { renewed: false, detail: result.detail };
            },

            requestStop: async (key: GenerationKey) => {
                const outcome = supervisor.stopGeneration(key);
                /*
                 * 세대가 멈췄다고 그 run 의 broker 까지 닫힌 것은 아니다. 합성이
                 * 들고 있는 것은 이 launcher 만 내릴 수 있으므로 여기서 내린다 —
                 * 증명하지 못하면 그 사실이 unproven 으로 올라간다.
                 */
                const handle = managedLauncher?.handleForKey(key) ?? null;
                const closed = handle ? await managedLauncher!.close(handle) : null;
                // 관측하지 못한 정지를 수락으로 보고하지 않는다 — 세대든 broker 든.
                if (!outcome.stopped) return { requested: false, detail: outcome.detail };
                if (closed && !closed.proven) return { requested: false, detail: closed.detail };
                return { requested: true, detail: 'observed-empty' };
            },
        },
    });

    return {
        supervisor,
        watchdog,
        manifest,
        token: ipc.token,
        hello,
        /**
         * 이 runtime 의 provider quiescence 게이트.
         *
         * **필수다.** optional 로 두면 boot 가 캐스트로 넘겨보고 없으면 조용히
         * gate-null 로 남는데, 그것이 바로 "게이트 없음" 영구 기준선이다.
         *
         * 게이트가 볼 7가지 중 6가지가 이 closure 안에 있다 — launcher 의
         * 세대들, 원장, 그리고 그 세대들에게 입력을 끝내라고 청할 수단. 밖에서
         * 조립할 수 없으므로 여기서 조립해 돌려준다. 호출자가 주는 것은 자기가
         * 소유한 drain 하나뿐이다.
         *
         * 통로가 없는 runtime 은 `null` 이 아니라 `eof-unverified` 로 **거절하는
         * 게이트**를 받는다. 거절은 정상적인 답이고, 없는 게이트는 답이 아니다.
         */
        providerQuiescence(input: {
            drain: { inFlight(): number; isDraining(): boolean; writes(): number };
            /** 세대 하나가 입력을 끝내고 나가기까지 기다릴 상한. */
            endInputBudgetMs: number;
        }): ProviderQuiescenceGate {
            if (!managedLauncherRef) {
                throw new Error('managed runtime has no generation launcher');
            }
            const launcher = managedLauncherRef;
            return createManagedProviderQuiescenceGate({
                drain: input.drain,
                launcher,
                manifest,
                endInput: endInputForLiveGenerations({
                    generations: () => launcher.liveGenerations(),
                    budgetMs: input.endInputBudgetMs,
                    // Otherwise the gate can only say `eof-unverified`, which
                    // names the step and not the reason.
                    onRefused: (detail) => {
                        logger.debug(`[managed] end-input refused ${detail}`);
                    },
                    /*
                     * 증명된 종료만 원장에 남긴다.
                     *
                     * 이 callback 은 동기다 — `endInput()` 이 답을 돌려주기 전에
                     * 여기서 하는 기록은 이미 끝나 있다(실패했든 성공했든). 반대로
                     * 이것은 게이트의 다른 일이 끝났다는 뜻은 아니다: provider 를
                     * 기다리는 일은 다른 곳에서 아직 진행 중일 수 있다.
                     *
                     * 관측은 세대마다 독립이다. 다른 세대가 거절해 checkpoint 가
                     * 성립하지 않아도, 증명된 세대의 관측은 남는다 — 그 세대가
                     * 그렇게 끝났다는 사실은 집계 결과와 무관하다.
                     */
                    onObserved: (observed) => {
                        for (const observation of observed) {
                            const mapped = nativeObservationFor(observation, Date.now());
                            // 증명되지 않은 답은 관측이 아니다. `timeout` 이나
                            // `exit-unobserved` 를 남기면 재시도가 가져올 진짜
                            // 증명이 막힌다.
                            if (mapped === null) continue;
                            let result;
                            try {
                                result = manifest.recordNativeObservation({
                                    key: observation.key,
                                    observation: mapped,
                                });
                            } catch {
                                /*
                                 * 고정된 낱말 하나. 던진 쪽의 `code` 는 그쪽의
                                 * 어휘이고 message 는 이 runtime 이 부모가 읽는
                                 * 로그로 옮길 것이 아니다.
                                 */
                                logger.debug('[managed] native-observation writer-threw');
                                continue;
                            }
                            // 예상된 결과(`first`·`duplicate-ignored`·
                            // `conflict-kept`)는 적지 않는다 — 그것까지 적으면
                            // 진짜 문제가 묻힌다.
                            if (!result.ok) {
                                logger.debug(`[managed] native-observation ${result.reason}`);
                            }
                        }
                    },
                }),
            });
        },
        /**
         * 재시작 재조정.
         *
         * 새 프로세스는 감시 목록이 비어 있다. 그런데 이전 supervisor 가 띄운
         * 자식은 그대로 돌고 있을 수 있다 — 그 세대를 무장하지 않으면 lease 가
         * 영원히 집행되지 않는다. 그래서 **명령을 받기 전에** 원장의 열린 세대를
         * 훑어 무장하고, 이미 만료된 것은 그 자리에서 정지시킨다.
         *
         * 이 supervisor 는 이전 lease deadline 을 모른다(단조 시계는 재부팅으로
         * 리셋된다). 알 수 없는 것을 유효하다고 가정하지 않는다 — 열린 세대는
         * **즉시 만료**로 본다.
         */
        reconcile(): {
            armed: number;
            stopped: Array<{ key: GenerationKey; detail: string }>;
            unreadable: number;
        } {
            const open = manifest.listOpen();
            const stopped: Array<{ key: GenerationKey; detail: string }> = [];
            for (const record of open.records) {
                const key = { runId: record.runId, attemptId: record.attemptId, epoch: record.epoch };
                // 정지 요청이 이미 나갔던 세대는 부재를 증거로 확정할 수 있다 —
                // 이 supervisor 가 배타 잠금을 들고 있고 세대 재사용이 금지돼
                // 같은 경로가 다시 생기지 않기 때문이다.
                const outcome = record.terminationRequestedAt !== null
                    ? supervisor.resolvePendingTermination(key)
                    : supervisor.stopGeneration(key);
                if (outcome.stopped) {
                    stopped.push({ key, detail: 'observed-empty' });
                    continue;
                }
                // 관측하지 못했으면 감시에 올려 다음 tick 이 다시 시도한다.
                stopped.push({ key, detail: outcome.detail });
                watchdog.arm({ key, leaseExpiresMonotonic: 0 });
            }
            return { armed: watchdog.armedCount(), stopped, unreadable: open.unreadable };
        },

        async start(): Promise<void> {
            // 두 supervisor 가 같은 원장과 cgroup 을 만지면 재조정이 서로의
            // 세대를 지운다. 잠금을 못 얻으면 시작하지 않는다.
            const lock = await (options.acquireLock ?? acquireSupervisorLock)({
                runtimeId: options.runtimeId,
                manifestRoot: options.manifestRoot,
                cgroupRoot: options.config.cgroupRoot,
            });
            if (!lock.ok) throw new Error(`supervisor lock unavailable (${lock.reason})`);
            releaseLock = lock.release;
            // 재조정이 먼저다. 명령을 받기 시작한 뒤에 하면 그 사이 새 세대가
            // 옛 세대와 섞인다.
            this.reconcile();
            watchdog.start();
            await ipc.listen();
            // Only now is the socket this runtime would attest to actually bound.
            listenSucceeded = true;
        },

        /**
         * Records that **this** instance is the supervisor on this socket.
         *
         * No arguments, and synchronous by contract. No argument, because a
         * caller that could shape the record would separate "who recorded this"
         * from "who is running"; synchronous, because the gate below and the
         * write must not have a `stop()` between them.
         *
         * `published` says a file was written by this runtime at this moment.
         * It does not say the runtime is current, that it is the only one, or
         * that it is still running when somebody reads the file — the live half
         * is a separate increment.
         */
        publishAttestation(): ManagedSupervisorPublishOutcome {
            /*
             * `stopping` is the one that makes this safe. `releaseLock` is
             * still non-null *during* `await releaseLock()`, so it is not
             * evidence of held kernel authority — it means only that this
             * runtime has not completed a release. Every path that reaches that
             * await has had `stopping` true since before `ipc.close()`.
             */
            if (stopping || releaseLock === null || !listenSucceeded) {
                return 'refused-not-current';
            }
            if (!attestationScope) return 'refused-no-scope';
            const outcome = writeManagedSupervisorAttestation({
                stateDir: attestationScope.stateDir,
                record: {
                    version: MANAGED_SUPERVISOR_ATTESTATION_VERSION,
                    instanceNonce,
                    socketPath: attestationScope.socketPath,
                    runtimeId: attestationScope.runtimeId,
                    provisioningOperationId: attestationScope.provisioningOperationId,
                    markerSha256: attestationScope.markerSha256,
                },
                /*
                 * Explicit, never elided. The writer requires this and judges
                 * the ancestry with it **at publish time**; a runtime with no
                 * injected observation uses the real one rather than being cast
                 * past the requirement.
                 */
                provisioning: attestationScope.provisioning ?? defaultProvisioningDeps,
            });
            // The writer's stage travels unchanged. Folding seven stages into
            // one "failed" would lose the difference between "nothing was
            // written" and "the new file is already visible".
            return outcome.ok ? 'published' : `refused-write:${outcome.stage}`;
        },
        /**
         * 종료.
         *
         * 순서가 계약이다. watchdog 을 먼저 끄고 잠금을 놓으면, 이미 release 된
         * 자식들이 감시자 없이 영원히 남는다 — 그리고 그 잠금을 잡은 다음
         * supervisor 는 원장의 열린 기록을 보고 재조정하겠지만, 그 사이는 아무도
         * 보지 않는 구간이다.
         *
         *  ① 새 요청을 막는다(IPC 닫기)
         *  ② 진행 중 launch 를 정리한다 — park 된 것은 abort, 이미 놓아준 것은
         *     아래 정지 대상이다
         *  ③ **watchdog 과 잠금을 든 채로** 열린 세대를 전부 정지·증명한다
         *  ④ 전부 증명됐을 때만 watchdog 을 끄고 잠금을 놓는다
         *
         * 하나라도 증명하지 못하면 watchdog 과 잠금을 유지한 채 실패를 알린다.
         * 감시를 놓는 것이 곧 그 자식을 잃는 것이다.
         */
        async stop(): Promise<
            { stopped: true } | { stopped: false; open: GenerationKey[]; unreadable: number; detail?: 'checkpoint-work-unproven' }
        > {
            // 맨 앞이다. 이 뒤의 어떤 await 중에도 발행이 끼어들지 못한다.
            stopping = true;
            // Invoke before the first await: the actual loop closes tick admission synchronously.
            // Observe rejection immediately even while IPC is still draining.
            let checkpointSettled: Promise<boolean>;
            try {
                checkpointSettled = stopCheckpointWork
                    ? Promise.resolve(stopCheckpointWork()).then(result => result?.pendingPublication === false).catch(() => false)
                    : Promise.resolve(true);
            } catch { checkpointSettled = Promise.resolve(false); }
            // ① 입구를 먼저 막는다.
            await ipc.close();
            if (!await checkpointSettled) {
                // Local work may still read/write or record observations. Keep providers,
                // watchdog and ownership; only a later explicit stop may try again.
                return { stopped: false, open: [], unreadable: 0, detail: 'checkpoint-work-unproven' };
            }
            // Local settlement includes failure/remote uncertainty, not publication success.

            // ② park 된 것은 exec 없이 접는다.
            const open: GenerationKey[] = [];
            for (const [handle, entry] of [...parked]) {
                parked.delete(handle);
                clearTimeout(entry.timer);
                /*
                 * 게이트를 **거부**한다. 여는 것이 곧 release 이므로, 접으려고
                 * 열면 접으려던 그 run 을 띄우게 된다. 거부는 park 를 중단시키고
                 * 합성이 broker 와 grant 를 스스로 거둔다.
                 */
                const folded = await managedLauncher?.abandon(handle);
                closeFd(entry.reportFd);
                if (folded && !folded.terminated) {
                    // 비었음을 관측하지 못했다. 정지로 접지 않는다.
                    open.push(entry.key);
                    watchdog.arm({ key: entry.key, leaseExpiresMonotonic: 0 });
                }
                closeFd(entry.bootstrapFd);
            }

            // ③ 감시와 잠금을 든 채로 정지시킨다.
            const inventory = manifest.listOpen();
            /*
             * 읽지 못한 기록이 있으면 **무엇이 열려 있는지 모른다.** 그 상태로
             * 감시와 잠금을 놓으면 알지 못하는 자식이 감시자 없이 남는다.
             */
            const unreadable = inventory.unreadable;
            for (const record of inventory.records) {
                const key = { runId: record.runId, attemptId: record.attemptId, epoch: record.epoch };
                const outcome = record.terminationRequestedAt !== null
                    ? supervisor.resolvePendingTermination(key)
                    : supervisor.stopGeneration(key);
                if (!outcome.stopped) {
                    open.push(key);
                    // 다음 tick 이 다시 시도하도록 감시에 올려 둔다.
                    watchdog.arm({ key, leaseExpiresMonotonic: 0 });
                }
            }
            if (open.length > 0 || unreadable > 0) {
                // watchdog 도 잠금도 놓지 않는다.
                return { stopped: false, open, unreadable };
            }

            // ④ 전부 증명됐다. 남은 broker 와 grant 도 여기서 거둔다.
            const closed = await managedLauncher?.closeAll() ?? [];
            // 하나라도 증명하지 못했으면 놓지 않는다.
            if (closed.some((entry) => !entry.proven)) {
                // 내리지 못한 것이 있으면 놓지 않는다. 이유는 unproven 으로 이미 올라갔다.
                return { stopped: false, open, unreadable };
            }
            watchdog.stop();
            if (releaseLock) {
                await releaseLock();
                releaseLock = null;
            }
            // 잠금을 놓은 **뒤에** 지운다. 입구는 ①에서 이미 닫혔고 진행 중이던
            // handler 도 그때 빠져나갔으므로, 여기서 지운 것을 다시 채울 수 있는
            // 경로가 없다. 증명하지 못한 정지는 위에서 이미 돌아갔고 잠금도
            // 그대로이므로 스냅샷도 그대로다.
            options.clearRuntimeGrant?.();
            return { stopped: true };
        },
    };
}

/**
 * The supervisor's side of the checkpoint relay: parse, authenticate, queue.
 *
 * Separated from the composition root because it is the only part of that root
 * with behaviour to get wrong, and a test cannot boot a supervisor to reach it.
 *
 * The order is the point. The document is parsed first because the signature is
 * over the params *as sent*, and the digest must be taken over that parse
 * result - the delivery built from it is a lossy reconstruction (`keyBase64`
 * becomes a Buffer, `targets.areas[]` a Map) and a digest over it can never
 * equal the signed one. Nothing is queued before the authentication answers.
 */
/**
 * The supervisor's side of the grant relay: parse, authenticate, record.
 *
 * Separated from the composition root for the same reason as its checkpoint
 * twin — it is the only part of that root with behaviour to get wrong, and a
 * test cannot boot a supervisor to reach it.
 *
 * The params are parsed here and the digest is taken over that parse result,
 * because the signature covers the document the parent sent. Nothing is
 * recorded before the authentication answers.
 */
export function composeRuntimeGrantHandler(input: {
    admit?: (request: { rawParams: Record<string, unknown>; dispatchToken: string })
        => { ok: true } | { ok: false; reason: string };
}) {
    return (params: Buffer, dispatchToken: string): { admitted: boolean; detail: string } => {
        /*
         * The decoded bytes, before they are parsed.
         *
         * The IPC boundary bounds the **encoded** field, and that is not the
         * same contract: `4*ceil(1024/3)` = 1,368 base64 characters decode to
         * as much as 1,026 bytes, so a 1,025-byte document satisfies the field
         * cap. This is the only place the 1 KiB the design states can actually
         * be enforced, and it runs before `JSON.parse` so an oversized document
         * is never walked.
         */
        if (params.length > MANAGED_GRANT_PARAMS_MAX_BYTES) {
            return { admitted: false, detail: 'grant-invalid' };
        }
        let rawParams: unknown;
        try {
            rawParams = JSON.parse(params.toString('utf8'));
        } catch {
            return { admitted: false, detail: 'grant-invalid' };
        }
        if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
            return { admitted: false, detail: 'grant-invalid' };
        }
        // Absence refuses. Not having a way to check is not a reason to record.
        if (!input.admit) return { admitted: false, detail: 'grant-unauthenticated' };
        const outcome = input.admit({
            rawParams: rawParams as Record<string, unknown>,
            dispatchToken,
        });
        /*
         * One classifier for every refusal. Which axis failed is what the
         * holder of a stolen token would want to learn, and the daemon's action
         * — refuse the renewal, write nothing — is the same for all of them.
         */
        return outcome.ok
            ? { admitted: true, detail: 'admitted' }
            : { admitted: false, detail: 'grant-unauthenticated' };
    };
}

export function composeCheckpointTargetHandler(input: {
    authenticate?: (request: {
        rawParams: Record<string, unknown>;
        dispatchToken: string;
        checkpointId: string;
    }) => { ok: true; receipt: ManagedCheckpointReceipt } | { ok: false; reason: string };
    accept: (target: ManagedCheckpointTargetDelivery, receipt: ManagedCheckpointReceipt)
        => ManagedCheckpointTargetAcceptance | void;
}) {
    return (target: Buffer, dispatchToken: string) => {
        let envelope: ReturnType<typeof parseManagedCheckpointTargetEnvelope>;
        try {
            envelope = parseManagedCheckpointTargetEnvelope(target);
        } catch {
            // 내용은 어디에도 남기지 않는다 — 한 체크포인트짜리 키와
            // 서명된 업로드 URL 이 들어 있다.
            return { accepted: false, detail: 'target-invalid' };
        }
        // Absence refuses. Not having a way to check is not a reason to accept.
        if (!input.authenticate) return { accepted: false, detail: 'target-unauthenticated' };
        const authenticated = input.authenticate({
            rawParams: envelope.rawParams,
            dispatchToken,
            checkpointId: envelope.delivery.checkpointId,
        });
        if (!authenticated.ok) {
            /*
             * One classifier for every refusal. The reason is known here and
             * deliberately not carried: it would let the holder of a stolen
             * token learn which axis it failed on, and the parent's action -
             * stop, do not retry this document - is the same for all of them.
             */
            return { accepted: false, detail: 'target-unauthenticated' };
        }
        const outcome = input.accept(envelope.delivery, authenticated.receipt);
        /*
         * The state travels with the acceptance rather than as a refusal. All
         * four states end this hop — the parent has been heard and must stop
         * retrying it — and they differ in whether an archive follows:
         * `queued`/`replaced-unconsumed` mean one will, `in-flight` means that
         * id is already running, `completed` means it published its pointer,
         * `needs-verification` means an earlier attempt stopped without proving
         * what it wrote. Flattening them would report an archive that is not
         * going to happen.
         *
         * Normalised at the boundary: `replaced-unconsumed` is this inbox's own
         * word for "a newer issue replaced one nobody had taken yet", and the
         * parent's action for it is identical to `queued`. It is not in the wire
         * vocabulary, and a parent that meets a state it does not know
         * classifies it as a failure it must not retry. The distinction survives
         * in `detail`, where it is diagnosis rather than contract.
         */
        return {
            accepted: true,
            ...wireStateForAcceptance(outcome ?? { accepted: true, state: 'queued' }),
        };
    };
}

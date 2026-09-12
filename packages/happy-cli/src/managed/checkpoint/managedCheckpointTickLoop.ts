/**
 * What makes checkpoints actually happen: something that ticks.
 *
 * The coordinator decides and the runner archives, but nothing asked either of
 * them on a schedule — a composed coordinator that nobody ticks takes no
 * checkpoints at all, and reads as a working feature from every angle except
 * the volume.
 *
 * ## What this loop is careful about
 *
 * **One tick at a time.** A tick closes admission, drains, uploads and
 * publishes; a second one entering that window would ask for a fresh target
 * while the first attempt owns the drain, and the coordinator would refuse it as
 * in-flight — a refusal that says nothing about the runtime. The timer is
 * re-armed *after* a tick settles, so a slow checkpoint slows the schedule
 * instead of stacking against itself.
 *
 * **Idle is asked, never assumed.** The decision comes from the caller each
 * tick. This loop does not synthesise one: an invented "idle" is how a
 * checkpoint gets taken over a running turn, and an invented "active" is how a
 * runtime never checkpoints at all. When the caller cannot decide, that answer
 * travels as it is and the coordinator's own rules apply.
 *
 * **Shutdown waits for a publication, and only for that.** Stopping mid-attempt
 * would leave an archive uploaded with no pointer published — a checkpoint that
 * exists and that nothing can find. So `stop()` stops arming new ticks and
 * awaits the attempt in flight. It waits with a bound: a hung upload must not
 * hold the runtime's shutdown open forever, and after that bound the fact is
 * reported rather than hidden.
 */
import type { ManagedCheckpointCoordinator, CheckpointTickResult } from './managedCheckpointCoordinator';
import type { ProviderQuiescenceRefusal } from './managedProviderQuiescence';
import type { CheckpointTrigger } from './managedCheckpointSchedule';
import type { RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

export type ManagedCheckpointTickLoop = {
    /** Arms the first tick. Idempotent: a started loop stays as it is. */
    start(): void;
    /**
     * One tick now, outside the schedule — a turn boundary, say.
     *
     * Serialised with the loop's own ticks: if one is running, this reports
     * `{ ticked: false }` rather than starting a second.
     */
    tickNow(trigger: CheckpointTrigger): Promise<{ ticked: boolean; result?: CheckpointTickResult }>;
    /**
     * Stops arming, then waits for the attempt in flight.
     *
     * `pendingPublication` says a tick was still running when the wait ran out —
     * an archive may be uploaded with its pointer unpublished, which is a fact
     * the caller has to be able to see.
     */
    stop(): Promise<{ pendingPublication: boolean }>;
};

export type ManagedCheckpointTickLoopDeps = {
    coordinator: ManagedCheckpointCoordinator;
    /** How often to ask. Configured; this loop invents no cadence. */
    intervalMs: number;
    /**
     * The runtime's own idle decision, asked per tick.
     *
     * Not cached and not derived here: whether a runtime is in use is the
     * runtime's fact, and a stale copy of it is the wrong input to a decision
     * that archives a volume.
     */
    idle: () => RuntimeIdleDecision;
    now: () => number;
    /**
     * Told what each tick decided, **including one that threw** (`errored`).
     *
     * Fixed classifiers only. `errored` is kept apart from `failed` on purpose:
     * `failed` is the coordinator answering that an attempt did not save, while
     * `errored` is the coordinator not answering at all. Collapsing them loses
     * which of the two happened, and they need different responses.
     *
     * A throw from here is swallowed: a diagnostic that can stop the consumer is
     * one nobody leaves enabled.
     */
    onTick?: (outcome: {
        trigger: CheckpointTrigger; kind: string; reason?: string; detail?: string;
    }) => void;
    /**
     * Told when a tick **begins**.
     *
     * Without it, "never armed", "hung mid-attempt" and "rejected" are one
     * silence — measured on this loop: a rejected coordinator produced one
     * invocation, two timer arms and zero events. A start paired with no
     * outcome is the shape of a hang; no start at all is the shape of a loop
     * that never ran.
     */
    onTickStart?: (outcome: { trigger: CheckpointTrigger }) => void;
    /** How long `stop()` may wait for an attempt in flight. Configured. */
    shutdownWaitMs: number;
    setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
    clearTimer?: (handle: NodeJS.Timeout | number) => void;
};

/**
 * Skip details that may travel: a closed set, and nothing else.
 *
 * A skip's `reason` is always the coordinator's own enum, but its `detail` is
 * not one thing. For `provider-state-unproven` it is the gate's refusal — an
 * enum, and the only part that says *which* step did not hold — while for
 * `quiescence-unavailable` and `targets-unavailable` it is
 * `String(error.code)` from whatever threw, which is not an enum at all.
 *
 * The first live run of the whole path settled as `provider-state-unproven`
 * with nothing after it, and that answer cannot be acted on: an ACK that was
 * not `exhausted-clean`, an exit nobody observed, writers still holding the
 * state open and an unaccounted generation each need a different response.
 *
 * The gate's own reasons are enumerated as a `Record`, so a new refusal fails
 * the build until it is classified rather than silently dropping out of the
 * report.
 */
const PROVIDER_REFUSALS: Record<ProviderQuiescenceRefusal, true> = {
    'admission-open': true,
    'work-in-flight': true,
    'eof-unverified': true,
    'exit-unobserved': true,
    'exit-nonzero': true,
    'exit-signalled': true,
    'writers-remain': true,
    'provider-restarted': true,
    'generation-unaccounted': true,
};

const FORWARDABLE_SKIP_DETAILS: ReadonlySet<string> = new Set([
    ...Object.keys(PROVIDER_REFUSALS),
    // The coordinator's own closed details, which name a wiring state rather
    // than a dependency's failure.
    'no-quiescence-gate',
    'gate-not-wired',
    'admission-unreleased',
    'invalidated-during-archive',
]);

/**
 * Failure codes that may travel, and nothing else.
 *
 * A failed attempt's detail is `String(error.code)` from whatever threw, so it
 * cannot be forwarded as it is — `code` is not an enum, and a library can put a
 * message, a path or a signed URL there. But `failed` on its own is not
 * actionable either: a refused presign, an unreachable store, a pointer race and
 * a full disk each need a different response, and the first live run that got
 * past the quiescence gate settled as a bare `failed`.
 *
 * So the codes this runtime can actually meet are enumerated. Two groups, and
 * both are closed:
 *
 *  - **the publisher's and coordinator's own** classifiers, which are already
 *    fixed words;
 *  - **the transport and filesystem codes** a store upload can fail with, which
 *    are `errno`/undici names rather than free text.
 *
 * Anything else is reported as `unclassified`: the fact that a code was there
 * without repeating it, which also says this list needs extending.
 */
const FORWARDABLE_FAILURE_DETAILS: ReadonlySet<string> = new Set([
    // `managedCheckpointPublisher` and the coordinator.
    'unsupported-database',
    'target-missing',
    'pointer-conflict',
    'pointer-unreadable',
    'area-empty-project',
    'area-empty-provider-state',
    // The manifest did not describe the bytes that were sealed — a retry is the
    // right response, and the area is worth naming.
    'sealed-mismatch-project',
    'sealed-mismatch-provider-state',
    'provider-state-coverage-unknown',
    'provider-state-coverage-missing',
    'checkpoint-failed',
    'targets-failed',
    'quiescence-failed',
    // Which stage a failure that named nothing itself happened in.
    'stage-archive',
    'stage-upload',
    'stage-pointer',
    // `CheckpointObjectStoreError`. These were missing, so a store failure —
    // the most likely kind — arrived as `unclassified`.
    'upload-failed',
    'download-failed',
    'verify-failed',
    'missing',
    'object-exists',
    // Transport and filesystem. A store upload meets these, not prose.
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOSPC',
    'EACCES',
    'EPERM',
    'EEXIST',
    'ENOENT',
    'EMFILE',
    'EROFS',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'ERR_STREAM_PREMATURE_CLOSE',
]);

/**
 * A closed classifier, never a dependency's words.
 *
 * A skip carries the coordinator's own `reason` — always a closed enum — and its
 * `detail` only when that too is closed (`FORWARDABLE_SKIP_DETAILS`).
 *
 * A failure carries a `detail` as well, but never the raw one: the coordinator's
 * value there is `String(error.code)` from whatever threw, and `code` is not an
 * enum — an http client or a store can put an arbitrary string on it, path and
 * signature included. So a recognised code travels as itself
 * (`FORWARDABLE_FAILURE_DETAILS`) and everything else becomes `unclassified`,
 * which says a code was present without repeating it.
 *
 * The full result still reaches `tickNow`'s caller either way; what this loop
 * reports is the part that is safe in a log.
 */
function classify(result: CheckpointTickResult): { kind: string; reason?: string; detail?: string } {
    if (result.attempted) {
        if (result.saved) return { kind: 'saved' };
        return {
            kind: 'failed',
            // 아는 코드면 그 코드를, 모르는 코드면 "있었다" 만.
            detail: FORWARDABLE_FAILURE_DETAILS.has(result.detail) ? result.detail : 'unclassified',
        };
    }
    const decision = result.decision as { reason?: string; detail?: string };
    const detail = decision.detail;
    return {
        kind: 'skipped',
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        // 닫힌 집합에 있는 것만 나간다. 그 밖의 `detail` 은 던진 쪽의 코드다.
        ...(detail !== undefined && FORWARDABLE_SKIP_DETAILS.has(detail) ? { detail } : {}),
    };
}

export function createManagedCheckpointTickLoop(
    deps: ManagedCheckpointTickLoopDeps,
): ManagedCheckpointTickLoop {
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

    let armed: NodeJS.Timeout | number | null = null;
    let running: Promise<CheckpointTickResult> | null = null;
    let stopping = false;

    /** Never lets an observer's failure reach the work it is observing. */
    const report = (run: () => void): void => {
        try {
            run();
        } catch {
            // 진단이 서비스를 죽이면 아무도 진단을 켜 두지 않는다.
        }
    };

    const runTick = async (trigger: CheckpointTrigger): Promise<CheckpointTickResult> => {
        report(() => deps.onTickStart?.({ trigger }));
        /*
         * `coordinator.tick(...)` 호출 자체가 `try` **안에** 있다.
         *
         * 밖에 있었을 때는 동기 throw — coordinator 가 promise 를 만들기 전에
         * 던지거나, `deps.idle()`/`deps.now()` 가 던지는 경우 — 가 이 catch 를
         * 지나쳐서 `errored` 이벤트가 하나도 안 나갔다. 진단의 목적이 바로
         * 그 상태를 보이게 하는 것이므로, 그 창은 진단의 빈틈 중 가장 나쁜 쪽이다.
         */
        try {
            const attempt = deps.coordinator.tick({
                trigger,
                // 이 tick 의 순간에 물어본다 — 이전 tick 의 답을 재사용하지 않는다.
                idle: deps.idle(),
                now: deps.now(),
            });
            running = attempt;
            const result = await attempt;
            const outcome = classify(result);
            report(() => deps.onTick?.({ trigger, ...outcome }));
            return result;
        } catch (error) {
            /*
             * 거절도 사실이다. 예전에는 `onTick` 이 `await` **뒤에만** 있었고
             * 주기 경로가 예외를 삼켜서, coordinator 가 던지면 아무 줄도 남지
             * 않았다 — 무장 실패·걸림·거절이 한 침묵으로 보였다. 코드나 메시지는
             * 싣지 않는다: 그것은 던진 쪽의 것이다.
             */
            report(() => deps.onTick?.({ trigger, kind: 'errored' }));
            throw error;
        } finally {
            running = null;
        }
    };

    const arm = (): void => {
        if (stopping || armed !== null) return;
        armed = setTimer(() => {
            armed = null;
            /*
             * 도는 중이면 **시작하지 않는다.**
             *
             * `tickNow` 로 들어온 시도가 진행 중일 때 주기 tick 이 그냥 들어가면
             * coordinator 가 in-flight 로 거절하고 곧바로 정산되는데, 그 정산의
             * `finally` 가 **원래 시도의** 핸들을 지운다. 그러면 `stop()` 은
             * 기다릴 것이 없다고 보고하고 — 업로드 중인 checkpoint 를 두고
             * `pendingPublication: false` 라고 말한다. 소유권은 진행 중인 시도의
             * 것이고, 시계는 그것이 정산된 뒤에 다시 건다.
             */
            const inFlight = running;
            if (inFlight !== null) {
                void inFlight.catch(() => undefined).finally(() => arm());
                return;
            }
            /*
             * 시계를 **정산 뒤에** 다시 건다. 앞의 시도가 drain 을 들고 있는 동안
             * 다음 tick 이 들어오면 그 거절은 runtime 에 대해 아무것도 말하지 않는
             * 잡음이다.
             */
            void runTick('periodic')
                .catch(() => undefined)
                .finally(() => arm());
        }, deps.intervalMs);
    };

    return {
        start() {
            arm();
        },

        async tickNow(trigger) {
            // 이미 도는 중이면 두 번째를 만들지 않는다 — 겹친 시도는 서로를 거절한다.
            if (running !== null) return { ticked: false };
            if (stopping) return { ticked: false };
            const result = await runTick(trigger).catch(() => null);
            return result === null ? { ticked: false } : { ticked: true, result };
        },

        async stop() {
            stopping = true;
            if (armed !== null) {
                clearTimer(armed);
                armed = null;
            }
            const inFlight = running;
            if (inFlight === null) return { pendingPublication: false };
            /*
             * 업로드는 끝났는데 pointer 를 못 실은 checkpoint 는 **존재하지만 아무도
             * 찾을 수 없는** 것이다. 그래서 기다린다 — 다만 무한히는 아니다.
             * 시한을 넘기면 숨기지 않고 사실로 보고한다.
             */
            const timedOut = Symbol('timeout');
            const guard = new Promise<typeof timedOut>((resolve) => {
                const handle = setTimer(() => resolve(timedOut), deps.shutdownWaitMs);
                void inFlight.catch(() => undefined).finally(() => clearTimer(handle));
            });
            const settled = await Promise.race([
                inFlight.then(() => 'settled' as const).catch(() => 'settled' as const),
                guard,
            ]);
            return { pendingPublication: settled === timedOut };
        },
    };
}

/**
 * The loop that makes checkpoints happen at all.
 *
 * The coordinator is a double here on purpose: what is under test is *when* it
 * is asked, that it is never asked twice at once, and what happens to an
 * attempt that is still running when the runtime shuts down. Its own decisions
 * have their own file.
 */
import { describe, expect, it } from 'vitest';

import type { RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

import { createManagedCheckpointTickLoop } from './managedCheckpointTickLoop';
import type { CheckpointTickResult, ManagedCheckpointCoordinator } from './managedCheckpointCoordinator';
import type { CheckpointTrigger } from './managedCheckpointSchedule';

const idle: RuntimeIdleDecision = { state: 'idle', forMs: 1 };
const saved: CheckpointTickResult = {
    attempted: true, saved: true, checkpointId: 'a'.repeat(64),
};
const skipped: CheckpointTickResult = {
    attempted: false, decision: { take: false, reason: 'not-due' },
};

/** A hand-driven timer, so the schedule is asserted rather than waited for. */
function fakeTimers() {
    const queue: { id: number; fn: () => void; ms: number }[] = [];
    let next = 1;
    return {
        setTimer: (fn: () => void, ms: number) => {
            const id = next += 1;
            queue.push({ id, fn, ms });
            return id;
        },
        clearTimer: (handle: NodeJS.Timeout | number) => {
            const index = queue.findIndex((entry) => entry.id === handle);
            if (index >= 0) queue.splice(index, 1);
        },
        pending: () => queue.map((entry) => entry.ms),
        fire: () => {
            const entry = queue.shift();
            entry?.fn();
        },
    };
}

/**
 * A tick that only settles when told to.
 *
 * Held in an object rather than a `let`: a closure assignment inside the
 * executor is invisible to narrowing, and `release?.()` then reads as `never`.
 */
function heldTick(result: CheckpointTickResult) {
    const held: { release: (() => void) | null } = { release: null };
    return {
        held,
        tick: () => new Promise<CheckpointTickResult>((resolve) => {
            held.release = () => resolve(result);
        }),
    };
}

function loopWith(options: {
    tick?: (input: { trigger: CheckpointTrigger }) => Promise<CheckpointTickResult>;
    idle?: () => RuntimeIdleDecision;
    shutdownWaitMs?: number;
    onTickThrows?: boolean;
} = {}) {
    const timers = fakeTimers();
    const seen: { trigger: CheckpointTrigger; idle: RuntimeIdleDecision }[] = [];
    const ticks: { trigger: CheckpointTrigger; kind: string; reason?: string }[] = [];
    const started: { trigger: CheckpointTrigger }[] = [];
    const coordinator: ManagedCheckpointCoordinator = {
        tick: async (input) => {
            seen.push({ trigger: input.trigger, idle: input.idle });
            return options.tick ? options.tick(input) : skipped;
        },
        checkpointState: () => ({ saved: false, reason: 'never' }),
        scheduleState: () => ({ consecutiveFailures: 0 }),
    };
    const loop = createManagedCheckpointTickLoop({
        coordinator,
        intervalMs: 60_000,
        idle: options.idle ?? (() => idle),
        now: () => 1_000,
        onTick: (outcome) => {
            ticks.push(outcome);
            // 진단이 본 작업을 죽이면 아무도 진단을 켜 두지 않는다.
            if (options.onTickThrows === true) throw new Error('observer failed');
        },
        onTickStart: (outcome) => started.push(outcome),
        shutdownWaitMs: options.shutdownWaitMs ?? 5_000,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
    });
    return { loop, timers, seen, ticks, started };
}

describe('asking for checkpoints on a schedule', () => {
    it('arms nothing until it is started, and then asks at the configured interval', async () => {
        const { loop, timers, seen } = loopWith();
        expect(timers.pending()).toEqual([]);
        loop.start();
        expect(timers.pending()).toEqual([60_000]);
        timers.fire();
        await Promise.resolve();
        await Promise.resolve();
        expect(seen.map((entry) => entry.trigger)).toEqual(['periodic']);
    });

    it('re-arms only after a tick settles, so a slow checkpoint cannot stack', async () => {
        /*
         * 앞의 시도가 drain 을 들고 있는 동안 다음 tick 이 들어오면 그 거절은
         * runtime 에 대해 아무것도 말하지 않는다. 시계는 정산 뒤에 다시 건다.
         */
        const { held, tick } = heldTick(saved);
        const { loop, timers, seen } = loopWith({ tick });
        loop.start();
        timers.fire();
        await Promise.resolve();
        expect(seen).toHaveLength(1);
        // 아직 정산되지 않았다 — 다음 tick 이 걸려 있지 않아야 한다.
        expect(timers.pending()).toEqual([]);
        held.release?.();
        // 정산 → onTick → finally 체인이 모두 돌 때까지.
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        expect(timers.pending()).toEqual([60_000]);
    });

    it('does not let a scheduled tick take over an attempt already running', async () => {
        /*
         * 주기 tick 이 `tickNow` 로 시작된 시도 위로 그냥 들어가면 coordinator 가
         * in-flight 로 거절하고 곧바로 정산되는데, 그 정산이 **원래 시도의**
         * 핸들을 지운다. 그러면 `stop()` 은 기다릴 것이 없다고 보고한다 —
         * 업로드 중인 checkpoint 를 두고 `pendingPublication: false` 라고.
         */
        const { held, tick } = heldTick(saved);
        const { loop, timers, seen } = loopWith({ tick });
        loop.start();
        const running = loop.tickNow('turn-boundary');
        await Promise.resolve();
        expect(seen).toHaveLength(1);

        // 시계가 울린다 — 시도는 아직 돌고 있다.
        timers.fire();
        await Promise.resolve();
        // 두 번째 시도를 만들지 않았다.
        expect(seen).toHaveLength(1);

        // 그리고 소유권은 그대로다: stop 은 진행 중인 것을 기다린다.
        const stopping = loop.stop();
        await Promise.resolve();
        held.release?.();
        await running;
        expect(await stopping).toEqual({ pendingPublication: false });
    });

    it('re-arms once the attempt it deferred to has settled', async () => {
        const { held, tick } = heldTick(saved);
        const { loop, timers } = loopWith({ tick });
        loop.start();
        void loop.tickNow('turn-boundary');
        await Promise.resolve();
        timers.fire();
        await Promise.resolve();
        // 미룬 것이지 포기한 것이 아니다 — 아직 걸린 시계는 없다.
        expect(timers.pending()).toEqual([]);
        held.release?.();
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        expect(timers.pending()).toEqual([60_000]);
    });

    it('asks the runtime for idle at each tick rather than reusing an answer', async () => {
        const answers: RuntimeIdleDecision[] = [
            { state: 'active', because: ['turn-running'] },
            { state: 'idle', forMs: 5 },
        ];
        const { loop, seen } = loopWith({ idle: () => answers.shift() ?? idle });
        await loop.tickNow('turn-boundary');
        await loop.tickNow('turn-boundary');
        expect(seen.map((entry) => entry.idle.state)).toEqual(['active', 'idle']);
    });

    it('does not synthesise an idle decision the runtime could not make', async () => {
        // 판단 못 한 답은 그대로 흘려보낸다 — 여기서 idle 로 바꾸면 도는 턴 위에서
        // 체크포인트를 찍게 된다.
        const undecidable: RuntimeIdleDecision = { state: 'undecidable', reason: 'no-policy' };
        const { loop, seen } = loopWith({ idle: () => undecidable });
        await loop.tickNow('periodic');
        expect(seen[0].idle).toEqual(undecidable);
    });

    it('refuses a second tick while one is running', async () => {
        const { held, tick } = heldTick(saved);
        const { loop, seen } = loopWith({ tick });
        const first = loop.tickNow('turn-boundary');
        await Promise.resolve();
        expect(await loop.tickNow('turn-boundary')).toEqual({ ticked: false });
        held.release?.();
        expect((await first).ticked).toBe(true);
        expect(seen).toHaveLength(1);
    });

    it('names a recognised failure code, so a failed attempt is actionable', async () => {
        /*
         * The first live run that got past the quiescence gate settled as
         * `failed` with nothing after it, and "it did not save" is not something
         * anyone can act on — a refused presign, an unreachable store, a pointer
         * race and a full disk each need a different response.
         *
         * The coordinator's detail is `String(error.code)`, which is why it may
         * not travel as-is. What travels is a code from a closed set.
         */
        const { loop, ticks } = loopWith({
            tick: async () => ({ attempted: true, saved: false, detail: 'pointer-conflict' }),
        });
        await loop.tickNow('periodic');
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'failed', detail: 'pointer-conflict' }]);
    });

    it('names a store failure and the stage it happened in', async () => {
        /*
         * `upload-failed` (the store's own word) and `stage-archive` (the stage a
         * plain `Error` happened in) were both missing from the closed set, so
         * the two most likely failures arrived as `unclassified` or as the
         * coordinator's catch-all. Those are the codes a failed checkpoint is
         * acted on by.
         */
        for (const detail of ['upload-failed', 'verify-failed', 'stage-archive']) {
            const { loop, ticks } = loopWith({
                tick: async () => ({ attempted: true, saved: false, detail }),
            });
            await loop.tickNow('periodic');
            expect(ticks).toEqual([{ trigger: 'periodic', kind: 'failed', detail }]);
        }
    });

    it('names a transport code from the closed set too', async () => {
        // 무엇이 막혔는지가 store 축에서는 대개 이 코드들이다.
        const { loop, ticks } = loopWith({
            tick: async () => ({ attempted: true, saved: false, detail: 'ECONNREFUSED' }),
        });
        await loop.tickNow('periodic');
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'failed', detail: 'ECONNREFUSED' }]);
    });

    it('says a code was present but unrecognised rather than echoing it', async () => {
        /*
         * `code` is not an enum: a library can put anything there, including a
         * path or a URL. An unknown one is reported as *having happened* without
         * being repeated — which also tells us the closed set needs extending.
         */
        const { loop, ticks } = loopWith({
            tick: async () => ({
                attempted: true, saved: false, detail: 'Failed to fetch https://store/secret?sig=abc',
            }),
        });
        await loop.tickNow('periodic');
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'failed', detail: 'unclassified' }]);
        expect(JSON.stringify(ticks)).not.toContain('sig=abc');
    });

    it('reports a failure as a bare classifier, never the dependency code it carries', async () => {
        /*
         * 실패의 `detail` 은 던진 쪽의 `error.code` 를 문자열화한 것이다 — 닫힌
         * 집합이 아니다. 그래서 이 보고에는 싣지 않는다. 전체 결과는 tickNow 의
         * 반환값으로 그대로 간다.
         */
        const { loop, ticks } = loopWith({
            tick: async () => ({ attempted: true, saved: false, detail: 'ENOSPC /var/tmp/x' }),
        });
        const outcome = await loop.tickNow('periodic');
        /*
         * `ENOSPC /var/tmp/x` is not a code — it is a code with a path stuck to
         * it, which is exactly what must not travel. The bare `ENOSPC` is in the
         * closed set; this string is not, so it is reported as present and
         * nothing more.
         */
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'failed', detail: 'unclassified' }]);
        expect(JSON.stringify(ticks)).not.toContain('/var/tmp/x');
        // 진단은 사라지지 않는다 — 호출자에게 그대로 간다.
        expect(outcome.result).toEqual({ attempted: true, saved: false, detail: 'ENOSPC /var/tmp/x' });
    });

    it('carries the skip reason, which is the coordinator own closed enum', async () => {
        const { loop, ticks } = loopWith();
        await loop.tickNow('periodic');
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'skipped', reason: 'not-due' }]);
    });

    it('carries the gate own refusal alongside the reason, because the reason alone is unactionable', async () => {
        /*
         * `provider-state-unproven` says a proof did not hold; it does not say
         * **which** step. The four answers need four different responses — an
         * ACK that was not `exhausted-clean`, an exit nobody observed, writers
         * still holding the state open, a generation nothing can account for —
         * and the first live run of this path could not be acted on because the
         * line stopped at the reason.
         *
         * The gate's refusals are a closed enum, so forwarding one carries no
         * message, path or dependency text.
         */
        const { loop, ticks } = loopWith({
            tick: async () => ({
                attempted: false,
                decision: { take: false, reason: 'provider-state-unproven', detail: 'exit-unobserved' },
            } as unknown as CheckpointTickResult),
        });
        await loop.tickNow('periodic');
        expect(ticks).toEqual([{
            trigger: 'periodic', kind: 'skipped', reason: 'provider-state-unproven', detail: 'exit-unobserved',
        }]);
    });

    it('drops a detail that is a dependency code rather than a closed refusal', async () => {
        /*
         * `quiescence-unavailable`'s detail is `String(error.code)` from whatever
         * threw — `code` is not an enum, and an http client or a store can put an
         * arbitrary string on it. The reason travels; the detail does not.
         */
        const { loop, ticks } = loopWith({
            tick: async () => ({
                attempted: false,
                decision: { take: false, reason: 'quiescence-unavailable', detail: 'ENOSPC /var/tmp/x' },
            } as unknown as CheckpointTickResult),
        });
        await loop.tickNow('periodic');
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'skipped', reason: 'quiescence-unavailable' }]);
        expect(JSON.stringify(ticks)).not.toContain('ENOSPC');
    });

    it('carries a skip reason without inventing one when there is none', async () => {
        const { loop, ticks } = loopWith({
            tick: async () => ({ attempted: false, decision: { take: false } } as unknown as CheckpointTickResult),
        });
        await loop.tickNow('periodic');
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'skipped' }]);
    });
});

describe('saying what happened, so silence means one thing', () => {
    /*
     * `onTick` was only called **after** the await, and the scheduled path
     * swallowed rejections — so a coordinator that threw produced no event at
     * all. Root's probe of this loop measured it: `invocations 1, timerArms 2,
     * diagnosticEvents 0`. Three different states then looked identical from
     * outside: the loop never armed, a tick is hung, and a tick was rejected.
     * A diagnostic that cannot tell those apart is the same as none.
     */
    it('reports a rejected tick as a closed classifier instead of nothing', async () => {
        const { loop, timers, ticks, started } = loopWith({
            tick: async () => { throw Object.assign(new Error('boom'), { code: 'ENOSPC' }); },
        });
        loop.start();
        timers.fire();
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

        expect(started).toEqual([{ trigger: 'periodic' }]);
        // 던진 쪽의 코드는 싣지 않는다 — 닫힌 분류자 하나다.
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'errored' }]);
        expect(JSON.stringify(ticks)).not.toContain('ENOSPC');
        // 그리고 시계는 다시 걸린다: 거절 하나가 소비자를 멈추지 않는다.
        expect(timers.pending()).toEqual([60_000]);
    });

    it('separates a rejected tick from an attempt the coordinator reported failed', async () => {
        // 둘은 다른 사실이다. `failed` 는 coordinator 가 답한 것이고 `errored` 는
        // 그것이 답하지 못한 것이다 — 합치면 어느 쪽인지 알 수 없다.
        const { loop, ticks } = loopWith({
            tick: async () => ({ attempted: true, saved: false, detail: 'checkpoint-failed' }),
        });
        await loop.tickNow('periodic');
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'failed', detail: 'checkpoint-failed' }]);
    });

    it('marks the start of a tick, so a hung one is not silence', async () => {
        const { loop, timers, ticks, started } = loopWith({
            tick: () => new Promise<CheckpointTickResult>(() => {}),
        });
        loop.start();
        timers.fire();
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        // 시작은 남고 정산은 없다 — 그것이 "걸려 있다" 의 모양이다.
        expect(started).toEqual([{ trigger: 'periodic' }]);
        expect(ticks).toEqual([]);
        // 걸린 시도가 소유권을 들고 있으니 다음 시계는 걸리지 않는다.
        expect(timers.pending()).toEqual([]);
    });

    it('reports a coordinator that throws before it returns a promise', async () => {
        /*
         * 동기 throw 는 `await` 이 아니라 호출 자체에서 난다 — coordinator 가
         * promise 를 만들기 전에 던지거나, `idle()`/`now()` 가 던지는 경우다.
         * 그 호출이 `try` 밖에 있으면 catch 를 지나쳐서 이벤트가 하나도 안 나가고,
         * 그러면 진단이 정확히 보여야 할 상태에서 침묵한다.
         */
        const timers = fakeTimers();
        const ticks: { trigger: CheckpointTrigger; kind: string }[] = [];
        const loop = createManagedCheckpointTickLoop({
            coordinator: {
                tick: () => { throw new Error('/private/path leaked?'); },
                checkpointState: () => ({ saved: false, reason: 'never' }),
                scheduleState: () => ({ consecutiveFailures: 0 }),
            } as unknown as ManagedCheckpointCoordinator,
            intervalMs: 60_000,
            idle: () => idle,
            now: () => 1_000,
            onTick: (outcome) => ticks.push(outcome),
            shutdownWaitMs: 5_000,
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });
        expect(await loop.tickNow('turn-boundary')).toEqual({ ticked: false });
        expect(ticks).toEqual([{ trigger: 'turn-boundary', kind: 'errored' }]);
        // 던진 쪽의 문자열은 어디에도 없다.
        expect(JSON.stringify(ticks)).not.toContain('/private/path');
    });

    it('reports it when the runtime idle decision itself throws', async () => {
        const timers = fakeTimers();
        const ticks: { trigger: CheckpointTrigger; kind: string }[] = [];
        const loop = createManagedCheckpointTickLoop({
            coordinator: {
                tick: async () => saved,
                checkpointState: () => ({ saved: false, reason: 'never' }),
                scheduleState: () => ({ consecutiveFailures: 0 }),
            } as unknown as ManagedCheckpointCoordinator,
            intervalMs: 60_000,
            idle: () => { throw new Error('activity source unavailable'); },
            now: () => 1_000,
            onTick: (outcome) => ticks.push(outcome),
            shutdownWaitMs: 5_000,
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer,
        });
        expect(await loop.tickNow('periodic')).toEqual({ ticked: false });
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'errored' }]);
    });

    it('keeps working when an observer throws', async () => {
        // 진단은 실패해도 본 작업을 막지 않는다.
        const { loop, timers } = loopWith({ onTickThrows: true });
        loop.start();
        timers.fire();
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        expect(timers.pending()).toEqual([60_000]);
        expect((await loop.tickNow('turn-boundary')).ticked).toBe(true);
    });
});

describe('shutting down', () => {
    it('stops arming, and reports nothing pending when no attempt is running', async () => {
        const { loop, timers } = loopWith();
        loop.start();
        expect(await loop.stop()).toEqual({ pendingPublication: false });
        expect(timers.pending()).toEqual([]);
    });

    it('waits for an attempt in flight rather than leaving a pointer unpublished', async () => {
        /*
         * 업로드는 끝났는데 pointer 를 못 실은 checkpoint 는 존재하지만 아무도
         * 찾을 수 없다. 그래서 기다린다.
         */
        const { held, tick } = heldTick(saved);
        const { loop, timers } = loopWith({ tick });
        const running = loop.tickNow('turn-boundary');
        await Promise.resolve();
        const stopping = loop.stop();
        await Promise.resolve();
        held.release?.();
        await running;
        expect(await stopping).toEqual({ pendingPublication: false });
        // 종료를 붙잡을 시계는 남지 않는다.
        expect(timers.pending()).toEqual([]);
    });

    it('says so when the attempt outlasts the wait, instead of hiding it', async () => {
        const { loop, timers } = loopWith({
            // 끝나지 않는 시도 — 매달린 업로드.
            tick: () => new Promise<CheckpointTickResult>(() => {}),
            shutdownWaitMs: 100,
        });
        void loop.tickNow('turn-boundary');
        await Promise.resolve();
        const stopping = loop.stop();
        await Promise.resolve();
        // 시한 타이머를 발화시킨다.
        timers.fire();
        expect(await stopping).toEqual({ pendingPublication: true });
    });

    it('refuses new ticks once stopping', async () => {
        const { loop } = loopWith();
        await loop.stop();
        expect(await loop.tickNow('turn-boundary')).toEqual({ ticked: false });
    });
});

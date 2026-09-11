/**
 * The consumer, as the boot actually composes it.
 *
 * Everything below the loop is the product: the real target inbox, the real
 * coordinator, the real runner and the real publisher. Only the object store is
 * a fake `fetchImpl`. What is asserted is that a target the parent pushed into
 * **that** inbox becomes a checkpoint on the store because something ticked,
 * and that the inbox is settled with the ending that actually happened.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MANAGED_WRITE_TOOLS } from '@/launcher/managedToolCatalogue';

import { createManagedCheckpointCoordinator } from './managedCheckpointCoordinator';
import { createManagedCheckpointRunner } from './managedCheckpointRunner';
import { createManagedCheckpointTargetInbox } from './managedCheckpointTargetInbox';
import {
    MANAGED_RUNTIME_IDLE_UNKNOWN,
    drainManagedCheckpointTicksOnSignal,
    startManagedCheckpointTicks,
} from './managedCheckpointTicks';
import type { ManagedCheckpointTickLoop } from './managedCheckpointTickLoop';

const created: string[] = [];
const key = randomBytes(32);
const tenant = { tenantId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-ticks-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

function fakeStore(options: { refusePointer?: boolean } = {}) {
    const objects = new Map<string, Buffer>();
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'PUT') {
            if (options.refusePointer === true && path.endsWith('latest.json')) {
                // 업로드는 끝났는데 pointer 를 못 실었다 — store 에 바이트가
                // 남아 있고, 무엇이 남았는지는 여기서 알 수 없다.
                return new Response(null, { status: 500 });
            }
            const chunks: Buffer[] = [];
            const body = init?.body;
            if (typeof body === 'string') chunks.push(Buffer.from(body));
            else if (body) for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
                chunks.push(Buffer.from(chunk));
            }
            objects.set(path, Buffer.concat(chunks));
            return new Response(null, {
                status: 200,
                headers: { etag: `"${createHash('md5').update(objects.get(path)!).digest('hex')}"` },
            });
        }
        const stored = objects.get(path);
        if (!stored) return new Response(null, { status: 404 });
        const etag = `"${createHash('md5').update(stored).digest('hex')}"`;
        if (method === 'HEAD') {
            return new Response(null, { status: 200, headers: { 'content-length': String(stored.length), etag } });
        }
        return new Response(stored, { status: 200, headers: { etag } });
    };
    return { objects, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch };
}

function delivery(checkpointId: string, expiresAt: number) {
    const object = `https://store.invalid/${checkpointId}/project.enc`;
    const manifest = `https://store.invalid/${checkpointId}/manifest.enc`;
    return {
        checkpointId,
        key,
        expiresAt,
        targets: {
            objects: new Map([['project' as const, { putUrl: object, headUrl: object }]]),
            manifest: { putUrl: manifest, headUrl: manifest },
            pointer: { putUrl: 'https://store.invalid/latest.json', getUrl: 'https://store.invalid/latest.json' },
        },
    };
}

/** A hand-driven clock, so the schedule is asserted rather than waited for. */
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
        fire: () => { queue.shift()?.fn(); },
    };
}

/** The boot's composition: one inbox, read by the coordinator the loop ticks. */
async function runtime(options: {
    schedule?: { periodMs: number; onTurnBoundary: boolean } | null;
    /** The observer has not answered yet — a checkpoint may not be bound. */
    unobservedVolume?: boolean;
    refusePointer?: boolean;
} = {}) {
    const observed = options.unobservedVolume === true ? null : volume;
    const store = fakeStore(options.refusePointer === true ? { refusePointer: true } : {});
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    const expired: string[] = [];
    const inbox = createManagedCheckpointTargetInbox({
        now: () => 1_000,
        onExpired: ({ checkpointId }) => expired.push(checkpointId),
    });
    const runner = createManagedCheckpointRunner({
        tenant, volume: () => observed, image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root }],
        workDir: join(await scratch(), 'work'),
        drainBudgetMs: 1000,
        writeTools: MANAGED_WRITE_TOOLS,
        flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        now: () => 1,
        fetchImpl: store.fetchImpl,
    });
    const seenIdle: unknown[] = [];
    const coordinator = createManagedCheckpointCoordinator({
        runner,
        targets: inbox,
        volume: () => observed,
        policy: options.schedule === undefined
            ? { periodMs: 300_000, onTurnBoundary: true }
            : options.schedule,
    });
    const timers = fakeTimers();
    const ticks: { trigger: string; kind: string; reason?: string; detail?: string }[] = [];
    const loop = startManagedCheckpointTicks({
        coordinator: {
            tick: (input) => { seenIdle.push(input.idle); return coordinator.tick(input); },
            checkpointState: () => coordinator.checkpointState(),
            scheduleState: () => coordinator.scheduleState(),
        },
        schedule: options.schedule === undefined
            ? { periodMs: 300_000, onTurnBoundary: true }
            : options.schedule,
        shutdownWaitMs: 5_000,
        onTick: (outcome) => ticks.push(outcome),
        now: () => 1_000,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
    });
    return { inbox, coordinator, loop, store, timers, ticks, expired, seenIdle };
}

describe('the runtime checkpoint consumer, as the boot composes it', () => {
    it('shouldCheckpointATargetPushedIntoTheSameInboxWhenTheScheduleFires', async () => {
        const { inbox, loop, store, timers, ticks } = await runtime();
        expect(loop).not.toBeNull();
        // 부모가 밀어 넣는다 — coordinator 가 읽는 그 inbox 다.
        expect(inbox.accept(delivery('a'.repeat(64), 2_000))).toEqual({ accepted: true, state: 'queued' });

        // The schedule was armed by `start()`, at the marker's period.
        expect(timers.pending()).toEqual([300_000]);
        timers.fire();
        /*
         * 정산을 기다린다 — `stop()` 이 진행 중인 시도를 기다리는 그 경로다.
         * microtask 몇 번으로 대신하면 실제 archive/upload 를 기다리지 않은 채
         * 통과하는 시험이 된다.
         */
        expect(await loop!.stop()).toEqual({ pendingPublication: false });

        // It really landed: the pointer is on the store.
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(true);
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'saved' }]);
        // And the inbox knows how it ended: a re-delivery of the same id is
        // answered `completed` rather than queued again.
        expect(inbox.accept(delivery('a'.repeat(64), 2_000))).toEqual({ accepted: true, state: 'completed' });
    });

    it('shouldSkipWithoutTouchingTheStoreWhenTheParentHasIssuedNoTarget', async () => {
        const { loop, store, timers, ticks } = await runtime();
        timers.fire();
        await loop!.stop();
        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'skipped', reason: 'no-targets' }]);
        expect(store.objects.size).toBe(0);
    });

    it('shouldLeaveTheTargetQueuedWhenTheVolumeHasNotBeenObserved', async () => {
        /*
         * 관측되지 않은 volume 에는 archive 를 묶을 수 없다. runner 에 들어가기
         * 전에 멈추므로 아무것도 store 에 닿지 않고, 그래서 그 target 은
         * 그대로 큐에 남아 다음 tick 이 쓸 수 있다.
         */
        const { inbox, loop, store, timers, ticks } = await runtime({ unobservedVolume: true });
        inbox.accept(delivery('b'.repeat(64), 2_000));
        timers.fire();
        await loop!.stop();

        expect(ticks).toEqual([{ trigger: 'periodic', kind: 'skipped', reason: 'volume-unobserved' }]);
        expect(store.objects.size).toBe(0);
        // 소비되지 않았다 — 자격은 아직 여기 있다.
        expect(inbox.pending()).toBe(true);
    });

    it('shouldTellTheCoordinatorItCannotDecideIdleRatherThanClaimingItIsIdle', async () => {
        /*
         * 이 runtime 에는 활동 수집기도 idle 정책도 없다. `idle` 을 지어내면
         * 돌아가는 턴 위에서 체크포인트를 찍게 되고, `active` 를 지어내면
         * 영원히 안 찍는다. 모른다는 답을 그대로 보낸다.
         */
        const { loop, timers, seenIdle } = await runtime();
        timers.fire();
        await loop!.stop();
        expect(seenIdle).toEqual([{ state: 'undecidable', reason: 'no-policy' }]);
        expect(MANAGED_RUNTIME_IDLE_UNKNOWN).toEqual({ state: 'undecidable', reason: 'no-policy' });
    });

    it('shouldHoldTheIdForVerificationWhenTheAttemptLeftBytesButNoPointer', async () => {
        /*
         * 세 가지 결말이 각각 다른 것을 뜻한다. `published` 는 끝, `unstarted` 는
         * id 를 돌려주고, `uncertain` 은 **아무도 모른다** — 객체는 `ifAbsent` 로
         * 올라갔으니 같은 id 로 다시 돌리면 자기 바이트에 412 로 막히고, pointer
         * 는 실렸을 수도 아닐 수도 있다. 그래서 그 id 는 사람이 볼 때까지 잡아
         * 둔다.
         */
        const { inbox, loop, store, timers, ticks } = await runtime({ refusePointer: true });
        inbox.accept(delivery('d'.repeat(64), 2_000));
        timers.fire();
        await loop!.stop();

        // 업로드는 됐고 pointer PUT 이 500 이었으니, coordinator 가 남긴 코드는
        // 그 마지막 실패의 것이다 — 닫힌 집합에 있으면 그대로 실린다.
        expect(ticks).toHaveLength(1);
        expect(ticks[0]).toMatchObject({ trigger: 'periodic', kind: 'failed' });
        expect(typeof ticks[0].detail).toBe('string');
        // 바이트는 남았다 — 그것이 `unstarted` 가 아닌 이유다.
        expect(store.objects.size).toBeGreaterThan(0);
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
        expect(inbox.accept(delivery('d'.repeat(64), 2_000)))
            .toEqual({ accepted: true, state: 'needs-verification' });
    });

    it('shouldTickNothingWhenTheMarkerCarriesNoSchedule', async () => {
        // 아무 주기도 지어내지 않는다: 설정이 없으면 소비자도 없다.
        const { loop, timers, store } = await runtime({ schedule: null });
        expect(loop).toBeNull();
        expect(timers.pending()).toEqual([]);
        expect(store.objects.size).toBe(0);
    });
});

describe('stopping the consumer when the machine is stopped', () => {
    function fakeProcess() {
        const listeners = new Map<string, (() => void)[]>();
        const killed: string[] = [];
        return {
            killed,
            raise: (signal: NodeJS.Signals) => {
                for (const handler of listeners.get(signal) ?? []) handler();
            },
            listenerCount: (signal: NodeJS.Signals) => (listeners.get(signal) ?? []).length,
            target: {
                pid: 4242,
                on: (signal: NodeJS.Signals, handler: () => void) => {
                    listeners.set(signal, [...(listeners.get(signal) ?? []), handler]);
                },
                removeListener: (signal: NodeJS.Signals, handler: () => void) => {
                    listeners.set(signal, (listeners.get(signal) ?? []).filter((entry) => entry !== handler));
                },
                kill: (pid: number, signal: NodeJS.Signals) => { killed.push(`${pid}:${signal}`); },
            },
        };
    }

    function loopDouble(stop: () => Promise<{ pendingPublication: boolean }>): ManagedCheckpointTickLoop {
        return { start: () => {}, tickNow: async () => ({ ticked: false }), stop };
    }

    it('shouldWaitForThePublicationAndThenReRaiseTheSignalItself', async () => {
        const host = fakeProcess();
        let released!: () => void;
        const stopped = new Promise<{ pendingPublication: boolean }>((resolve) => {
            released = () => resolve({ pendingPublication: false });
        });
        const reported: { signal: string; pendingPublication: boolean }[] = [];
        drainManagedCheckpointTicksOnSignal({
            ticks: loopDouble(() => stopped),
            onStopped: (outcome) => reported.push(outcome),
            process: host.target,
        });

        host.raise('SIGTERM');
        // 기다리는 동안은 아직 아무것도 죽이지 않는다.
        expect(host.killed).toEqual([]);
        released();
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

        expect(reported).toEqual([{ signal: 'SIGTERM', pendingPublication: false }]);
        // 자기 handler 를 뗀 뒤 같은 신호를 다시 올린다 — 기본 동작이 적용된다.
        expect(host.killed).toEqual(['4242:SIGTERM']);
        expect(host.listenerCount('SIGTERM')).toBe(0);
        expect(host.listenerCount('SIGINT')).toBe(0);
    });

    it('shouldReportAPublicationLeftPendingRatherThanHidingIt', async () => {
        const host = fakeProcess();
        const reported: { pendingPublication: boolean }[] = [];
        drainManagedCheckpointTicksOnSignal({
            ticks: loopDouble(async () => ({ pendingPublication: true })),
            onStopped: (outcome) => reported.push({ pendingPublication: outcome.pendingPublication }),
            process: host.target,
        });
        host.raise('SIGINT');
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
        expect(reported).toEqual([{ pendingPublication: true }]);
        expect(host.killed).toEqual(['4242:SIGINT']);
    });

    it('shouldTreatAFailedStopAsAPublicationLeftUnsettled', async () => {
        const host = fakeProcess();
        const reported: { pendingPublication: boolean }[] = [];
        drainManagedCheckpointTicksOnSignal({
            ticks: loopDouble(async () => { throw new Error('stop failed'); }),
            onStopped: (outcome) => reported.push({ pendingPublication: outcome.pendingPublication }),
            process: host.target,
        });
        host.raise('SIGTERM');
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
        expect(reported).toEqual([{ pendingPublication: true }]);
        // 그래도 신호는 지나간다: 못 죽는 runtime 을 만들지 않는다.
        expect(host.killed).toEqual(['4242:SIGTERM']);
    });

    it('shouldInstallNothingWhenThereIsNoConsumerToWaitFor', () => {
        // 기다릴 것이 없으면 이 프로세스의 신호 동작을 바꾸지 않는다.
        const host = fakeProcess();
        drainManagedCheckpointTicksOnSignal({ ticks: null, process: host.target });
        expect(host.listenerCount('SIGTERM')).toBe(0);
        expect(host.listenerCount('SIGINT')).toBe(0);
    });
});

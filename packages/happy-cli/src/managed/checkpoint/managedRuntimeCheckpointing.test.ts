/**
 * The boot's lifecycle, in the one place it can be executed.
 *
 * The production `startSupervisor` needs root, cgroups and a listening socket,
 * so the order it brings checkpointing up in used to be asserted by reading it.
 * Here the sequence itself is under test, over a **real** composed checkpoint
 * session — real inbox, real coordinator, real runner, real publisher, real
 * drain — with only the supervisor and the object store standing in.
 *
 * What matters is not that four calls happen but that they happen in an order,
 * and that the drain the gate is given is the one the tool writers use.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSupervisorRuntime } from '@/launcher/main';
import { defaultManagedRunConfig } from '@/launcher/managedRunConfig';
import type { ManagedRuntimeIdentity } from '@/daemon/managedRuntimeIdentity';

import { createManagedCheckpointTargetInbox } from './managedCheckpointTargetInbox';
import { createManagedRuntimeCheckpointing, type CheckpointDrainObservations } from './managedRuntimeCheckpointing';
import type { ProviderQuiescenceGate } from './managedProviderQuiescence';

const created: string[] = [];
const key = randomBytes(32);
const tenant = { tenantId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };
const SCHEDULE = { periodMs: 300_000, onTurnBoundary: true };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-life-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

/** Only the axes the composition reads; the marker's own shape has its own tests. */
function identity(): ManagedRuntimeIdentity {
    return {
        isolation: {
            backend: 'fly-machines',
            provider: { uid: 10601, gid: 10601 },
            executor: { uid: 10602, gid: 10600 },
            cgroupRoot: '/sys/fs/cgroup/saycode',
        },
    } as unknown as ManagedRuntimeIdentity;
}

function fakeStore() {
    const objects = new Map<string, Buffer>();
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'PUT') {
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

/** A gate that is only ever identified, never believed. */
function gateDouble(label: string): ProviderQuiescenceGate & { label: string } {
    return {
        label,
        prove: async () => ({ quiesced: true, exitCode: 0, signal: null }),
        stillProven: () => true,
        release: async () => {},
    };
}

async function boot(options: {
    schedule?: typeof SCHEDULE | null;
    gate?: (input: { drain: CheckpointDrainObservations; endInputBudgetMs: number }) => ProviderQuiescenceGate;
} = {}) {
    const store = fakeStore();
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    const inbox = createManagedCheckpointTargetInbox({ now: () => 1_000 });
    const timers = fakeTimers();
    const events: string[] = [];
    const ticks: { trigger: string; kind: string; reason?: string }[] = [];
    const seen: { drain: unknown; endInputBudgetMs: number }[] = [];

    const checkpointing = createManagedRuntimeCheckpointing({
        shutdownWaitMs: 5_000,
        endInputBudgetMs: 30_000,
        onTick: (outcome) => ticks.push(outcome),
        now: () => 1_000,
        setTimer: (fn, ms) => { events.push('tick-armed'); return timers.setTimer(fn, ms); },
        clearTimer: timers.clearTimer,
    });

    /*
     * The composition is made **after** the reference and **before** the
     * supervisor — the same order the boot has, and the only one that works:
     * the drain the gate observes is created right here. This is the production
     * `defaultManagedRunConfig`, so `managedRun` below is the real launcher
     * config the supervisor is built from.
     */
    const composition = defaultManagedRunConfig({
        identity: identity(),
        policy: { ttlMs: 60_000, toolTimeoutMs: 5_000 },
        onUnprovenTermination: () => undefined,
        serverOrigin: 'https://provisioned.example.test',
        checkpoint: {
            tenant,
            volume: () => volume,
            image: { imageVersion: 'img@1' },
            areas: [{ area: 'project', root }],
            drainBudgetMs: 1_000,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            targets: inbox,
            policy: options.schedule === undefined ? SCHEDULE : options.schedule,
            providerQuiescence: checkpointing.gate,
            workDir: join(await scratch(), 'work'),
            fetchImpl: store.fetchImpl,
        },
    });
    const checkpoint = composition.checkpoint;

    const runtime = {
        start: async () => { events.push('start'); },
        reconcile: () => { events.push('reconcile'); },
        stop: async () => { events.push('stop'); },
        providerQuiescence: (input: { drain: CheckpointDrainObservations; endInputBudgetMs: number }) => {
            events.push('gate');
            seen.push({ drain: input.drain, endInputBudgetMs: input.endInputBudgetMs });
            return options.gate ? options.gate(input) : gateDouble('supervisor');
        },
    };

    return {
        checkpointing, checkpoint, composition, inbox, store, timers, events, ticks, seen, runtime,
        run: () => checkpointing.startAfterSupervisor({
            runtime,
            checkpoint,
            schedule: options.schedule === undefined ? SCHEDULE : options.schedule,
        }),
    };
}

describe('bringing a runtime checkpointing up', () => {
    it('shouldStartThenReconcileThenWireTheGateThenArmTheTicks', async () => {
        const booted = await boot();
        // 참조는 이미 합성에 들어가 있지만, 아직 답할 게이트가 없다.
        expect(booted.checkpointing.gate()).toBeNull();

        const loop = await booted.run();

        expect(booted.events).toEqual(['start', 'reconcile', 'gate', 'tick-armed']);
        expect(booted.checkpointing.gate()).toMatchObject({ label: 'supervisor' });
        expect(booted.timers.pending()).toEqual([SCHEDULE.periodMs]);
        await loop!.stop();
    });

    it('shouldGiveTheGateTheSameDrainTheToolWritersUse', async () => {
        /*
         * 게이트가 다른 drain 을 보면 증명은 아무것도 배제하지 못한다 — 두 게이트
         * 가 각각 자기가 조용하다고 확신하는 상태다. 모양이 아니라 **같은 객체**
         * 인지를 본다.
         */
        const booted = await boot();
        const loop = await booted.run();
        expect(booted.seen).toHaveLength(1);
        expect(booted.seen[0].drain).toBe(booted.checkpoint.checkpointDrain.drain);
        expect(booted.seen[0].endInputBudgetMs).toBe(30_000);
        await loop!.stop();
    });

    it('shouldRefuseCheckpointsWhileTheGateIsStillUnwired', async () => {
        // 배선 전에 tick 이 돌면 "아직 물을 수 없다" 다 — 게이트 없음이 아니라.
        const booted = await boot();
        booted.inbox.accept(delivery('a'.repeat(64), 2_000));
        expect(await booted.checkpoint.coordinator.tick({
            trigger: 'turn-boundary', idle: { state: 'idle', forMs: 1 }, now: 1_000_000,
        })).toEqual({
            attempted: false,
            decision: { take: false, reason: 'quiescence-unavailable', detail: 'gate-not-wired' },
        });
        // 아무것도 store 에 닿지 않았고, 그 id 는 깨끗하다 — `unstarted` 로
        // 정산됐으므로 부모가 같은 id 를 다시 보내면 그대로 큐에 들어간다.
        expect(booted.store.objects.size).toBe(0);
        expect(booted.inbox.accept(delivery('a'.repeat(64), 2_000)))
            .toEqual({ accepted: true, state: 'queued' });
    });

    it('shouldCheckpointATargetInTheSameInboxOnceTheSequenceHasRun', async () => {
        const booted = await boot();
        const loop = await booted.run();
        // 부모가 밀어 넣는 그 inbox — 합성이 읽는 것과 같은 객체다.
        booted.inbox.accept(delivery('b'.repeat(64), 2_000));

        booted.timers.fire();
        expect(await loop!.stop()).toEqual({ pendingPublication: false });

        expect(booted.ticks).toEqual([{ trigger: 'periodic', kind: 'saved' }]);
        expect(booted.store.objects.has('https://store.invalid/latest.json')).toBe(true);
        // 정산됐다: 같은 id 를 다시 보내면 큐에 들어가지 않는다.
        expect(booted.inbox.accept(delivery('b'.repeat(64), 2_000)))
            .toEqual({ accepted: true, state: 'completed' });
    });

    it('shouldFailTheBootWhenTheSupervisorCannotBuildAGate', async () => {
        /*
         * production boot 은 언제나 `managedRun` 을 넘긴다. 그러니 여기서 던진다는
         * 것은 설정이 깨졌다는 뜻이지 "통로가 없는 runtime" 이 아니다 — 그 경우는
         * 이미 거절하는 게이트라는 답이 있다. 잡아서 계속 돌면 전제 하나를 조용히
         * 잃은 채 서비스하게 되고, provider state 는 영원히 담기지 않는다.
         * 분류와 거절은 boot 의 몫이다.
         */
        const booted = await boot({
            gate: () => { throw new Error('/state/launcher.sock: no generation launcher'); },
        });

        await expect(booted.run()).rejects.toThrow(/no generation launcher/);

        // 시계는 걸리지 않았다 — 절반만 살아 있는 runtime 은 없다.
        expect(booted.timers.pending()).toEqual([]);
        // Startup cleanup belongs to the outer boot owner, which knows whether ownership was taken.
        expect(booted.events).toEqual(['start', 'reconcile', 'gate']);
        expect(booted.checkpointing.gate()).toBeNull();
    });

    it('shouldNotUndoAStartedSupervisorBecauseItsOwnDiagnosticThrew', async () => {
        /*
         * `onArmed` 는 로그로 간다. 로그 append 는 실패할 수 있고, 그 실패가
         * 여기서 던지면 **이미 서서 재조정까지 끝낸** supervisor 를 되돌리는
         * 부팅 실패가 된다 — 진단이 자기가 설명하려던 작업을 죽이는 것이다.
         * 게이트 factory 실패와는 다르다: 그것은 전제가 없다는 사실이고, 이것은
         * 그 사실을 적지 못했다는 것뿐이다.
         */
        const booted = await boot();
        const checkpointing = createManagedRuntimeCheckpointing({
            shutdownWaitMs: 5_000,
            endInputBudgetMs: 30_000,
            onArmed: () => { throw new Error('/var/log/...: append failed'); },
            setTimer: booted.timers.setTimer,
            clearTimer: booted.timers.clearTimer,
        });
        const loop = await checkpointing.startAfterSupervisor({
            runtime: booted.runtime,
            checkpoint: booted.checkpoint,
            schedule: SCHEDULE,
        });
        // 부팅은 계속되고, 소비자는 실제로 무장돼 있다.
        expect(loop).not.toBeNull();
        expect(booted.events).toEqual(['start', 'reconcile', 'gate']);
        expect(booted.timers.pending()).toEqual([SCHEDULE.periodMs]);
        await loop!.stop();
    });

    it('shouldReportWhetherAConsumerWasArmedAndAtWhatInterval', async () => {
        const armed: { intervalMs: number | null }[] = [];
        const booted = await boot();
        const checkpointing = createManagedRuntimeCheckpointing({
            shutdownWaitMs: 5_000,
            endInputBudgetMs: 30_000,
            onArmed: (outcome) => armed.push(outcome),
            setTimer: booted.timers.setTimer,
            clearTimer: booted.timers.clearTimer,
        });
        const loop = await checkpointing.startAfterSupervisor({
            runtime: booted.runtime, checkpoint: booted.checkpoint, schedule: SCHEDULE,
        });
        await loop!.stop();
        // 무장했으면 주기를, 안 했으면 `null` 을 말한다 — tick 로그가 하나도 없을
        // 때 "아직" 과 "없음" 을 가르는 유일한 줄이다.
        expect(armed).toEqual([{ intervalMs: SCHEDULE.periodMs }]);

        const none = await createManagedRuntimeCheckpointing({
            shutdownWaitMs: 5_000, endInputBudgetMs: 30_000,
            onArmed: (outcome) => armed.push(outcome),
        }).startAfterSupervisor({
            runtime: booted.runtime, checkpoint: booted.checkpoint, schedule: null,
        });
        expect(none).toBeNull();
        expect(armed).toEqual([{ intervalMs: SCHEDULE.periodMs }, { intervalMs: null }]);
    });

    it('shouldStillBringTheSupervisorUpWhenTheMarkerCarriesNoSchedule', async () => {
        // 주기가 없는 것은 checkpoint 를 안 찍는다는 뜻이지, supervisor 를 안
        // 세운다는 뜻이 아니다.
        const booted = await boot({ schedule: null });
        expect(await booted.run()).toBeNull();
        expect(booted.events).toEqual(['start', 'reconcile', 'gate']);
        expect(booted.timers.pending()).toEqual([]);
    });
});

describe('over the real supervisor runtime', () => {
    /*
     * 여기서는 `createSupervisorRuntime` 을 **실제로** 만든다. 의도한 factory 를
     * 다시 지어 보는 것은 그 메서드가 존재하고 무엇을 돌려주는지에 대해 아무것도
     * 증명하지 않는다 — 배선이 끊겨도 그런 시험은 계속 통과한다.
     *
     * 이 프로세스에는 cgroup 도 root 도 없다. 세대를 띄우지 않으므로 필요도
     * 없고, 잠금만 비-Linux 자리로 바꾼다(launcher 의 boot fixture 와 같은 방식).
     */
    async function realRuntime(booted: Awaited<ReturnType<typeof boot>>) {
        const base = await scratch();
        return createSupervisorRuntime({
            /*
             * 진짜 launcher 가 있어야 게이트가 만들어진다 — `managedRun` 없이
             * 만들면 `providerQuiescence` 는 "generation launcher 가 없다" 로
             * 던진다. 그러니 이 자리도 합성이 만든 것을 그대로 준다.
             */
            managedRun: booted.composition.managedRun,
            config: {
                cgroupRoot: '/sys/fs/cgroup/saycode',
                helperPath: '/usr/local/lib/saycode/exec-helper',
                workloadPath: '/usr/local/lib/saycode/node',
                resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
            },
            manifestRoot: join(base, 'manifest'),
            stagingRoot: join(base, 'staging'),
            socketPath: join(base, 'launcher.sock'),
            watchdogIntervalMs: 1_000,
            releaseDeadlineMs: 2_000,
            runtimeId: `checkpointing-fixture-${process.pid}`,
            acceptCheckpointTarget: (target) => booted.inbox.accept(target),
            acquireLock: async () => ({ ok: true, release: async () => {} }),
        });
    }

    it('shouldWireTheGateTheActualRuntimeMethodReturnsOverTheComposedDrain', async () => {
        const booted = await boot();
        const runtime = await realRuntime(booted);
        const loop = await booted.checkpointing.startAfterSupervisor({
            runtime,
            checkpoint: booted.checkpoint,
            schedule: SCHEDULE,
        });
        try {
            const gate = booted.checkpointing.gate();
            expect(gate).not.toBeNull();

            /*
             * 이것이 실제 게이트라는 증거는 그것이 무엇을 거절하느냐다.
             *
             * drain 을 아무도 들고 있지 않은 지금, 첫 단계인 admission 이 열려
             * 있다 — 게이트는 `isDraining()` 을 물어서 그것을 안다. 합성이 만든
             * 그 drain 을 보고 있지 않다면 이 답이 나올 수 없다.
             */
            expect(await gate!.prove()).toMatchObject({ quiesced: false, reason: 'admission-open' });

            // 이제 publisher 가 하는 것처럼 drain 을 잡고 다시 묻는다. admission
            // 은 통과하고, 이 runtime 에는 나가는 것을 관측할 세대가 없으므로
            // 다음 관문에서 멈춘다 — 지어낸 증명이 아니라 관측의 부재다.
            const held = await booted.checkpoint.checkpointDrain.drain.drain(1_000);
            try {
                expect(await gate!.prove()).toMatchObject({ quiesced: false, reason: 'exit-unobserved' });
            } finally {
                held.release();
            }
            await gate!.release();
        } finally {
            if (loop) await loop.stop();
            await runtime.stop();
        }
    });

    it('shouldRefuseTheCheckpointThroughThatGateRatherThanArchiveUnprovenState', async () => {
        /*
         * 같은 inbox 에 자격이 들어오고 tick 이 돌면, 거절은 **실제 게이트**의
         * 답이다. 그리고 아무것도 store 에 닿지 않는다 — 증명은 archive 전이다.
         */
        const booted = await boot();
        const runtime = await realRuntime(booted);
        const loop = await booted.checkpointing.startAfterSupervisor({
            runtime,
            checkpoint: booted.checkpoint,
            schedule: SCHEDULE,
        });
        try {
            booted.inbox.accept(delivery('c'.repeat(64), 2_000));
            booted.timers.fire();
            await loop!.stop();

            /*
             * `reason` 만으로는 행동할 수 없다 — 어느 단계가 안 됐는지가 답이다.
             * 이 runtime 에는 나가는 것을 관측할 세대가 없으므로 게이트의 답은
             * `exit-unobserved` 이고, 그것이 로그에 그대로 실린다.
             */
            expect(booted.ticks).toEqual([{
                trigger: 'periodic',
                kind: 'skipped',
                reason: 'provider-state-unproven',
                detail: 'exit-unobserved',
            }]);
            expect(booted.store.objects.size).toBe(0);
            // 아무것도 굽지 않았으므로 그 id 는 깨끗하다.
            expect(booted.inbox.accept(delivery('c'.repeat(64), 2_000)))
                .toEqual({ accepted: true, state: 'queued' });
        } finally {
            await runtime.stop();
        }
    });
});

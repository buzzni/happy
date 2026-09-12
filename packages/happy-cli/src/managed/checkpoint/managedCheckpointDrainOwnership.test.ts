/**
 * One drain, one owner, from the proof to the pointer.
 *
 * Two things were wrong before this and neither shows up in a unit double:
 *
 *  - The quiescence gate acquired the tool drain and held it until `release()`,
 *    while `publishManagedCheckpoint` acquires it too. The second acquisition
 *    finds `drain-in-progress`, so **every real checkpoint failed** — with a
 *    code that reads like an unlucky overlap rather than a design fault.
 *  - The proof cannot be taken before the drain is held: its first step is that
 *    admission is closed, and tool admission is closed by that drain. A proof
 *    taken earlier asserts an exclusion nobody has.
 *
 * So the whole ordering is asserted here against the real components — the real
 * `CheckpointDrain`, the real gate factory, the real `GenerationManifest` and
 * the real publisher. Only the object store is fake, and it is used as the
 * observation point: at each upload and at the pointer write, this test asks the
 * drain to admit a write and requires a refusal.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createGenerationManifest } from '@/launcher/generationManifest';
import { MANAGED_WRITE_TOOLS } from '@/launcher/managedToolCatalogue';
import type { RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

import { createManagedCheckpointCoordinator } from './managedCheckpointCoordinator';
import { mayStopRuntime } from '@/managed/managedRuntimeActivity';
import { createManagedCheckpointRunner } from './managedCheckpointRunner';

import { createCheckpointDrain, CheckpointDrainRefusal, type CheckpointDrain } from './managedCheckpointDrain';
import {
    publishManagedCheckpoint,
    ManagedCheckpointProviderStateInvalidated,
    ManagedCheckpointProviderStateUnproven,
} from './managedCheckpointPublisher';
import { createManagedProviderQuiescenceGate } from './managedProviderQuiescence';

const created: string[] = [];
const key = randomBytes(32);
const tenant = { tenantId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };
const generation = { runId: 'run-1', attemptId: 'attempt-1', epoch: 0 };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-drain-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

/**
 * The store, faked, and the place this test looks from.
 *
 * `onRequest` runs while the publisher is mid-flight — inside the window the
 * drain is supposed to be protecting — so a write refused there is a refusal
 * that actually happened during the archive.
 */
function fakeStore(onRequest?: (method: string, path: string) => void) {
    const objects = new Map<string, Buffer>();
    const seen: { method: string; path: string }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = String(url);
        const method = init?.method ?? 'GET';
        seen.push({ method, path });
        onRequest?.(method, path);
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
    return { objects, seen, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch };
}

/** Counts acquisitions without replacing any behaviour: every call delegates. */
function countingDrain(real: CheckpointDrain) {
    const counts = { acquisitions: 0 };
    const drain: CheckpointDrain = {
        beginWrite: () => real.beginWrite(),
        drain: (budgetMs) => {
            counts.acquisitions += 1;
            return real.drain(budgetMs);
        },
        inFlight: () => real.inFlight(),
        isDraining: () => real.isDraining(),
        writes: () => real.writes(),
        lastQuiescedWrites: () => real.lastQuiescedWrites(),
    };
    return { drain, counts };
}

/**
 * The real gate over the real drain and a real on-disk manifest.
 *
 * The launcher's observations are this runtime's answers — a single generation
 * that was launched, was seen to exit cleanly, and is the one the manifest has
 * open. `foreignGeneration` adds a record nobody owns, which is the one thing
 * that must stop an archive.
 */
async function realGate(input: {
    drain: CheckpointDrain;
    foreignGeneration?: boolean;
}) {
    /** Bumped to stage a provider restart in the middle of an archive. */
    const starts = { count: 1 };
    const manifest = createGenerationManifest(join(await scratch(), 'generations'));
    expect(manifest.recordLaunch({ key: generation, launchedAt: 1 })).toEqual({ ok: true });
    const addForeignGeneration = (): void => {
        manifest.recordLaunch({ key: { runId: 'run-0', attemptId: 'attempt-0', epoch: 0 }, launchedAt: 1 });
    };
    if (input.foreignGeneration) addForeignGeneration();
    let launchAdmission = true;
    const gate = createManagedProviderQuiescenceGate({
        drain: input.drain,
        launcher: {
            closeLaunchAdmission: () => { launchAdmission = false; return { closed: true, inFlight: 0 }; },
            reopenLaunchAdmission: () => { launchAdmission = true; },
            observedProviderExit: () => ({ code: 0, signal: null }),
            liveHandles: () => ['handle-1'],
            providerStarts: () => starts.count,
            unobservableGenerations: () => 0,
            writersRemaining: async () => 0,
            ownedGenerationKeys: () => [generation],
        },
        manifest: { listOpen: () => manifest.listOpen() },
        endInput: async () => ({ eof: true }),
    });
    return {
        gate,
        launchAdmissionOpen: () => launchAdmission,
        restartProvider: () => { starts.count += 1; },
        addForeignGeneration,
    };
}

async function projectRoot(): Promise<string> {
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    return root;
}

function targetsFor(checkpointId: string) {
    const object = `https://store.invalid/${checkpointId}/project.enc`;
    const manifest = `https://store.invalid/${checkpointId}/manifest.enc`;
    return {
        objects: new Map([['project' as const, { putUrl: object, headUrl: object }]]),
        manifest: { putUrl: manifest, headUrl: manifest },
        pointer: { putUrl: 'https://store.invalid/latest.json', getUrl: 'https://store.invalid/latest.json' },
    };
}

async function publish(input: {
    drain: CheckpointDrain;
    store: ReturnType<typeof fakeStore>;
    gate: Awaited<ReturnType<typeof realGate>>['gate'];
}) {
    return publishManagedCheckpoint({
        checkpointId: 'a'.repeat(64),
        tenant,
        volume,
        image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root: await projectRoot() }],
        key,
        workDir: join(await scratch(), 'work'),
        drain: input.drain,
        drainBudgetMs: 1000,
        providerState: { prove: () => input.gate.prove(), stillProven: () => input.gate.stillProven() },
        flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        targets: targetsFor('a'.repeat(64)),
        now: () => 1,
        fetchImpl: input.store.fetchImpl,
    });
}

describe('one drain owner, from the proof to the pointer', () => {
    it('shouldRefuseToolWritesThroughArchiveUploadAndPointerUnderASingleAcquisition', async () => {
        const real = createCheckpointDrain();
        const { drain, counts } = countingDrain(real);
        /** What the drain answered at each moment the store was touched. */
        const refusedAt: { path: string; code: string }[] = [];
        const admittedAt: string[] = [];
        const store = fakeStore((method, path) => {
            if (method === 'GET') return; // pointer read, before the archive exists
            try {
                real.beginWrite()();
                admittedAt.push(path);
            } catch (error) {
                refusedAt.push({
                    path,
                    code: error instanceof CheckpointDrainRefusal ? error.code : 'other',
                });
            }
        });
        const { gate, launchAdmissionOpen } = await realGate({ drain });

        const published = await publish({ drain, store, gate });

        // The checkpoint really landed: pointer written, and the proof survived
        // the whole window.
        expect(published.pointer.checkpointId).toBe('a'.repeat(64));
        expect(published.providerStateStillProven).toBe(true);
        // One acquisition for the whole thing — the gate never takes its own.
        expect(counts.acquisitions).toBe(1);
        // Nothing was admitted anywhere between the proof and the pointer.
        expect(admittedAt).toEqual([]);
        // And the refusals cover the archive, both uploads, and the pointer.
        expect(refusedAt.every((entry) => entry.code === 'drain-in-progress')).toBe(true);
        expect(refusedAt.map((entry) => entry.path.split('/').pop())).toEqual([
            'project.enc', 'project.enc', 'manifest.enc', 'manifest.enc', 'latest.json',
        ]);

        // Released on the way out, so the agent can write again.
        expect(real.isDraining()).toBe(false);
        real.beginWrite()();
        // Launch admission is the gate's to reopen, and the publisher does not
        // touch it: it is still closed until the caller releases the gate.
        expect(launchAdmissionOpen()).toBe(false);
        await gate.release();
        expect(launchAdmissionOpen()).toBe(true);
    });

    it('shouldArchiveNothingWhenTheProofRefusesInsideTheDrainedWindow', async () => {
        /*
         * 증명이 거절되면 flush 전에 멈춘다 — 아무것도 봉인되지 않고 아무것도
         * 올라가지 않는다. 그래서 그 checkpoint id 는 깨끗하고 다시 쓸 수 있다.
         */
        const real = createCheckpointDrain();
        const { drain, counts } = countingDrain(real);
        const store = fakeStore();
        const { gate } = await realGate({ drain, foreignGeneration: true });

        await expect(publish({ drain, store, gate })).rejects.toBeInstanceOf(
            ManagedCheckpointProviderStateUnproven,
        );
        await expect(publish({ drain, store, gate })).rejects.toMatchObject({
            reason: 'generation-unaccounted',
        });

        // Nothing reached the store at all — not even the pointer read.
        expect(store.seen).toEqual([]);
        expect(store.objects.size).toBe(0);
        // The drain was acquired for the proof and released on the way out.
        expect(counts.acquisitions).toBe(2);
        expect(real.isDraining()).toBe(false);
        real.beginWrite()();
    });

    it('shouldFailTheCheckpointIfAnythingElseTriesToAcquireTheSameDrain', async () => {
        /*
         * 두 소유자가 무슨 일을 하는지 남겨 둔다. 이전 배선에서 gate 가
         * `drain()` 을 잡고 release 까지 들고 있었고, publisher 가 다시 잡으면서
         * **실제 checkpoint 가 전부** `drain-in-progress` 로 죽었다. 코드 하나가
         * 불운한 겹침처럼 보이기 때문에 눈에 띄지 않았다.
         */
        const real = createCheckpointDrain();
        const { drain } = countingDrain(real);
        const store = fakeStore();
        const { gate } = await realGate({ drain });
        const secondOwner = {
            prove: async () => {
                // 이것이 두 번째 소유자다 — 관측이 아니라 취득이다.
                await drain.drain(1000);
                return gate.prove();
            },
            stillProven: () => gate.stillProven(),
        };

        await expect(publishManagedCheckpoint({
            checkpointId: 'b'.repeat(64),
            tenant,
            volume,
            image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root: await projectRoot() }],
            key,
            workDir: join(await scratch(), 'work'),
            drain,
            drainBudgetMs: 1000,
            providerState: secondOwner,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            targets: targetsFor('b'.repeat(64)),
            now: () => 1,
            fetchImpl: store.fetchImpl,
        })).rejects.toMatchObject({ code: 'drain-in-progress' });
        expect(store.seen).toEqual([]);
    });

    it('shouldWriteNoPointerWhenTheProofDiesDuringTheManifestUpload', async () => {
        /*
         * pointer 가 archive 를 **그** checkpoint 로 만든다. 그러니 증명이
         * 무너졌다는 것을 pointer 뒤에 알아내는 것은 늦다 — 이미 불안전한
         * checkpoint 가 최신이고 restore 는 그것을 읽는다. 여기서는 manifest
         * 업로드 도중에 provider 가 다시 뜬 것으로 만들고, pointer PUT 이
         * **한 번도** 일어나지 않는지 본다.
         */
        const real = createCheckpointDrain();
        const { drain } = countingDrain(real);
        let restart = (): void => { throw new Error('gate not built yet'); };
        const store = fakeStore((method, path) => {
            if (method === 'PUT' && path.endsWith('manifest.enc')) restart();
        });
        const built = await realGate({ drain });
        restart = built.restartProvider;

        await expect(publish({ drain, store, gate: built.gate })).rejects.toBeInstanceOf(
            ManagedCheckpointProviderStateInvalidated,
        );

        // The archive and the manifest went up — and the pointer never did.
        expect(store.seen.filter((entry) => entry.method === 'PUT').map((entry) => entry.path.split('/').pop()))
            .toEqual(['project.enc', 'manifest.enc']);
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
        // Released either way: a refused checkpoint must not leave a stuck drain.
        expect(real.isDraining()).toBe(false);
        real.beginWrite()();
    });

});

describe('the coordinator over a real gate and a real runner', () => {
    const idle: RuntimeIdleDecision = { state: 'idle', forMs: 1 };

    /**
     * The gate observes the runner's **own** drain — the one the tool session
     * writes through — so this is the arrangement a runtime actually has.
     */
    async function coordinatorWithRealGate(options: {
        foreignGeneration?: boolean;
        onRequest?: (method: string, path: string) => void;
    } = {}) {
        const store = fakeStore((method, path) => options.onRequest?.(method, path));
        const settled: { checkpointId: string; outcome: string }[] = [];
        const runner = createManagedCheckpointRunner({
            tenant, volume: () => volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root: await projectRoot() }],
            workDir: join(await scratch(), 'work'),
            drainBudgetMs: 1000,
            writeTools: MANAGED_WRITE_TOOLS,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            now: () => 1,
            fetchImpl: store.fetchImpl,
        });
        const built = await realGate({
            drain: runner.checkpointDrain.drain,
            foreignGeneration: options.foreignGeneration,
        });
        // 시도마다 다른 id — 자격은 한 번만 쓰인다.
        let issued = 0;
        const coordinator = createManagedCheckpointCoordinator({
            runner,
            targets: {
                next: async () => {
                    const checkpointId = String(issued += 1).repeat(64).slice(0, 64);
                    return { checkpointId, key, targets: targetsFor(checkpointId) };
                },
                settle: (input) => settled.push(input),
            },
            policy: { periodMs: 300_000, onTurnBoundary: true },
            providerQuiescence: () => built.gate,
        });
        return {
            coordinator,
            store,
            settled,
            drain: runner.checkpointDrain.drain,
            restartProvider: built.restartProvider,
            addForeignGeneration: built.addForeignGeneration,
        };
    }

    it('shouldCheckpointWithTheProofTakenInsideTheDrainedWindow', async () => {
        const { coordinator, store, settled, drain } = await coordinatorWithRealGate();
        const result = await coordinator.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(result).toMatchObject({ attempted: true, saved: true });
        expect(settled).toEqual([{ checkpointId: '1'.repeat(64), outcome: 'published' }]);
        // The pointer is on the store, and writes are admitted again.
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(true);
        expect(drain.isDraining()).toBe(false);
        drain.beginWrite()();
    });

    it('shouldRefuseAndLeaveTheCheckpointIdCleanWhenTheProofRefuses', async () => {
        const { coordinator, store, settled } = await coordinatorWithRealGate({ foreignGeneration: true });
        const result = await coordinator.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(result).toEqual({
            attempted: false,
            decision: {
                take: false, reason: 'provider-state-unproven', detail: 'generation-unaccounted',
            },
        });
        // Nothing was sealed or uploaded, so the id may be delivered again.
        expect(store.seen).toEqual([]);
        expect(settled).toEqual([{ checkpointId: '1'.repeat(64), outcome: 'unstarted' }]);
        // Not counted against the runtime: the run is healthy.
        expect(coordinator.scheduleState().consecutiveFailures).toBe(0);
        expect(coordinator.checkpointState().saved).toBe(false);
    });

    /**
     * A checkpoint that landed, and then a proof that did not.
     *
     * None of the three endings below is a *failure* — the run is healthy and
     * they are deliberately not counted — and the provider writes its own state
     * outside the tool drain, so `writes()` does not move either. Both existing
     * guards therefore miss them, and before this the runtime went on answering
     * `saved: true` with the previous checkpoint's id while its provider state
     * was unaccounted for. `mayStopRuntime` reads that answer.
     */
    async function checkpointOnceThen(options: {
        foreignGeneration?: boolean;
        /**
         * Runs during the **second** attempt only, with `restartProvider` in
         * hand — the first checkpoint has to land untouched, and the callback
         * fires while the helper's own `await` is still running, so the control
         * arrives as an argument rather than through the returned object.
         */
        onRequest?: (
            input: { method: string; path: string; restartProvider: () => void },
        ) => void;
    } = {}) {
        const staged = { armed: false, restartProvider: (): void => {} };
        const runtime = await coordinatorWithRealGate({
            onRequest: (method, path) => {
                if (!staged.armed) return;
                options.onRequest?.({ method, path, restartProvider: staged.restartProvider });
            },
        });
        staged.restartProvider = runtime.restartProvider;
        const first = await runtime.coordinator.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(first).toMatchObject({ attempted: true, saved: true });
        expect(runtime.coordinator.checkpointState().saved).toBe(true);
        const savedId = runtime.coordinator.scheduleState().lastSuccessCheckpointId;
        staged.armed = true;
        if (options.foreignGeneration) runtime.addForeignGeneration();
        const second = await runtime.coordinator.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        return { ...runtime, savedId, second };
    }

    /** No tool writes anywhere in these — that is the point. */
    function expectNotSavedButStillHistory(
        runtime: Awaited<ReturnType<typeof checkpointOnceThen>>,
        detail: string,
    ): void {
        expect(runtime.coordinator.checkpointState()).toEqual({ saved: false, detail });
        // Independent of the failure backoff: nothing was counted as a failure.
        expect(runtime.coordinator.scheduleState().consecutiveFailures).toBe(0);
        // The checkpoint is still real, and still the newest thing to restore.
        expect(runtime.coordinator.scheduleState().lastSuccessCheckpointId).toBe(runtime.savedId);
        // And the runtime may not be stopped on the strength of it.
        expect(mayStopRuntime({
            idle: { state: 'idle', forMs: 60_000 },
            checkpoint: runtime.coordinator.checkpointState(),
        }).stop).toBe(false);
    }

    it('shouldStopClaimingTheVolumeIsSavedWhenALaterProofIsRefused', async () => {
        const runtime = await checkpointOnceThen({ foreignGeneration: true });
        expect(runtime.second).toMatchObject({
            attempted: false,
            decision: { take: false, reason: 'provider-state-unproven', detail: 'generation-unaccounted' },
        });
        expectNotSavedButStillHistory(runtime, 'generation-unaccounted');
    });

    it('shouldStopClaimingTheVolumeIsSavedWhenTheProofDiesBeforeThePointer', async () => {
        const runtime = await checkpointOnceThen({
            onRequest: ({ method, path, restartProvider }) => {
                if (method === 'PUT' && path.endsWith('manifest.enc')) restartProvider();
            },
        });
        expect(runtime.second).toMatchObject({
            attempted: false,
            decision: {
                take: false, reason: 'provider-state-unproven', detail: 'invalidated-during-archive',
            },
        });
        expectNotSavedButStillHistory(runtime, 'invalidated-during-archive');
    });

    it('shouldStopClaimingTheVolumeIsSavedWhenTheProofIsLostAcrossThePointerWrite', async () => {
        /*
         * pointer 는 실렸다 — 그 checkpoint 는 존재한다. 그러나 그 왕복 사이에
         * provider 가 다시 떴으므로 이 runtime 의 "지금" 을 설명하지는 않는다.
         */
        const runtime = await checkpointOnceThen({
            onRequest: ({ method, path, restartProvider }) => {
                if (method === 'PUT' && path.endsWith('latest.json')) restartProvider();
            },
        });
        expect(runtime.second).toMatchObject({
            attempted: false,
            decision: { take: false, reason: 'provider-state-unproven', detail: 'provider-restarted' },
        });
        expectNotSavedButStillHistory(runtime, 'provider-restarted');
    });
});

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MANAGED_WRITE_TOOLS } from '@/launcher/managedToolCatalogue';
import { mayStopRuntime, type RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

import { createManagedCheckpointCoordinator } from './managedCheckpointCoordinator';
import { createManagedCheckpointRunner } from './managedCheckpointRunner';
import type { ManagedCheckpointRequest, ManagedCheckpointRunner } from './managedCheckpointRunner';
import type { ProviderStateObservation } from './managedProviderQuiescence';

const created: string[] = [];
const key = randomBytes(32);
const tenant = { tenantId: 'co_1', projectId: 'pr_1' };
const volume = { volumeId: 'vol_1', deviceUuid: 'dev-1' };
const idle: RuntimeIdleDecision = { state: 'idle', forMs: 1 };

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-coord-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

/** Only the object store is fake; the runner and publisher are the product. */
function fakeStore(options: { failObjects?: boolean } = {}) {
    const objects = new Map<string, Buffer>();
    /**
     * Every request this store was asked to serve.
     *
     * Kept so a refusal can be checked for what it did *not* do: an empty
     * `objects` map only says nothing was stored, while this says nothing was
     * attempted — and a refusal that arrives after an upload leaves an object
     * nobody can account for.
     */
    const calls: string[] = [];
    const state = { refuseObjects: options.failObjects === true };
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const path = String(url);
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${path}`);
        if (method === 'PUT') {
            if (state.refuseObjects && path.includes('project.enc')) {
                return new Response(null, { status: 507 });
            }
            const headers = (init?.headers ?? {}) as Record<string, string>;
            if (headers['if-none-match'] === '*' && objects.has(path)) return new Response(null, { status: 412 });
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
    return {
        objects,
        calls,
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        set refuseObjects(value: boolean) { state.refuseObjects = value; },
    };
}

/**
 * Targets for a runtime that archives provider state too.
 *
 * `targetsFor` covers the project tree alone, which is right for the runtimes
 * that archive only that. A coordinator whose runner also archives
 * `provider-state` needs a destination for it, or the publish fails for a
 * reason that has nothing to do with what is under test.
 */
function targetsForProviderState(checkpointId: string): ManagedCheckpointRequest {
    const base = targetsFor(checkpointId);
    const provider = `https://store.invalid/${checkpointId}/provider-state.enc`;
    base.targets.objects.set('provider-state', { putUrl: provider, headUrl: provider });
    return base;
}

function targetsFor(checkpointId: string): ManagedCheckpointRequest {
    const object = `https://store.invalid/${checkpointId}/project.enc`;
    const manifest = `https://store.invalid/${checkpointId}/manifest.enc`;
    return {
        checkpointId,
        key,
        targets: {
            objects: new Map([['project' as const, { putUrl: object, headUrl: object }]]),
            manifest: { putUrl: manifest, headUrl: manifest },
            pointer: { putUrl: 'https://store.invalid/latest.json', getUrl: 'https://store.invalid/latest.json' },
        },
    };
}

async function coordinator(options: {
    store?: ReturnType<typeof fakeStore>;
    policy?: { periodMs: number; onTurnBoundary: boolean; failureBackoffMs?: number } | null;
    targets?: { next: () => Promise<ManagedCheckpointRequest | null> };
    wrapRunner?: (runner: ManagedCheckpointRunner) => ManagedCheckpointRunner;
    initialState?: Parameters<typeof createManagedCheckpointCoordinator>[0]['initialState'];
} = {}) {
    const store = options.store ?? fakeStore();
    const root = await scratch();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const a = 1;\n');
    let issued = 0;
    const runner = createManagedCheckpointRunner({
        tenant, volume: () => volume, image: { imageVersion: 'img@1' },
        sources: [{ area: 'project', root }],
        workDir: join(await scratch(), 'work'),
        drainBudgetMs: 1000,
        writeTools: MANAGED_WRITE_TOOLS,
        flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        now: () => 1,
        fetchImpl: store.fetchImpl,
    });
    const exposed = options.wrapRunner ? options.wrapRunner(runner) : runner;
    return {
        store,
        runner,
        coordinator: createManagedCheckpointCoordinator({
            runner: exposed,
            targets: options.targets ?? {
                next: async () => targetsFor(String(issued += 1).padStart(64, '0')),
            },
            policy: options.policy === undefined ? { periodMs: 300_000, onTurnBoundary: true } : options.policy,
            ...(options.initialState ? { initialState: options.initialState } : {}),
        }),
    };
}

describe('createManagedCheckpointCoordinator', () => {
    it('shouldActuallyTakeACheckpointThroughTheRunner', async () => {
        const { coordinator: coord, store } = await coordinator();

        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(result).toMatchObject({ attempted: true, saved: true });
        // The product wrote real objects and moved the pointer.
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(true);
        expect(coord.checkpointState()).toMatchObject({ saved: true });
    });

    it('shouldLetTheRuntimeStopOnlyAfterOneHasActuallySucceeded', async () => {
        const { coordinator: coord } = await coordinator();

        // Nothing saved yet: no stopping, whatever the idle answer says.
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });

        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });
    });

    it('shouldNotReportASaveWhenTheStoreRefusesTheUpload', async () => {
        const { coordinator: coord } = await coordinator({ store: fakeStore({ failObjects: true }) });

        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(result).toMatchObject({ attempted: true, saved: false });
        expect(coord.checkpointState()).toMatchObject({ saved: false });
        // And the runtime may not be stopped on the strength of it.
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });
        expect(coord.scheduleState().consecutiveFailures).toBe(1);
        expect(coord.scheduleState().lastSuccessAtMs).toBeUndefined();
    });

    it('shouldKeepTheOlderSavedPointWhenALaterAttemptFails', async () => {
        const store = fakeStore();
        const { coordinator: coord } = await coordinator({ store });
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        const saved = coord.checkpointState();

        // The pointer is already there and this attempt writes the same object
        // key, so the conditional write refuses it.
        const failing = createManagedCheckpointCoordinator({
            runner: (await coordinator({ store })).runner,
            targets: { next: async () => targetsFor('1'.padStart(64, '0')) },
            policy: { periodMs: 1, onTurnBoundary: true },
        });
        const result = await failing.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        expect(result).toMatchObject({ attempted: true, saved: false });

        // The first coordinator's saved point is untouched by someone else's
        // failure, and its own state still names the checkpoint it verified.
        expect(coord.checkpointState()).toEqual(saved);
    });

    it('shouldStopAuthorisingAStopOnceALaterCheckpointFails', async () => {
        const store = fakeStore();
        const { coordinator: coord } = await coordinator({ store });
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });

        // The next one is due and the store refuses it. The older checkpoint
        // is still the newest verified one, but the volume has moved on.
        store.refuseObjects = true;
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        expect(result).toMatchObject({ attempted: true, saved: false });

        expect(coord.checkpointState()).toMatchObject({ saved: false });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });
    });

    it('shouldNotAuthoriseAStopWhileACheckpointIsStillRunning', async () => {
        // The second tick's targets never arrive until this is called.
        let release: () => void = () => undefined;
        const gate = new Promise<null>((resolve) => { release = () => resolve(null); });
        let issued = 0;
        const { coordinator: coord } = await coordinator({
            targets: {
                next: async () => {
                    issued += 1;
                    if (issued === 1) return targetsFor('1'.padStart(64, '0'));
                    return gate;
                },
            },
        });
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });

        // A second checkpoint is due and is waiting on its targets. It has not
        // failed, so failure counting says nothing — but the volume has moved
        // on from the last saved point and this one has not landed.
        const pending = coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(coord.scheduleState().inFlight).toBe(true);
        expect(coord.checkpointState()).toMatchObject({ saved: false });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: false });
        release();
        await pending;
    });

    it('shouldNotAuthoriseAStopOnAStateItDidNotVerifyItself', async () => {
        // A coordinator resumed from a persisted state knows a checkpoint once
        // succeeded; it does not know what has happened to the volume since,
        // because it was not running. That is not a proof it may stop on.
        const { coordinator: coord } = await coordinator({
            initialState: {
                lastSuccessAtMs: 1,
                lastSuccessCheckpointId: 'a'.repeat(64),
                lastSuccessManifestDigest: 'b'.repeat(64),
                consecutiveFailures: 0,
            },
        });
        expect(coord.checkpointState()).toEqual({ saved: false, detail: 'unverified-in-this-process' });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });

        // Once this process takes one, it may.
        await coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });
    });

    it('shouldWatchWritesWithoutBeingToldToByDefault', async () => {
        // No `writeGeneration` supplied: the runner's own gate is the source,
        // so forgetting to wire one does not silently disable the check.
        const { coordinator: coord, runner } = await coordinator();
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });

        runner.checkpointDrain.drain.beginWrite()();
        expect(coord.checkpointState()).toEqual({ saved: false, detail: 'writes-since-checkpoint' });
    });

    it('shouldStopAuthorisingAStopAfterAWriteWithNoAttemptInBetween', async () => {
        const { coordinator: coord, runner } = await coordinator();
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });

        // A tool writes. No checkpoint has been attempted since, so failure
        // counting alone would still say the volume is saved.
        const done = runner.checkpointDrain.drain.beginWrite();
        done();

        expect(coord.checkpointState()).toEqual({ saved: false, detail: 'writes-since-checkpoint' });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });
    });

    it('shouldCompareAgainstTheCountTheArchiveWasTakenAtNotTheOneAfterTheGateReopened', async () => {
        // A write that lands after the gate reopens but before the outcome is
        // recorded is a write the archive does not contain. Recording the
        // count at that moment instead of the drained one would fold it into
        // the checkpoint and authorise a stop that loses it.
        let gate: ManagedCheckpointRunner['checkpointDrain'] | null = null;
        const { coordinator: coord } = await coordinator({
            wrapRunner: (runner) => {
                gate = runner.checkpointDrain;
                return {
                    ...runner,
                    takeCheckpoint: async (request) => {
                        const published = await runner.takeCheckpoint(request);
                        // The drain is released by now; this is the window.
                        runner.checkpointDrain.drain.beginWrite()();
                        return published;
                    },
                };
            },
        });

        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(gate).not.toBeNull();
        expect(coord.checkpointState()).toEqual({ saved: false, detail: 'writes-since-checkpoint' });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() }))
            .toMatchObject({ stop: false, reason: 'no-verified-checkpoint' });
    });

    it('shouldAuthoriseAStopAgainOnceThoseWritesAreCheckpointed', async () => {
        const { coordinator: coord, runner } = await coordinator();
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        runner.checkpointDrain.drain.beginWrite()();
        expect(coord.checkpointState()).toMatchObject({ saved: false });

        await coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 });
        expect(coord.checkpointState()).toMatchObject({ saved: true });
        expect(mayStopRuntime({ idle, checkpoint: coord.checkpointState() })).toMatchObject({ stop: true });
    });

    it('shouldNotAttemptWhileSomethingMayStillBeWriting', async () => {
        const { coordinator: coord, store } = await coordinator();
        const result = await coord.tick({
            trigger: 'turn-boundary',
            idle: { state: 'undecidable', reason: 'unproven-writer' },
            now: 1_000_000,
        });
        expect(result).toEqual({ attempted: false, decision: { take: false, reason: 'unproven-writer' } });
        expect(store.objects.size).toBe(0);
    });

    it('shouldTakeNoneWithoutAConfiguredPolicy', async () => {
        const { coordinator: coord, store } = await coordinator({ policy: null });
        expect(await coord.tick({ trigger: 'turn-boundary', idle, now: 9_000_000 }))
            .toEqual({ attempted: false, decision: { take: false, reason: 'no-policy' } });
        expect(store.objects.size).toBe(0);
    });

    it('shouldNotTreatAFailureToFetchTargetsAsAnExpectedSkip', async () => {
        // `null` means the parent has issued none; a throw means the fetch
        // itself failed — an expired signature, an unreachable control plane,
        // a credential that no longer works. Folding the second into the first
        // makes a broken credential path look like an idle project, silently,
        // for as long as it stays broken.
        const { coordinator: coord } = await coordinator({
            targets: { next: async () => { throw Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }); } },
        });

        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(result).toEqual({
            attempted: false,
            decision: { take: false, reason: 'targets-unavailable', detail: 'EAI_AGAIN' },
        });
        // It counts as a failed checkpoint: nothing was saved and something is
        // wrong, so the backoff applies rather than retrying every tick.
        expect(coord.scheduleState().consecutiveFailures).toBe(1);
        expect(coord.scheduleState().lastSuccessAtMs).toBeUndefined();
        expect(coord.scheduleState().inFlight).toBe(false);
    });

    it('shouldSkipRatherThanFailWhenNoTargetsHaveBeenIssued', async () => {
        const { coordinator: coord } = await coordinator({ targets: { next: async () => null } });
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(result).toEqual({ attempted: false, decision: { take: false, reason: 'no-targets' } });
        // Nothing was attempted, so nothing failed.
        expect(coord.scheduleState().consecutiveFailures).toBe(0);
    });

    it('shouldNotStartASecondCheckpointWhileOneIsRunning', async () => {
        const { coordinator: coord } = await coordinator();
        const first = coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        // The runner's drain would refuse this outright; the coordinator
        // answers with a decision instead of an error.
        const second = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_001 });
        expect(second).toEqual({ attempted: false, decision: { take: false, reason: 'in-flight' } });
        expect(await first).toMatchObject({ attempted: true, saved: true });
    });
});

describe('archiving provider state without a proof of quiescence', () => {
    /**
     * `provider-state` is written by the provider itself, as itself, outside the
     * tool drain. The gate that proves it settled is optional on the
     * coordinator, and absent it the checkpoint would run anyway — sealing a
     * provider state nothing had proven was flushed, and publishing a pointer
     * that announces it as the latest.
     *
     * That is the worst of the three outcomes, because it is the one that looks
     * like the good one: no failure is counted, `saved: true` is recorded, and
     * a restore believes what it reads.
     *
     * The answer is not a flag the caller passes. A caller that says "no
     * provider state here" while the runner archives some would be believed,
     * and the archive is the runner's, so the runner is asked.
     */
    async function providerStateCoordinator(quiescence?: {
        prove: () => Promise<{
            quiesced: true; exitCode: 0; signal: null;
            // The real shape; the fixtures build genuine observations rather
            // than a looser stand-in, so a change to it fails here.
            providerState?: ProviderStateObservation;
        } | {
            quiesced: false; reason: 'exit-unobserved';
        }>;
        stillProven: () => boolean;
        release: () => Promise<void>;
    }, options: { lateGate?: boolean } = {}) {
        const store = fakeStore();
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'work\n');
        const providerRoot = await scratch();
        await mkdir(join(providerRoot, 'sessions', 'sess-1'), { recursive: true });
        await writeFile(join(providerRoot, 'sessions', 'sess-1', 'rollout.jsonl'), '{}\n');
        const runner = createManagedCheckpointRunner({
            tenant, volume: () => volume, image: { imageVersion: 'img@1' },
            sources: [{ area: 'project', root }, { area: 'provider-state', root: providerRoot }],
            // Only declared sessions leave the runtime; an area that includes
            // nothing has nothing to archive.
            providerStateSessions: ['sess-1'],
            workDir: join(await scratch(), 'work'),
            drainBudgetMs: 1000,
            writeTools: MANAGED_WRITE_TOOLS,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            now: () => 1,
            fetchImpl: store.fetchImpl,
        });
        // Handed back so a refusal can be checked for what it did *not* do.
        // A code alone does not say the archive stopped before the store.
        const coordinator = createManagedCheckpointCoordinator({
            runner,
            targets: { next: async () => targetsForProviderState('a'.repeat(64)) },
            policy: { periodMs: 300_000, onTurnBoundary: true },
            ...(quiescence ? { providerQuiescence: () => quiescence } : {}),
            /*
             * 참조는 있고 값은 아직 없는 상태 — supervisor 전에 tick 이 돈 경우다.
             */
            ...(options.lateGate ? { providerQuiescence: () => null } : {}),
        });
        return Object.assign(coordinator, { store });
    }

    it('shouldRefuseWhileTheGateIsNotYetWiredRatherThanArchiveUnprovenProviderState', async () => {
        /*
         * 게이트는 supervisor 가 생긴 **뒤에** 만들어진다. 그 전에 tick 이 돌면
         * 참조는 있는데 값이 없다. 그것을 "게이트 없음"(= provider state 를 담지
         * 않는 runtime)으로 읽으면 증명되지 않은 provider state 를 담게 되고,
         * 고장으로 읽으면 runtime 에 실패를 세게 된다. 둘 다 아니다 — 아직 물을
         * 수 없다는 사실을 그대로 답한다.
         */
        const coord = await providerStateCoordinator(undefined, { lateGate: true });
        expect(await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 })).toEqual({
            attempted: false,
            decision: { take: false, reason: 'quiescence-unavailable', detail: 'gate-not-wired' },
        });
    });

    it('shouldRefuseTheCheckpointWhenTheRunnerArchivesProviderStateAndNothingCanProveItSettled', async () => {
        const coord = await providerStateCoordinator();
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        expect(result).toEqual({
            attempted: false,
            decision: { take: false, reason: 'provider-state-unproven', detail: 'no-quiescence-gate' },
        });
        // And it is not recorded as a save: a restore must not be offered an
        // archive that was never taken.
        expect(coord.checkpointState().saved).toBe(false);
    });

    it('shouldStillCheckpointWhenNoProviderStateIsArchived', async () => {
        // The refusal is about the area, not about the gate being fashionable.
        // A runtime that archives only the project tree has nothing the tool
        // drain does not already cover.
        const { coordinator: coord } = await coordinator();
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(result).toMatchObject({ attempted: true, saved: true });
    });

    it('shouldStillRefuseProviderStateOnAProvenGateUntilAnInventoryExists', async () => {
        /*
         * A proven gate is no longer enough, and that is deliberate: root
         * reproduced a publish where filling `providerStateSessions` with an id
         * made a **one-byte** `sessions/<id>/rollout.jsonl` look like coverage and
         * moved the pointer. Safety was resting on the allowlist happening to match
         * nothing, so the publisher now refuses a targeted `provider-state` before
         * anything is flushed or archived, until a signed parent inventory and a
         * provider-typed coverage contract exist.
         *
         * The refusal arrives as a **failed attempt**, not a skip: the gate proved,
         * the target was consumed, and the publisher was entered. The code it
         * arrives with is the one the proof earned — here everything the runtime
         * could see was in order, so the missing inventory is the whole reason.
         */
        const coord = await providerStateCoordinator({
            prove: async () => ({
                quiesced: true, exitCode: 0, signal: null,
                providerState: {
                    completeness: 'history-unestablished' as const,
                    generations: [{
                        handle: 'h1',
                        key: { runId: 'r', attemptId: 'a', epoch: 0 },
                        stopped: true,
                        detail: 'stopped',
                        nativeId: 'aabbccdd-11ee-4ff1-8abc-def123456789',
                        identity: null,
                    }],
                },
            }),
            stillProven: () => true,
            release: async () => {},
        });
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(result).toEqual({
            attempted: true, saved: false, detail: 'provider-state-inventory-missing',
        });
        // And nothing was published on the strength of a session list alone.
        expect(coord.checkpointState().saved).toBe(false);
        /*
         * The refusal has to arrive **before** anything leaves this runtime. A
         * code that came after an upload would still describe a store holding
         * an object nobody can account for, and a pointer is not the only thing
         * that outlives a failed tick.
         */
        expect(coord.store.calls).toEqual([]);
        expect([...coord.store.objects.keys()]).toEqual([]);
    });

    it('shouldTellTheTickWhichGenerationMisbehavedRatherThanBlameTheInventory', async () => {
        /*
         * Same tick, different cause. A generation that named two sessions is a
         * problem with an owner; a missing inventory is a problem with a
         * schedule. Answering the second for the first sends whoever reads the
         * tick to the wrong place, and this is the only place that still knows
         * the difference — the observation does not survive the publisher.
         */
        const coord = await providerStateCoordinator({
            prove: async () => ({
                quiesced: true, exitCode: 0, signal: null,
                providerState: {
                    completeness: 'history-unestablished' as const,
                    generations: [{
                        handle: 'h1',
                        key: { runId: 'r', attemptId: 'a', epoch: 0 },
                        stopped: true,
                        detail: 'stopped',
                        nativeId: null,
                        identity: 'conflict',
                    }],
                },
            }),
            stillProven: () => true,
            release: async () => {},
        });
        expect(await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 })).toEqual({
            attempted: true, saved: false, detail: 'provider-state-identity-conflict',
        });
        expect(coord.store.calls).toEqual([]);
    });

    it('shouldReadTheProofAgainOnTheNextTickRatherThanKeepTheFirstAnswer', async () => {
        /*
         * No stale A→B. The first tick's observation must not decide the
         * second's: a generation that contradicted itself once and a clean one
         * that followed are two ticks with two answers, and carrying the first
         * forward would report a problem that has gone — or, the other way
         * round, hide one that has arrived.
         */
        let conflicted = true;
        const coord = await providerStateCoordinator({
            prove: async () => ({
                quiesced: true, exitCode: 0, signal: null,
                providerState: {
                    completeness: 'history-unestablished' as const,
                    generations: [{
                        handle: 'h1',
                        key: { runId: 'r', attemptId: 'a', epoch: 0 },
                        stopped: true,
                        detail: 'stopped',
                        nativeId: conflicted ? null : 'aabbccdd-11ee-4ff1-8abc-def123456789',
                        identity: conflicted ? 'conflict' : null,
                    }],
                },
            }),
            stillProven: () => true,
            release: async () => {},
        });
        expect(await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 }))
            .toMatchObject({ detail: 'provider-state-identity-conflict' });

        conflicted = false;
        expect(await coord.tick({ trigger: 'turn-boundary', idle, now: 2_000_000 }))
            .toMatchObject({ detail: 'provider-state-inventory-missing' });
        expect(coord.store.calls).toEqual([]);
    });
});

async function coordinatorWithGate(gate: {
    prove: () => Promise<never> | Promise<{ quiesced: true; exitCode: 0; signal: null }>;
    stillProven?: () => boolean;
    release?: () => Promise<void>;
}) {
    const store = fakeStore();
    const root = await scratch();
    await writeFile(join(root, 'file.txt'), 'work\n');
    const providerRoot = await scratch();
    await mkdir(join(providerRoot, 'sessions', 'sess-1'), { recursive: true });
    await writeFile(join(providerRoot, 'sessions', 'sess-1', 'rollout.jsonl'), '{}\n');
    const runner = createManagedCheckpointRunner({
        tenant, volume: () => volume, image: { imageVersion: 'img@1' },
        /*
         * project-only: this fixture exists for the gate's release and the tick
         * lifecycle. A targeted `provider-state` is now refused before anything is
         * archived, which would answer every one of those tests with that refusal.
         */
        sources: [{ area: 'project', root }],
        providerStateSessions: ['sess-1'],
        workDir: join(await scratch(), 'work'),
        drainBudgetMs: 1000,
        writeTools: MANAGED_WRITE_TOOLS,
        flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        now: () => 1,
        fetchImpl: store.fetchImpl,
    });
    let issued = 0;
    return {
        store,
        coordinator: createManagedCheckpointCoordinator({
            runner,
            targets: { next: async () => targetsForProviderState(String(issued += 1).padStart(64, 'a')) },
            policy: { periodMs: 300_000, onTurnBoundary: true },
            providerQuiescence: () => ({
                prove: gate.prove,
                stillProven: gate.stillProven ?? (() => true),
                release: gate.release ?? (async () => {}),
            } as never),
        }),
    };
}

describe('the gate an attempt closed is the gate it reopens', () => {
    /**
     * The reference is late-bound, so it can change while an attempt is running.
     *
     * If the release re-read it, the attempt would prove on the gate it closed
     * and reopen a **different** one: the first stays closed for the rest of the
     * runtime's life, and the second is reopened for an attempt that never
     * closed it. Both halves are wrong, and neither is visible from the outcome.
     */
    it('shouldReleaseTheProvenGateExactlyOnceEvenIfTheReferenceMovesMidAttempt', async () => {
        const store = fakeStore();
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'work\n');
        const providerRoot = await scratch();
        await mkdir(join(providerRoot, 'sessions', 'sess-1'), { recursive: true });
        await writeFile(join(providerRoot, 'sessions', 'sess-1', 'rollout.jsonl'), '{}\n');
        const runner = createManagedCheckpointRunner({
            tenant, volume: () => volume, image: { imageVersion: 'img@1' },
            /*
             * project-only sources: these tests are about the gate, the release
             * and the tick lifecycle, not about which areas are archived. The
             * publisher now refuses a targeted `provider-state` outright until a
             * signed parent inventory exists, so keeping that area here would make
             * every one of them assert that refusal instead of what they are for.
             */
            sources: [{ area: 'project', root }],
            providerStateSessions: ['sess-1'],
            workDir: join(await scratch(), 'work'),
            drainBudgetMs: 1000,
            writeTools: MANAGED_WRITE_TOOLS,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            now: () => 1,
            fetchImpl: store.fetchImpl,
        });
        const released: string[] = [];
        const gateA = {
            prove: async () => ({ quiesced: true, exitCode: 0, signal: null }),
            stillProven: () => true,
            release: async () => { released.push('A'); },
        } as never;
        const gateB = {
            prove: async () => ({ quiesced: true, exitCode: 0, signal: null }),
            stillProven: () => true,
            release: async () => { released.push('B'); },
        } as never;
        // 첫 읽기는 A, 그 뒤로는 B — archive/publish 도중에 참조가 움직인 경우다.
        let reads = 0;
        const coord = createManagedCheckpointCoordinator({
            runner,
            targets: { next: async () => targetsForProviderState('c'.repeat(64)) },
            policy: { periodMs: 300_000, onTurnBoundary: true },
            providerQuiescence: () => (reads++ === 0 ? gateA : gateB),
        });
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(result.attempted).toBe(true);
        expect(released).toEqual(['A']);
    });

    it('shouldReleaseTheProvenGateEvenIfTheReferenceGoesEmptyMidAttempt', async () => {
        const store = fakeStore();
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'work\n');
        const providerRoot = await scratch();
        await mkdir(join(providerRoot, 'sessions', 'sess-1'), { recursive: true });
        await writeFile(join(providerRoot, 'sessions', 'sess-1', 'rollout.jsonl'), '{}\n');
        const runner = createManagedCheckpointRunner({
            tenant, volume: () => volume, image: { imageVersion: 'img@1' },
            /*
             * project-only sources: these tests are about the gate, the release
             * and the tick lifecycle, not about which areas are archived. The
             * publisher now refuses a targeted `provider-state` outright until a
             * signed parent inventory exists, so keeping that area here would make
             * every one of them assert that refusal instead of what they are for.
             */
            sources: [{ area: 'project', root }],
            providerStateSessions: ['sess-1'],
            workDir: join(await scratch(), 'work'),
            drainBudgetMs: 1000,
            writeTools: MANAGED_WRITE_TOOLS,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            now: () => 1,
            fetchImpl: store.fetchImpl,
        });
        const released: string[] = [];
        const gateA = {
            prove: async () => ({ quiesced: true, exitCode: 0, signal: null }),
            stillProven: () => true,
            release: async () => { released.push('A'); },
        } as never;
        let reads = 0;
        const coord = createManagedCheckpointCoordinator({
            runner,
            targets: { next: async () => targetsForProviderState('d'.repeat(64)) },
            policy: { periodMs: 300_000, onTurnBoundary: true },
            // 배선이 사라져도 이 시도가 닫은 문은 이 시도가 열어야 한다.
            providerQuiescence: () => (reads++ === 0 ? gateA : null),
        });
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(result.attempted).toBe(true);
        expect(released).toEqual(['A']);
    });
});

describe('a quiescence dependency that throws', () => {
    /**
     * `prove()` runs `closeAdmission`, `awaitInFlight`, `endInput`,
     * `observeExit` and `writersRemaining` — every one of them a real operation
     * on a running runtime, and every one able to reject rather than answer.
     *
     * A rejection there escaped the tick entirely: the in-flight flag stayed
     * set and admission was never reopened, so the runtime was left refusing
     * work with no checkpoint running and no later tick able to start one. The
     * first broken proof would have been the last checkpoint that runtime ever
     * attempted.
     *
     * Cleaning up after a failure is not the same as proving a flush. Nothing
     * on these paths may be recorded as a save.
     */
    it('shouldAnswerWithADecisionRatherThanRejectingWhenTheProofThrows', async () => {
        const { coordinator: coord } = await coordinatorWithGate({
            prove: async () => { throw Object.assign(new Error('closeAdmission failed'), { code: 'admission-error' }); },
        });

        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        // "We could not ask" — the same shape the targets fetch already uses
        // for the same distinction, and never a save.
        expect(result).toEqual({
            attempted: false,
            decision: { take: false, reason: 'quiescence-unavailable', detail: 'admission-error' },
        });
        expect(coord.checkpointState().saved).toBe(false);
    });

    it('shouldNotLeaveTheRuntimeInFlightForeverAfterAThrow', async () => {
        // The regression itself: a stuck flag is not visible as a failure, it
        // is visible as a runtime that says a checkpoint is running and never
        // takes another one.
        const { coordinator: coord } = await coordinatorWithGate({
            prove: async () => { throw new Error('observeExit failed'); },
        });
        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(coord.scheduleState().inFlight).not.toBe(true);
        const view = coord.checkpointState();
        expect(view.saved === false && view.detail === 'checkpoint-in-flight').toBe(false);
    });

    it('shouldReopenAdmissionEvenThoughTheProofNeverReturned', async () => {
        // Admission is closed by `prove` before anything it might fail on. A
        // throw that skips the release leaves the provider unable to be given
        // work, with nothing running to explain why.
        let released = 0;
        await (await coordinatorWithGate({
            prove: async () => { throw new Error('endInput failed'); },
            release: async () => { released += 1; },
        })).coordinator.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(released).toBe(1);
    });

    it('shouldLetTheNextAttemptRunOnceTheDependencyRecovers', async () => {
        let calls = 0;
        const { coordinator: coord } = await coordinatorWithGate({
            prove: async () => {
                calls += 1;
                if (calls === 1) throw new Error('transient');
                return { quiesced: true, exitCode: 0, signal: null };
            },
        });

        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        // Far enough ahead that any failure backoff has elapsed.
        const second = await coord.tick({ trigger: 'turn-boundary', idle, now: 9_000_000 });
        expect(second).toMatchObject({ attempted: true, saved: true });
    });

    it('shouldNotLetAFailedReleaseMaskACheckpointThatActuallyLanded', async () => {
        // The checkpoint is on the store and the pointer has moved; that is
        // true whatever happens next. But admission did not reopen, so the
        // runtime must not go on to close it again and call that a fresh proof.
        const { coordinator: coord, store } = await coordinatorWithGate({
            prove: async () => ({ quiesced: true, exitCode: 0, signal: null }),
            release: async () => { throw new Error('reopenAdmission failed'); },
        });

        const first = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(first).toMatchObject({ attempted: true, saved: true });
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(true);

        const second = await coord.tick({ trigger: 'turn-boundary', idle, now: 9_000_000 });
        expect(second).toEqual({
            attempted: false,
            decision: { take: false, reason: 'quiescence-unavailable', detail: 'admission-unreleased' },
        });
    });
});

describe('the attempt owns its cleanup, exactly once and to the end', () => {
    /**
     * Two properties that only a whole attempt can have, and neither of which
     * any single branch can be read to establish.
     *
     * **Once.** The gate is a lock over the provider's admission. Releasing it
     * twice is not a harmless repeat: the second release lands after this
     * attempt is over, and if another attempt has started by then it is that
     * one's admission being opened, under a proof that is still being relied
     * on.
     *
     * **To the end.** The release is awaited, so there is a window between
     * "this attempt stopped needing the lock" and "the lock is actually open".
     * A tick that starts inside that window builds a proof — closes admission,
     * observes the exit — and then the *previous* attempt's release reopens
     * admission underneath it. The proof is then describing a runtime that is
     * accepting work again, which is the one thing it claims is impossible.
     */
    async function slowReleaseCoordinator(release: () => Promise<void>, options: {
        stillProven?: () => boolean;
    } = {}) {
        const store = fakeStore();
        const root = await scratch();
        await writeFile(join(root, 'file.txt'), 'work\n');
        const providerRoot = await scratch();
        await mkdir(join(providerRoot, 'sessions', 'sess-1'), { recursive: true });
        await writeFile(join(providerRoot, 'sessions', 'sess-1', 'rollout.jsonl'), '{}\n');
        const runner = createManagedCheckpointRunner({
            tenant, volume: () => volume, image: { imageVersion: 'img@1' },
            /*
             * project-only sources: these tests are about the gate, the release
             * and the tick lifecycle, not about which areas are archived. The
             * publisher now refuses a targeted `provider-state` outright until a
             * signed parent inventory exists, so keeping that area here would make
             * every one of them assert that refusal instead of what they are for.
             */
            sources: [{ area: 'project', root }],
            providerStateSessions: ['sess-1'],
            workDir: join(await scratch(), 'work'),
            drainBudgetMs: 1000,
            writeTools: MANAGED_WRITE_TOOLS,
            flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
            now: () => 1,
            fetchImpl: store.fetchImpl,
        });
        const calls = { targets: 0, prove: 0, release: 0 };
        let issued = 0;
        const coordinator = createManagedCheckpointCoordinator({
            runner,
            targets: {
                next: async () => {
                    calls.targets += 1;
                    return targetsForProviderState(String(issued += 1).padStart(64, 'a'));
                },
            },
            policy: { periodMs: 300_000, onTurnBoundary: true },
            providerQuiescence: () => ({
                prove: async () => { calls.prove += 1; return { quiesced: true, exitCode: 0, signal: null }; },
                stillProven: options.stillProven ?? (() => true),
                release: async () => { calls.release += 1; await release(); },
            } as never),
        });
        return { coordinator, calls, store };
    }

    it('shouldReleaseExactlyOnceWhenTheProofDidNotSurviveTheArchive', async () => {
        // The provider came back during the archive. One release, not two: the
        // branch that reports it and the cleanup that follows are not two
        // separate claims on the lock.
        const { coordinator: coord, calls, store } = await slowReleaseCoordinator(async () => {}, {
            stillProven: () => false,
        });

        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });

        /*
         * `invalidated-during-archive`: the publisher asks again immediately
         * before the compare-and-set, so a proof that died during the archive
         * stops the pointer instead of being noticed after it moved.
         */
        expect(result).toEqual({
            attempted: false,
            decision: {
                take: false, reason: 'provider-state-unproven', detail: 'invalidated-during-archive',
            },
        });
        expect(calls.release).toBe(1);
        // And nothing was announced as the latest checkpoint.
        expect(store.objects.has('https://store.invalid/latest.json')).toBe(false);
    });

    it('shouldRecordAReleaseThatWasRefusedOnTheRestartedPathToo', async () => {
        // A release refusal is a stuck admission whichever branch asked for it.
        const { coordinator: coord } = await slowReleaseCoordinator(
            async () => { throw new Error('reopenAdmission failed'); },
            { stillProven: () => false },
        );

        await coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        expect(await coord.tick({ trigger: 'turn-boundary', idle, now: 9_000_000 })).toEqual({
            attempted: false,
            decision: { take: false, reason: 'quiescence-unavailable', detail: 'admission-unreleased' },
        });
    });

    it('shouldNotLetASecondTickStartWhileTheFirstIsStillReleasingAdmission', async () => {
        let finishRelease: () => void = () => {};
        const releasing = new Promise<void>((resolve) => { finishRelease = resolve; });
        const { coordinator: coord, calls } = await slowReleaseCoordinator(() => releasing);

        const first = coord.tick({ trigger: 'turn-boundary', idle, now: 1_000_000 });
        // Let the first attempt get all the way into its release.
        while (calls.release === 0) await new Promise((resolve) => setTimeout(resolve, 1));

        const targetsBefore = calls.targets;
        const provesBefore = calls.prove;
        const second = await coord.tick({ trigger: 'turn-boundary', idle, now: 1_500_000 });

        // Nothing of a new attempt happened: no credential was spent and, above
        // all, no new proof was begun against an admission about to reopen.
        expect(second).toEqual({ attempted: false, decision: { take: false, reason: 'in-flight' } });
        expect(calls.targets).toBe(targetsBefore);
        expect(calls.prove).toBe(provesBefore);

        finishRelease();
        expect(await first).toMatchObject({ attempted: true, saved: true });

        // And once the lock is genuinely open, a later attempt runs.
        const third = await coord.tick({ trigger: 'turn-boundary', idle, now: 9_000_000 });
        expect(third).toMatchObject({ attempted: true, saved: true });
        expect(calls.release).toBe(2);
    });
});

describe('root review: the attempt is not over until its cleanup is', () => {
    /**
     * Root's two cases, folded in as they were written. The first one asserts
     * something my own tests did not: that the *reported* schedule state stays
     * in flight for the whole attempt, cleanup included — not just that a
     * private lock does. One fact kept in two variables is what let these two
     * drift apart in the first place.
     */
    it('root: keeps attempt ownership until admission cleanup completes', async () => {
        let unblock!: () => void; let entered!: () => void; let proves = 0;
        const pending = new Promise<void>((r) => { unblock = r; });
        const started = new Promise<void>((r) => { entered = r; });
        const { coordinator: coord } = await coordinatorWithGate({
            prove: (async () => { proves++; throw new Error('temporary'); }) as never,
            release: async () => { entered(); await pending; },
        });
        const first = coord.tick({ trigger: 'turn-boundary', idle, now: 1000000 });
        try {
            await started;
            const stateDuringCleanup = coord.scheduleState().inFlight;
            const second = coord.tick({ trigger: 'turn-boundary', idle, now: 9000000 });
            await new Promise<void>((r) => setImmediate(r));
            const provesDuringCleanup = proves;
            unblock();
            await Promise.all([first, second]);
            expect({ stateDuringCleanup, provesDuringCleanup })
                .toEqual({ stateDuringCleanup: true, provesDuringCleanup: 1 });
        } finally {
            // The barrier is a real pending release; an assertion that throws
            // before `unblock()` would otherwise hang the suite rather than
            // failing it.
            unblock();
            await first.catch(() => undefined);
        }
    });

    it('root: stale proof releases admission exactly once', async () => {
        let releases = 0;
        const { coordinator: coord } = await coordinatorWithGate({
            prove: async () => ({ quiesced: true, exitCode: 0, signal: null }),
            stillProven: () => false,
            release: async () => { releases++; },
        });
        const result = await coord.tick({ trigger: 'turn-boundary', idle, now: 1000000 });
        expect(result).toMatchObject({ attempted: false });
        expect(releases).toBe(1);
    });
});

/**
 * The lease the product actually sends, through the real handler, into the
 * real callback.
 *
 * `cloudRuntimeReadinessPorts.ts:347` is the parent's only lease sender and it
 * sends **`managed:runtime-lease`**. Nothing in the product sends the
 * run-scoped `managed:lease` — only a wire fixture does. A re-arm gated on
 * `runId` therefore never ran outside a harness, which is exactly how the
 * first fix looked correct while every managed generation was still killed at
 * its spawn-time deadline.
 *
 * This drives a **real signed runtime-lease token** through
 * `createManagedRpcHandlers`, whose `onLeaseRenewed` calls the **same**
 * `rearmGenerationsForLease` the daemon runs — no re-stated copy of the
 * decision — and asserts what reached the fencing backend.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalManagedPayloadDigest, parseManagedVerifierKey } from './managedDispatchToken';
import { GATEWAY_ROUTES } from '@/managed/managedSpawnBootstrap';
import { MANAGED_PROJECT_ROOT } from './managedRuntimeIdentity';
import { createManagedReceiptStore } from './managedReceiptStore';
import { createManagedRpcHandlers, type ManagedRuntime } from './managedRpcHandlers';
import type { ManagedRuntimeIdentity } from './managedRuntimeIdentity';
import { enforceLeaseByRearming, rearmGenerationsForLease, type GenerationKey } from './managedGenerationRearm';

const keys = generateKeyPairSync('ed25519');
const verifier = parseManagedVerifierKey(keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer);
const NOW = 1_800_000_000_000;
const MONOTONIC = 10_000;

const identity = {
    runtimeId: 'runtime-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    keyId: 'kid-1',
    happyMachineId: 'machine-1',
    provisioningOperationId: 'op-1',
    configDigest: 'digest-1',
    providerMachineId: 'pm-1',
    providerInstanceId: 'pi-1',
    providerVolumeId: 'vol-1',
    verifier,
    stateDir: '/unused',
    isolation: {
        backend: 'privileged-launch-supervisor',
        provider: { uid: 901, gid: 901 },
        executor: { uid: 902, gid: 901 },
        cgroupRoot: '/c',
    },
    toolPolicy: { grantTtlMs: 600_000, callTimeoutMs: 120_000 },
    checkpoint: { drainBudgetMs: 15_000 },
    tenant: 'company:acme-1',
    checkpointSchedule: { periodMs: 900_000, onTurnBoundary: true },
} as unknown as ManagedRuntimeIdentity;

/** A genuinely signed runtime-lease token — the provisioning-scoped shape. */
function runtimeLeaseCall(overrides: Record<string, unknown> = {}) {
    const payload = {};
    const body = {
        v: 1,
        kid: 'kid-1',
        aud: 'runtime-1',
        op: 'runtime-lease',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        provisioningOperationId: 'op-1',
        requestKey: 'client-request-key',
        epoch: 0,
        payloadDigest: canonicalManagedPayloadDigest(payload),
        iat: NOW,
        exp: NOW + 60_000,
        renewalSeq: 1,
        leaseMs: 60_000,
        absoluteExpiry: NOW + 600_000,
        ...overrides,
    };
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return {
        token: `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`,
        params: payload,
    };
}

/** The bootstrap document the parent actually sends, built from the product's
 *  own route table so a moved route fails here rather than passing. */
function envelope(): Record<string, unknown> {
    const route = GATEWAY_ROUTES.find((candidate) => candidate.agent === 'claude')!;
    return {
        directory: MANAGED_PROJECT_ROOT,
        agent: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        initialPrompt: 'hello',
        initialPromptLocalId: 'local-1',
        bootstrap: {
            version: 1,
            serverOrigin: 'https://happy.example.test',
            sessionId: 'sess-1',
            encryptionVariant: 'dataKey',
            rawKeyBase64: Buffer.alloc(32, 9).toString('base64'),
            wrappedKeyBase64: Buffer.alloc(105, 8).toString('base64'),
            scopedToken: 'scoped.bearer.for.this.run',
            tokenExpiresAt: NOW + 3_600_000,
        },
        gateway: {
            baseUrl: `https://happy.example.test${route.path}`,
            capability: 'anthropic-messages',
            provider: route.provider,
            endpoint: route.endpoint,
            model: 'claude-opus-5',
        },
    };
}

/** A run-scoped spawn token, signed the same way. */
function spawnCall() {
    const payload = envelope();
    const body = {
        v: 1, kid: 'kid-1', aud: 'runtime-1', op: 'spawn',
        workspaceId: 'ws-1', projectId: 'proj-1',
        runId: 'r-new', attemptId: 'a-new',
        requestKey: 'spawn-request-key', epoch: 0,
        payloadDigest: canonicalManagedPayloadDigest(payload),
        iat: NOW, exp: NOW + 60_000,
    };
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return {
        token: `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`,
        params: payload,
    };
}

let root: string;
let runtimeStore: ReturnType<typeof createManagedReceiptStore>;
let renewCalls: Array<{ key: GenerationKey; renewalSeq: number; leaseExpiresMonotonic: number }>;
let renewAnswer: (key: GenerationKey) => Promise<{ renewed: boolean; detail: string }>;
let live: GenerationKey[];
let spawnDeadlines: number[];
let registerOnSpawn: GenerationKey | null;
let committed: Array<{ epoch: number; leaseExpiresMonotonic: number }>;
let handlers: ReturnType<typeof createManagedRpcHandlers>;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'managed-rearm-'));
    runtimeStore = createManagedReceiptStore(root, { assertHeld: () => {} });
    renewCalls = [];
    spawnDeadlines = [];
    registerOnSpawn = null;
    committed = [];
    renewAnswer = async () => ({ renewed: true, detail: 'ok' });
    live = [
        { runId: 'r1', attemptId: 'a1', epoch: 0 },
        { runId: 'r2', attemptId: 'a2', epoch: 0 },
        { runId: 'r3', attemptId: 'a3', epoch: 1 },
    ];

    const runtime = {
        identity,
        store: runtimeStore,
        spawn: async (_request: unknown, context: { leaseExpiresMonotonic: number }) => {
            spawnDeadlines.push(context.leaseExpiresMonotonic);
            if (registerOnSpawn) live = [...live, registerOnSpawn];
            return { type: 'success', sessionId: 's', pid: 1 };
        },
        isPidAlive: () => false,
        now: () => NOW,
        monotonicNow: () => MONOTONIC,
        // A promotion needs the privileged backend to say the previous
        // generation is gone; nothing inside this process can prove it.
        fencingBackend: {
            proveGenerationStopped: async () => ({ proven: true, detail: 'empty' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        },
        processGroupDeps: {
            kill: () => undefined,
            sleep: async () => undefined,
            now: () => NOW,
        },
        // The production callback, not a re-statement of it: the daemon's own
        // line is this call with its fencing backend in place of the double.
        onLeaseRenewed: (grant: Parameters<NonNullable<ManagedRuntime['onLeaseRenewed']>>[0]) =>
            enforceLeaseByRearming({
                grant,
                liveGenerations: () => live,
                renew: async (request) => {
                    renewCalls.push(request);
                    return renewAnswer(request.key);
                },
            }),
        onLeaseCommitted: (input: { epoch: number; leaseExpiresMonotonic: number }) => {
            committed.push(input);
        },
    } as unknown as ManagedRuntime;

    handlers = createManagedRpcHandlers(runtime);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('a signed runtime-lease reaching the fencing backend', () => {
    it('shouldReArmEveryGenerationAtThatEpochAlthoughTheGrantNamesNoRun', async () => {
        const granted = await handlers['runtime-lease'](runtimeLeaseCall());
        expect(granted).toMatchObject({ ok: true });

        expect(renewCalls.map((call) => call.key)).toEqual([
            { runId: 'r1', attemptId: 'a1', epoch: 0 },
            { runId: 'r2', attemptId: 'a2', epoch: 0 },
        ]);
        // The sequence that was committed, and the deadline the daemon now holds.
        expect(renewCalls.every((call) => call.renewalSeq === 1)).toBe(true);
        expect(new Set(renewCalls.map((call) => call.leaseExpiresMonotonic)).size).toBe(1);
    });

    it('shouldLeaveBehindAGenerationFromASupersededEpoch', async () => {
        // A promotion fences everything below the new epoch. Moving those
        // deadlines would extend the right to write for work that was just
        // proven stopped, so only the current epoch is re-armed.
        const granted = await handlers['runtime-lease'](runtimeLeaseCall({ epoch: 1, renewalSeq: 2 }));
        expect(granted).toMatchObject({ ok: true });
        expect(renewCalls.map((call) => call.key.runId)).toEqual(['r3']);
    });

    it('shouldAskOncePerGenerationEvenWhenItHasSeveralPids', async () => {
        // `managedGenerationForPid` is keyed by pid; two pids of one generation
        // are still one deadline.
        live = [
            { runId: 'r1', attemptId: 'a1', epoch: 0 },
            { runId: 'r1', attemptId: 'a1', epoch: 0 },
        ];
        await handlers['runtime-lease'](runtimeLeaseCall());
        expect(renewCalls).toHaveLength(1);
    });

    it('shouldReArmNothingWhenNoGenerationIsRunning', async () => {
        live = [];
        const granted = await handlers['runtime-lease'](runtimeLeaseCall());
        expect(granted).toMatchObject({ ok: true });
        expect(renewCalls).toEqual([]);
    });

    it('shouldRefuseTheGrantWhenOneGenerationCouldNotBeReArmed', async () => {
        // A parent told `ok` stops renewing, and the next thing that happens is
        // a kill at the old deadline that nobody expected. So a supervisor that
        // will not move the deadline has to make this a refusal.
        renewAnswer = async (key) => (key.runId === 'r2'
            ? { renewed: false, detail: 'stale-renewal' }
            : { renewed: true, detail: 'ok' });
        await expect(handlers['runtime-lease'](runtimeLeaseCall()))
            .rejects.toThrowError(/renewal-not-enforced/);
    });

    it('shouldNotExtendThisRuntimesLeaseAfterARefusal', async () => {
        // Refused, then retried at the next sequence. The retry has to be
        // accepted on its own merits — if the refused grant had been written,
        // this sequence would read as already spent and the run would be stuck
        // at a deadline nobody can move.
        renewAnswer = async () => ({ renewed: false, detail: 'stale-renewal' });
        await expect(handlers['runtime-lease'](runtimeLeaseCall())).rejects.toThrowError();

        renewAnswer = async () => ({ renewed: true, detail: 'ok' });
        await expect(handlers['runtime-lease'](runtimeLeaseCall({ renewalSeq: 2 })))
            .resolves.toMatchObject({ ok: true });
    });

    it('shouldHoldTheRpcOpenUntilTheSupervisorHasAnswered', async () => {
        // The ACK is the enforcement answer, not a hope about it: nothing may
        // resolve while the backend is still deciding.
        // One pending promise per live generation — releasing only the last
        // would leave the first outstanding and time out for the wrong reason.
        const pendingRenews: Array<(answer: { renewed: boolean; detail: string }) => void> = [];
        renewAnswer = () => new Promise((resolve) => { pendingRenews.push(resolve); });
        let settled = false;
        const pending = handlers['runtime-lease'](runtimeLeaseCall()).then(
            (value) => { settled = true; return value; },
            (error) => { settled = true; throw error; },
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(settled).toBe(false);
        expect(pendingRenews).toHaveLength(2);
        for (const resolve of pendingRenews) resolve({ renewed: true, detail: 'ok' });
        await expect(pending).resolves.toMatchObject({ ok: true });
    });

    it('shouldNotAdmitAGenerationWhileTheRenewalIsStillEnforcing', async () => {
        /*
         * The invariant the re-arm stands on.
         *
         * Astra's window was a spawn registering **after** the snapshot of live
         * generations and **before** the ACK — that generation is armed at the
         * old deadline and nobody moves it. The handler closes it by holding
         * the spawn until the renewal settles, so the snapshot is complete by
         * construction and the re-arm needs no second pass of its own.
         *
         * This asserts the holding, because if it ever stops holding, the
         * re-arm silently goes back to missing exactly that generation.
         */
        live = [{ runId: 'r1', attemptId: 'a1', epoch: 0 }];
        await expect(handlers['runtime-lease'](runtimeLeaseCall())).resolves.toMatchObject({ ok: true });
        registerOnSpawn = { runId: 'r-new', attemptId: 'a-new', epoch: 0 };
        renewCalls = [];

        const pendingRenews: Array<(answer: { renewed: boolean; detail: string }) => void> = [];
        renewAnswer = () => new Promise((resolve) => { pendingRenews.push(resolve); });
        const renewal = handlers['runtime-lease'](runtimeLeaseCall({ renewalSeq: 2, leaseMs: 120_000 }));
        await new Promise((resolve) => setTimeout(resolve, 5));

        const spawn = handlers.spawn(spawnCall());
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Held: nothing launched, so nothing registered behind the snapshot.
        expect(spawnDeadlines).toEqual([]);
        expect(renewCalls.map((call) => call.key.runId)).toEqual(['r1']);

        pendingRenews.shift()!({ renewed: true, detail: 'ok' });
        await expect(renewal).resolves.toMatchObject({ ok: true });
        await expect(spawn).resolves.toMatchObject({ accepted: true });
        // The newcomer was never part of this grant, and was never asked about.
        expect(renewCalls.map((call) => call.key.runId)).toEqual(['r1']);
    });

    it('shouldPublishReportCapabilityOnlyAfterTheLeaseIsOnDisk', async () => {
        /*
         * `run.ts` hangs report capability on the commit hook, not on the
         * enforcement callback. That is only sound if the hook really runs
         * after the write — otherwise a lease that failed to persist would
         * still have widened this runtime's right to report, which is what
         * Astra measured as `isLeaseValid()` true past the old deadline after
         * a `disk-full` throw.
         */
        live = [];
        const store = runtimeStore!;
        const realWrite = store.writeLease.bind(store);
        store.writeLease = () => { throw new Error('disk-full'); };
        await expect(handlers['runtime-lease'](runtimeLeaseCall())).rejects.toThrowError(/disk-full/);
        expect(committed).toEqual([]);

        store.writeLease = realWrite;
        await expect(handlers['runtime-lease'](runtimeLeaseCall())).resolves.toMatchObject({ ok: true });
        expect(committed).toEqual([{ epoch: 0, leaseExpiresMonotonic: MONOTONIC + 60_000 }]);
    });

    it('shouldNotPublishReportCapabilityForARefusedRenewal', async () => {
        // A refusal leaves the lease exactly where it was, so nothing may be
        // published against the deadline that was asked for.
        renewAnswer = async () => ({ renewed: false, detail: 'stale-renewal' });
        await expect(handlers['runtime-lease'](runtimeLeaseCall())).rejects.toThrowError();
        expect(committed).toEqual([]);
    });

    it('shouldCarryTheSupervisorsRefusalOutOfTheSharedCallback', async () => {
        // The callback's own contract, separate from the handler that consumes
        // it: which generations were moved and which code refused.
        const outcome = await rearmGenerationsForLease({
            grant: { epoch: 0, renewalSeq: 4, leaseExpiresMonotonic: 1 },
            liveGenerations: () => live,
            renew: async ({ key }) => (key.runId === 'r2'
                ? { renewed: false, detail: 'stale-renewal' }
                : { renewed: true, detail: 'ok' }),
        });
        expect(outcome.refused).toBe('stale-renewal');
        expect(outcome.rearmed).toEqual([{ runId: 'r1', attemptId: 'a1', epoch: 0 }]);
    });

    it('shouldNotCarryUnreviewedBackendTextOutOfTheRefusal', async () => {
        /*
         * `launcherClient.renew` forwards whatever the supervisor socket said,
         * and that string ends up in an RPC refusal and a log line. It is not
         * reviewed text — it crosses an IPC boundary — so anything outside the
         * known set becomes `unclassified` rather than travelling.
         */
        const outcome = await rearmGenerationsForLease({
            grant: { epoch: 0, renewalSeq: 4, leaseExpiresMonotonic: 1 },
            liveGenerations: () => [{ runId: 'r1', attemptId: 'a1', epoch: 0 }],
            renew: async () => ({ renewed: false, detail: '/root/.happy/access.key: EACCES' }),
        });
        expect(outcome.refused).toBe('unclassified');
    });

    it('shouldKeepTheSupervisorsOwnClassifier', async () => {
        // The recognised ones still travel: the parent acts on them.
        const outcome = await rearmGenerationsForLease({
            grant: { epoch: 0, renewalSeq: 4, leaseExpiresMonotonic: 1 },
            liveGenerations: () => [{ runId: 'r1', attemptId: 'a1', epoch: 0 }],
            renew: async () => ({ renewed: false, detail: 'already-stopped' }),
        });
        expect(outcome.refused).toBe('already-stopped');
    });

    it('shouldTreatAnUnreachableSupervisorAsARefusal', async () => {
        const outcome = await rearmGenerationsForLease({
            grant: { epoch: 0, renewalSeq: 4, leaseExpiresMonotonic: 1 },
            liveGenerations: () => [{ runId: 'r1', attemptId: 'a1', epoch: 0 }],
            renew: async () => { throw new Error('socket gone'); },
        });
        expect(outcome).toEqual({ rearmed: [], refused: 'unreachable' });
    });
});

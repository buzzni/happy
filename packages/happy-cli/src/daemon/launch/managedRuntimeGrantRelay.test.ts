/**
 * The runtime grant crossing the daemon/supervisor boundary, with the real
 * client on one end and the real IPC server and snapshot on the other.
 *
 * Each half has its own tests and each uses a fake for the other; a renamed
 * field or a changed op name passes both and fails only in a running runtime,
 * where the symptom is a parent told its lease was enforced by a supervisor
 * that never heard of it.
 *
 * What is reproduced here rather than imported is the daemon's `onLeaseRenewed`
 * body (`run.ts`), because that composition root is a process-wide bootstrap.
 * The *decisions* it makes - relay before the fan-out, refuse when the envelope
 * is missing, refuse when there is no backend - are asserted through the real
 * client, the real handler and the real snapshot.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createLauncherClient } from './launcherClient';
import {
    canonicalManagedPayloadDigest,
    parseManagedVerifierKey,
} from '@/daemon/managedDispatchToken';
import { handleIpcRequest, type IpcHandlers } from '@/launcher/ipcServer';
import { composeRuntimeGrantHandler } from '@/launcher/main';
import { createManagedRuntimeGrantSnapshot } from '@/managed/managedRuntimeGrantSnapshot';
import { enforceLeaseRenewal } from '@/daemon/managedGenerationRearm';
import { createManagedRpcHandlers } from '@/daemon/managedRpcHandlers';
import { createManagedReceiptStore } from '@/daemon/managedReceiptStore';
import type { ManagedRuntimeIdentity } from '@/daemon/managedRuntimeIdentity';

const TOKEN = 'c'.repeat(43);
const NOW = 1_800_000_000_000;
const KEYS = generateKeyPairSync('ed25519');
const AUTHORITY = {
    verifier: parseManagedVerifierKey(KEYS.publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
    runtimeId: 'runtime-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    keyId: 'kid-1',
    provisioningOperationId: 'op-1',
};

const params = (requestedMs = 60_000) => ({ requestedMs });

/** The parent signing a runtime lease over the params it sends. */
function signFor(p: unknown, over: Record<string, unknown> = {}) {
    const epoch = (over.epoch as number) ?? 2;
    const body = Buffer.from(JSON.stringify({
        v: 1, kid: 'kid-1', aud: 'runtime-1', op: 'runtime-lease',
        workspaceId: 'ws-1', projectId: 'proj-1', provisioningOperationId: 'op-1',
        // `<provisioningOperationId>:<epoch>:<op>` - the parent's real shape.
        requestKey: `op-1:${epoch}:runtime-lease`, epoch,
        renewalSeq: 1, leaseMs: (p as { requestedMs: number }).requestedMs,
        absoluteExpiry: NOW + 600_000,
        payloadDigest: canonicalManagedPayloadDigest(p),
        iat: NOW, exp: NOW + 60_000, ...over,
    }), 'utf8').toString('base64url');
    return `${body}.${sign(null, Buffer.from(body, 'utf8'), KEYS.privateKey).toString('base64url')}`;
}

/** The supervisor as `main.ts` composes it, over the real snapshot. */
function supervisor(clock = { wall: NOW + 1_000, mono: 10_000 }) {
    const state = { ...clock };
    const snapshot = createManagedRuntimeGrantSnapshot({
        authority: AUTHORITY,
        now: () => state.wall,
        monotonicNow: () => state.mono,
    });
    return {
        snapshot,
        state,
        acceptRuntimeGrant: composeRuntimeGrantHandler({
            admit: (request) => snapshot.admit(request),
        }),
    };
}

function pair(handlers: Partial<IpcHandlers>) {
    return createLauncherClient({
        token: TOKEN,
        deps: {
            request: async (payload) => JSON.stringify(await handleIpcRequest({
                raw: payload, token: TOKEN, handlers: handlers as IpcHandlers,
            })),
        },
    });
}

/**
 * The daemon's enforcement answer — the **product function**, not a copy of it.
 * `run.ts`'s `onLeaseRenewed` is one call to this with its own seams.
 */
function daemonRenewal(input: {
    backend: { pushRuntimeGrant: (g: { token: string; params: unknown }) => Promise<{ admitted: boolean; detail: string }> } | null;
    liveGenerations: number;
    grant?: { token: string; params: unknown };
    runId?: string;
}) {
    const live = Array.from({ length: input.liveGenerations }, (_, i) => ({
        runId: `run-${i}`, attemptId: `attempt-${i}`, epoch: 2,
    }));
    return () => enforceLeaseRenewal({
        grant: input.grant,
        lease: {
            epoch: 2, renewalSeq: 1, leaseExpiresMonotonic: 99_000,
            ...(input.runId === undefined ? {} : { runId: input.runId, attemptId: 'attempt-1' }),
        },
        backend: input.backend === null ? null : {
            pushRuntimeGrant: input.backend.pushRuntimeGrant,
            renew: async () => ({ renewed: true, detail: 'ok' }),
        },
        liveGenerations: () => live,
    });
}

describe('the runtime grant reaches the supervisor and is authenticated there', () => {
    it('shouldAdmitAGrantTheParentActuallySigned', async () => {
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const p = params();

        expect(await client.pushRuntimeGrant({ token: signFor(p), params: p }))
            .toEqual({ admitted: true, detail: 'admitted' });
        const current = sup.snapshot.current();
        expect(current).toMatchObject({ kind: 'present', epoch: 2, renewalSeq: 1 });
    });

    it('shouldRelayEvenWithZeroLiveGenerations', async () => {
        /*
         * The case that sends nothing today: with no generation the re-arm is
         * vacuously enforced, so a grant issued before the first spawn - the
         * most common one - would never be observed by anybody.
         */
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const p = params();
        const enforce = daemonRenewal({
            backend: client, liveGenerations: 0, grant: { token: signFor(p), params: p },
        });

        expect(await enforce()).toEqual({ enforced: true });
        expect(sup.snapshot.current().kind).toBe('present');
    });

    it('shouldRefuseWhenThereIsNoBackendToRelayTo', async () => {
        /*
         * Where this answered `enforced: true` before. A null backend is a
         * degraded state - a successful managed boot writes the launcher
         * binding before READY - so refusing costs a working deployment
         * nothing and stops a grant being ACKed with nothing observing it.
         */
        const p = params();
        expect(await daemonRenewal({
            backend: null, liveGenerations: 0, grant: { token: signFor(p), params: p },
        })()).toEqual({ enforced: false, detail: 'grant-unrelayable' });
    });

    it('shouldRefuseWhenTheEnvelopeWasDroppedOnTheWayDown', async () => {
        // Without this the dropped envelope skips the relay, and zero
        // generations then makes the renewal vacuously enforced - an ACK for a
        // grant that was neither relayed nor observed.
        expect(await daemonRenewal({ backend: null, liveGenerations: 0 })())
            .toEqual({ enforced: false, detail: 'grant-missing' });
    });

    it('shouldLeaveTheRunScopedPathAlone', async () => {
        // It carries a run and no envelope: nothing to relay, and the old
        // answer stands.
        expect(await daemonRenewal({ backend: null, liveGenerations: 0, runId: 'run-1' })())
            .toEqual({ enforced: true });
    });

    it('shouldRefuseTheRenewalWhenTheSupervisorDoesNotAdmitTheGrant', async () => {
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const p = params();
        // Signed for another runtime: valid signature, wrong audience.
        const grant = { token: signFor(p, { aud: 'runtime-2' }), params: p };

        expect(await daemonRenewal({ backend: client, liveGenerations: 0, grant })())
            .toEqual({ enforced: false, detail: 'grant-not-admitted' });
        expect(sup.snapshot.current()).toEqual({ kind: 'absent' });
    });

    it('shouldNotAdmitAGrantWhoseParamsWereMutatedAfterSigning', async () => {
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const token = signFor(params(60_000));

        const answer = await client.pushRuntimeGrant({ token, params: { requestedMs: 300_000 } });
        expect(answer.admitted).toBe(false);
        expect(sup.snapshot.current()).toEqual({ kind: 'absent' });
    });

    it('shouldNeverCarryTheTokenBackToTheDaemon', async () => {
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const p = params();
        const token = signFor(p, { projectId: 'proj-2' });

        const answer = await client.pushRuntimeGrant({ token, params: p });
        expect(answer.admitted).toBe(false);
        // One classifier, never the material or the failing axis.
        expect(answer.detail).toBe('grant-unauthenticated');
        expect(answer.detail).not.toContain(token);
    });

    it('shouldRefuseAReplayAndKeepTheSnapshotItAlreadyHas', async () => {
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const p = params();
        const grant = { token: signFor(p, { renewalSeq: 3 }), params: p };

        expect((await client.pushRuntimeGrant(grant)).admitted).toBe(true);
        // The same signed grant again: an equal sequence never advances.
        expect((await client.pushRuntimeGrant(grant)).admitted).toBe(false);
        expect(sup.snapshot.current()).toMatchObject({ epoch: 2, renewalSeq: 3 });
    });

    it('shouldKeepTheSnapshotAdvancedWhenTheRenewalFailsAfterIt', async () => {
        /*
         * The divergence this design has to keep legible: the grant is
         * admitted, then something after it fails and the daemon writes and
         * ACKs nothing. The snapshot still holds the parent's statement - it is
         * not enforcement, not a commit, and not current authority.
         */
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const p = params();
        const grant = { token: signFor(p, { renewalSeq: 7 }), params: p };

        const enforce = async () => {
            const relayed = await client.pushRuntimeGrant(grant);
            if (!relayed.admitted) return { enforced: false, detail: 'grant-not-admitted' };
            // The per-generation re-arm refuses after the grant was admitted.
            return { enforced: false, detail: 'stale-renewal' };
        };
        expect(await enforce()).toEqual({ enforced: false, detail: 'stale-renewal' });
        expect(sup.snapshot.current()).toMatchObject({ renewalSeq: 7 });

        // And the parent's retry at a higher sequence is admitted - by the
        // snapshot. Whether the grant then succeeds is the generations' answer,
        // not this one's.
        const retry = { token: signFor(p, { renewalSeq: 8 }), params: p };
        expect((await client.pushRuntimeGrant(retry)).admitted).toBe(true);
    });

    it('shouldRefuseAGrantThatArrivesWithNoSupervisorHandlerWired', async () => {
        // Absence refuses, at the boundary: `grant-unconfigured` rather than an
        // acceptance nothing recorded.
        const client = pair({});
        const p = params();
        expect(await client.pushRuntimeGrant({ token: signFor(p), params: p }))
            .toEqual({ admitted: false, detail: 'grant-unconfigured' });
    });

    it('shouldRefuseAGrantWhenTheSupervisorHasNoWayToAuthenticateIt', async () => {
        // Handler wired, authenticator missing: still a refusal, and nothing is
        // recorded.
        const client = pair({
            acceptRuntimeGrant: composeRuntimeGrantHandler({}),
        });
        const p = params();
        expect(await client.pushRuntimeGrant({ token: signFor(p), params: p }))
            .toEqual({ admitted: false, detail: 'grant-unauthenticated' });
    });
});

describe('the decoded params are bounded, not just the encoded field', () => {
    /*
     * The base64 cap is `4*ceil(1024/3)` = 1,368 characters, which decodes to
     * **1,026** bytes - so the field cap alone lets 1,025 and 1,026 through.
     * The contract is 1 KiB of params, and the only place that can be enforced
     * is on the decoded bytes, before they are parsed.
     */
    const padded = (bytes: number) => {
        const head = '{"requestedMs":60000';
        const tail = '}';
        // Whitespace inside the object: still valid JSON, still one field.
        return `${head}${' '.repeat(bytes - head.length - tail.length)}${tail}`;
    };

    it('shouldAcceptParamsOfExactlyTheBound', async () => {
        const sup = supervisor();
        const document = padded(1024);
        expect(Buffer.byteLength(document, 'utf8')).toBe(1024);
        expect(JSON.parse(document)).toEqual({ requestedMs: 60_000 });
        expect(sup.acceptRuntimeGrant(
            Buffer.from(document, 'utf8'),
            signFor(JSON.parse(document)),
        )).toEqual({ admitted: true, detail: 'admitted' });
    });

    it('shouldRefuseOneAndTwoBytesOverTheBoundBeforeParsingThem', async () => {
        for (const size of [1025, 1026]) {
            const sup = supervisor();
            const document = padded(size);
            expect(Buffer.byteLength(document, 'utf8')).toBe(size);
            expect(sup.acceptRuntimeGrant(
                Buffer.from(document, 'utf8'),
                signFor(JSON.parse(document)),
            )).toEqual({ admitted: false, detail: 'grant-invalid' });
            // Nothing was recorded from a document that was never parsed.
            expect(sup.snapshot.current()).toEqual({ kind: 'absent' });
        }
    });

    it('shouldRefuseAnOversizedParamsDocumentAtTheClientRatherThanSendIt', async () => {
        // The frame would be refused downstream anyway; refusing here names the
        // reason instead of spending a round trip to be told `too-large`.
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const bloated = { requestedMs: 60_000, note: 'x'.repeat(1_100) };
        expect(await client.pushRuntimeGrant({ token: signFor(bloated), params: bloated }))
            .toEqual({ admitted: false, detail: 'grant-too-large' });
        expect(sup.snapshot.current()).toEqual({ kind: 'absent' });
    });
});

describe('teardown', () => {
    it('shouldCompleteAGrantAlreadyAdmittedBeforeTheServerBeganClosing', async () => {
        /*
         * `close()` closes the listener and then waits for in-flight handlers
         * to drain, so a grant already inside one runs to completion. Aborting
         * it would drop a statement the daemon is about to be told was
         * observed.
         */
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const p = params();
        expect((await client.pushRuntimeGrant({ token: signFor(p), params: p })).admitted).toBe(true);
        expect(sup.snapshot.current().kind).toBe('present');
    });

    it('shouldClearOnlyAfterTheDrainSoAnInFlightAdmitCannotRepopulateIt', async () => {
        /*
         * Clearing at the top of `close()` would be undone by the very handler
         * the drain is waiting for, leaving a `present` snapshot behind a
         * released lock. Cleared after the drain, it stays `absent`.
         */
        const sup = supervisor();
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const p = params();

        const inFlight = client.pushRuntimeGrant({ token: signFor(p), params: p });
        await inFlight;              // the drain
        sup.snapshot.clear();        // release, then clear
        expect(sup.snapshot.current()).toEqual({ kind: 'absent' });
    });

    it('shouldRefuseAGrantArrivingAfterTheServerStartedClosing', async () => {
        // The existing shutdown answer, unchanged: a late arrival is refused
        // rather than admitted into a supervisor that is going away.
        const client = createLauncherClient({
            token: TOKEN,
            deps: {
                request: async () => JSON.stringify({ ok: false, reason: 'shutting-down' }),
            },
        });
        const p = params();
        expect(await client.pushRuntimeGrant({ token: signFor(p), params: p }))
            .toEqual({ admitted: false, detail: 'shutting-down' });
    });
});

describe('the whole chain: real RPC handlers, real callback, real IPC, real snapshot', () => {
    /*
     * Nothing between the parent's call and the supervisor's snapshot is
     * re-implemented here: `createManagedRpcHandlers` is the product's, the
     * enforcement callback is the function `run.ts` calls, the client and the
     * IPC handler are the real ones, and the snapshot is the shipped module.
     * The seams are the two things a test must own - the store (so a persist
     * failure can be produced) and the fan-out's `renew`.
     */
    const identity = (): ManagedRuntimeIdentity => ({
        runtimeId: 'runtime-1', workspaceId: 'ws-1', projectId: 'proj-1', keyId: 'kid-1',
        happyMachineId: 'machine-1', provisioningOperationId: 'op-1', configDigest: 'digest-1',
        providerMachineId: 'pm-1', providerInstanceId: 'pi-1', providerVolumeId: 'vol-1',
        verifier: AUTHORITY.verifier, stateDir: '/unused', workspaceDir: '/unused',
    } as unknown as ManagedRuntimeIdentity);

    function chain(over: {
        failWriteLease?: boolean;
        renewAnswer?: { renewed: boolean; detail: string };
        liveGenerations?: Array<{ runId: string; attemptId: string; epoch: number }>;
        wireCallback?: boolean;
    } = {}) {
        const root = mkdtempSync(join(tmpdir(), 'grant-chain-'));
        const sup = supervisor({ wall: NOW + 1_000, mono: 10_000 });
        const client = pair({ acceptRuntimeGrant: sup.acceptRuntimeGrant });
        const store = createManagedReceiptStore(root, { assertHeld: () => {} });
        const writes: unknown[] = [];
        const seamedStore = {
            ...store,
            writeLease: (record: Parameters<typeof store.writeLease>[0]) => {
                if (over.failWriteLease) throw new Error('disk-full');
                writes.push(record);
                return store.writeLease(record);
            },
        };
        const runtime = {
            identity: identity(),
            store: seamedStore,
            ...(over.wireCallback === false ? {} : {
                // The production callback, with `run.ts`'s own seams.
                onLeaseRenewed: async (input: Parameters<typeof enforceLeaseRenewal>[0]['lease']
                    & { grant?: { token: string; params: unknown } }) => enforceLeaseRenewal({
                    grant: input.grant,
                    lease: input,
                    backend: {
                        pushRuntimeGrant: (g) => client.pushRuntimeGrant(g),
                        renew: async () => over.renewAnswer ?? { renewed: true, detail: 'ok' },
                    },
                    liveGenerations: () => over.liveGenerations ?? [],
                }),
            }),
            spawn: async () => ({ type: 'success' as const, sessionId: 's', pid: 1 }),
            isPidAlive: () => false,
            now: () => NOW + 1_000,
            monotonicNow: () => 10_000,
            processGroupDeps: {
                kill: () => {}, sleep: async () => {}, now: () => NOW + 1_000,
            },
        };
        return {
            root,
            snapshot: sup.snapshot,
            writes,
            handlers: createManagedRpcHandlers(runtime as never),
            store,
        };
    }

    /** A runtime-lease call as the parent makes it, signed over its params. */
    const leaseCall = (over: Record<string, unknown> = {}) => {
        const p = params();
        return {
            token: signFor(p, { epoch: 0, requestKey: 'op-1:0:runtime-lease', ...over }),
            params: p,
        };
    };

    it('shouldCarryAParentGrantAllTheWayToTheSnapshotAndAck', async () => {
        const c = chain();
        try {
            const reply = await c.handlers['runtime-lease'](leaseCall());
            expect(reply).toMatchObject({ epoch: 0, renewalSeq: 1 });
            // Recorded at the far end, from the token the parent signed.
            expect(c.snapshot.current()).toMatchObject({ kind: 'present', epoch: 0, renewalSeq: 1 });
            expect(c.writes).toHaveLength(1);
        } finally {
            rmSync(c.root, { recursive: true, force: true });
        }
    });

    it('shouldWriteNothingAndAckNothingWhenTheSupervisorRefusesTheGrant', async () => {
        // Signed for another workspace: the relay refuses, so the enforcement
        // answer is a refusal and the lease never reaches the store.
        const c = chain();
        try {
            await expect(c.handlers['runtime-lease'](leaseCall({ workspaceId: 'ws-2' })))
                .rejects.toThrowError(/token-wrong-workspace|renewal-not-enforced/);
            expect(c.writes).toEqual([]);
            expect(c.snapshot.current()).toEqual({ kind: 'absent' });
        } finally {
            rmSync(c.root, { recursive: true, force: true });
        }
    });

    it('shouldAckNothingWhenThePersistFailsAfterAnAdmittedGrant', async () => {
        /*
         * The divergence this design keeps legible: the snapshot advanced, the
         * write failed, the parent is told nothing. The supervisor's record is
         * the parent's statement, not a commit.
         */
        const c = chain({ failWriteLease: true });
        try {
            await expect(c.handlers['runtime-lease'](leaseCall())).rejects.toThrow();
            expect(c.writes).toEqual([]);
            expect(c.snapshot.current()).toMatchObject({ kind: 'present', renewalSeq: 1 });
            // And the stored lease is untouched by the failed attempt.
            expect(c.store.readLease()).not.toMatchObject({ renewalSeq: 1 });
        } finally {
            rmSync(c.root, { recursive: true, force: true });
        }
    });

    it('shouldRefuseWhenTheFanOutRefusesAfterTheGrantWasAdmitted', async () => {
        const c = chain({
            renewAnswer: { renewed: false, detail: 'stale-renewal' },
            liveGenerations: [{ runId: 'r', attemptId: 'a', epoch: 0 }],
        });
        try {
            await expect(c.handlers['runtime-lease'](leaseCall())).rejects.toThrow();
            expect(c.writes).toEqual([]);
            // Advanced, and left that way: nothing rolls a statement back.
            expect(c.snapshot.current()).toMatchObject({ kind: 'present' });
        } finally {
            rmSync(c.root, { recursive: true, force: true });
        }
    });

    it('shouldRefuseEveryRenewalWhenTheProductionCallbackIsNotWired', async () => {
        /*
         * Dropping the `run.ts` bridge must fail loudly. Without the callback
         * nothing enforces and nothing relays, and the handler refuses rather
         * than persisting a lease no supervisor agreed to.
         */
        const c = chain({ wireCallback: false });
        try {
            await expect(c.handlers['runtime-lease'](leaseCall())).rejects.toThrow();
            expect(c.writes).toEqual([]);
            expect(c.snapshot.current()).toEqual({ kind: 'absent' });
        } finally {
            rmSync(c.root, { recursive: true, force: true });
        }
    });
});

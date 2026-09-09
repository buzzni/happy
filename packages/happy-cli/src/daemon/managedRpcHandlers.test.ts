import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalManagedPayloadDigest, parseManagedVerifierKey, type ManagedOp } from './managedDispatchToken';
import { createManagedReceiptStore, managedOperationKey } from './managedReceiptStore';
import {
    applyManagedRpcRestrictions,
    createManagedRpcHandlers,
    MANAGED_ALLOWED_RPCS,
    ManagedRpcError,
    type ManagedRuntime,
    type ManagedSpawnOutcome,
} from './managedRpcHandlers';
import type { ManagedRuntimeIdentity } from './managedRuntimeIdentity';

const keys = generateKeyPairSync('ed25519');
const verifier = parseManagedVerifierKey(keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer);

const NOW = 1_800_000_000_000;
const RUN = 'run-1';
const ATTEMPT = 'attempt-1';
const OP_KEY = managedOperationKey({ runId: RUN, attemptId: ATTEMPT });

let root: string;
let wallClock: number;
let monotonic: number;
let spawnCalls: number;
let spawnResult: () => Promise<ManagedSpawnOutcome>;
let runtime: ManagedRuntime;
let handlers: ReturnType<typeof createManagedRpcHandlers>;
let livePgids: Set<number>;
let killed: Array<[number, string | number]>;

const identity: ManagedRuntimeIdentity = {
    runtimeId: 'runtime-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    keyId: 'kid-1',
    verifier,
    stateDir: '/unused',
    isolation: { backend: 'privileged-launch-supervisor', agentUid: 901, cgroupRoot: '/c' },
};

function mint(op: ManagedOp, payload: unknown, overrides: Record<string, unknown> = {}): string {
    const body = {
        v: 1,
        kid: 'kid-1',
        aud: 'runtime-1',
        op,
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        runId: RUN,
        attemptId: ATTEMPT,
        requestKey: 'client-request-key',
        epoch: 0,
        payloadDigest: canonicalManagedPayloadDigest(payload),
        iat: NOW,
        exp: NOW + 60_000,
        ...overrides,
    };
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`;
}

function call(op: ManagedOp, payload: unknown = {}, overrides: Record<string, unknown> = {}) {
    return { token: mint(op, payload, overrides), params: payload };
}

async function grantLease(overrides: Record<string, unknown> = {}) {
    return handlers.lease(call('lease', {}, {
        renewalSeq: 1, leaseMs: 60_000, absoluteExpiry: NOW + 600_000, ...overrides,
    }));
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'managed-rpc-'));
    wallClock = NOW + 1_000;
    monotonic = 10_000;
    spawnCalls = 0;
    livePgids = new Set();
    killed = [];
    spawnResult = async () => ({ type: 'success', sessionId: 'sess-1', pid: 4242 });
    const store = createManagedReceiptStore(root, { assertHeld: () => {} });
    runtime = {
        identity,
        store,
        spawn: async () => { spawnCalls += 1; return spawnResult(); },
        isPidAlive: (pid) => livePgids.has(pid),
        now: () => wallClock,
        monotonicNow: () => monotonic,
        stopGraceMs: 20,
        processGroupDeps: {
            kill: (target, signal) => {
                killed.push([target, signal]);
                const pgid = Math.abs(target);
                if (signal === 0 && !livePgids.has(pgid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
                if (signal === 'SIGTERM' || signal === 'SIGKILL') livePgids.delete(pgid);
            },
            sleep: async (ms) => { wallClock += ms; },
            now: () => wallClock,
        },
    };
    handlers = createManagedRpcHandlers(runtime);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('token scope is checked against the trusted identity', () => {
    it('refuses a token whose projectId is not this runtime\'s project', async () => {
        await grantLease();
        await expect(handlers.spawn(call('spawn', { directory: '/w' }, { projectId: 'proj-2' })))
            .rejects.toThrowError(/token-wrong-project|wrong-project/);
        expect(spawnCalls).toBe(0);
    });

    it('refuses a token signed under a different key id', async () => {
        await grantLease();
        await expect(handlers.spawn(call('spawn', { directory: '/w' }, { kid: 'kid-2' })))
            .rejects.toThrowError(/key/);
        expect(spawnCalls).toBe(0);
    });
});

describe('lease', () => {
    it('starts expired so a restart cannot execute on an old deadline', async () => {
        expect(handlers.isLeaseValid()).toBe(false);
        await expect(handlers.spawn(call('spawn', { directory: '/w' })))
            .rejects.toThrowError(/lease-expired/);
        expect(spawnCalls).toBe(0);
    });

    it('grants a monotonic deadline clamped by the signed absolute expiry', async () => {
        // The token itself stays fresh; only the absolute expiry is close, so
        // the clamp — not the token check — is what this exercises.
        wallClock = NOW + 590_000;
        const result = await handlers.lease(call('lease', {}, {
            renewalSeq: 1,
            leaseMs: 60_000,
            absoluteExpiry: NOW + 600_000,
            iat: wallClock,
            exp: wallClock + 60_000,
        }));
        expect(result.grantedMs).toBe(10_000);
    });

    it('does not extend the deadline when a wall clock jumps backwards', async () => {
        await grantLease();
        expect(handlers.isLeaseValid()).toBe(true);
        monotonic += 120_000;
        wallClock -= 3_600_000;
        expect(handlers.isLeaseValid()).toBe(false);
    });

    it('refuses a replayed renewal sequence', async () => {
        await grantLease({ renewalSeq: 5 });
        await expect(grantLease({ renewalSeq: 5 })).rejects.toThrowError(/stale-renewal/);
        await expect(grantLease({ renewalSeq: 4 })).rejects.toThrowError(/stale-renewal/);
    });

    it('refuses to raise the epoch while no trusted fencing backend can prove it', async () => {
        await grantLease({ renewalSeq: 1, epoch: 0 });
        // Raising the epoch is what opens a new writable generation. Local
        // quiet cannot prove the previous one is gone, so without a backend
        // proof the promotion must not happen at all.
        await expect(grantLease({ renewalSeq: 2, epoch: 1 }))
            .rejects.toThrowError(/fence-proof-unavailable/);
    });

    it('leaves the stored epoch and deadline untouched after a refused promotion', async () => {
        await grantLease({ renewalSeq: 1, epoch: 0 });
        await expect(grantLease({ renewalSeq: 2, epoch: 1 })).rejects.toThrow();
        const lease = runtime.store.readLease();
        expect(lease.kind).toBe('ok');
        if (lease.kind === 'ok') {
            expect(lease.record.epoch).toBe(0);
            expect(lease.record.renewalSeq).toBe(1);
        }
    });

    it('refuses when the lease record cannot be read', async () => {
        await grantLease();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(root, 'lease.json'), '{broken');
        await expect(grantLease({ renewalSeq: 2 })).rejects.toThrowError(/lease-state-unreadable/);
    });
});

describe('spawn', () => {
    it('runs a request exactly once and returns the same receipt on retry', async () => {
        await grantLease();
        const first = await handlers.spawn(call('spawn', { directory: '/w' }));
        const second = await handlers.spawn(call('spawn', { directory: '/w' }));
        expect(spawnCalls).toBe(1);
        expect(second.receipt.operationKey).toBe(first.receipt.operationKey);
    });

    it('refuses a second spawn that carries different params under the same operation', async () => {
        await grantLease();
        await handlers.spawn(call('spawn', { directory: '/w' }));
        // Same run+attempt, different signed payload: this is a conflict, not a
        // retry, and answering it with the first result would hide the bug.
        await expect(handlers.spawn(call('spawn', { directory: '/other' })))
            .rejects.toThrowError(/operation-payload-conflict/);
        expect(spawnCalls).toBe(1);
    });

    it('records the payload digest without storing the payload', async () => {
        await grantLease();
        await handlers.spawn(call('spawn', { directory: '/secret-path', initialPrompt: 'secret text' }));
        const { readFileSync, readdirSync } = await import('node:fs');
        const dir = join(root, 'receipts');
        const raw = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
        expect(raw).not.toContain('secret text');
        expect(raw).not.toContain('/secret-path');
    });

    it('refuses a dispatch that a stop already tombstoned', async () => {
        await grantLease();
        await handlers.stop(call('stop', {}));
        await expect(handlers.spawn(call('spawn', { directory: '/w' })))
            .rejects.toThrowError(/stopped-before-dispatch/);
        expect(spawnCalls).toBe(0);
    });

    it('keeps an unexplained spawn failure recoverable instead of calling it failed', async () => {
        await grantLease();
        spawnResult = async () => { throw new Error('socket closed at /tmp/x with token abc'); };
        await expect(handlers.spawn(call('spawn', { directory: '/w' })))
            .rejects.toThrowError(ManagedRpcError);
        const stored = runtime.store.read(OP_KEY);
        expect(stored.kind).toBe('ok');
        // A child may already exist; recording `failed` would end the story for
        // a run that could still be writing.
        if (stored.kind === 'ok') expect(stored.receipt.state).toBe('spawning');
    });

    it('does not leak the underlying error text to the caller', async () => {
        await grantLease();
        spawnResult = async () => { throw new Error('token=abc123 at /home/u/.happy/access.key'); };
        await handlers.spawn(call('spawn', { directory: '/w' })).catch((error: Error) => {
            expect(error.message).not.toContain('abc123');
            expect(error.message).not.toContain('access.key');
        });
    });

    it('marks a run failed only on typed evidence that nothing started', async () => {
        await grantLease();
        spawnResult = async () => ({ type: 'error', errorMessage: 'bad directory', started: false });
        await expect(handlers.spawn(call('spawn', { directory: '/w' }))).rejects.toThrow();
        const stored = runtime.store.read(OP_KEY);
        if (stored.kind === 'ok') expect(stored.receipt.state).toBe('failed');
    });

    it('honours a stop that landed while the spawn was in flight', async () => {
        await grantLease();
        const stopCalls: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { stopCalls.push(input); return { requested: true, detail: 'ok' }; },
        };
        let release: () => void = () => {};
        spawnResult = () => new Promise((resolve) => {
            release = () => resolve({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        });
        const inFlight = handlers.spawn(call('spawn', { directory: '/w' }));
        await Promise.resolve();
        await handlers.stop(call('stop', {}));
        livePgids.add(4242);
        release();
        const result = await inFlight;
        expect(result.receipt.state).toBe('stopping');
        // The stop is carried out by the trusted backend, not by signalling a
        // pid this process happens to remember. Two requests are expected and
        // safe: the first while the pid is still unknown, the second once it is
        // — the backend is keyed by run/attempt/epoch and is idempotent.
        expect(stopCalls.length).toBeGreaterThanOrEqual(1);
        expect(stopCalls.every((c) => c.attemptId === ATTEMPT && c.runId === RUN)).toBe(true);
        expect(killed.filter(([, signal]) => signal !== 0)).toEqual([]);
    });

    it('refuses new work once the lease has expired', async () => {
        await grantLease({ leaseMs: 1_000 });
        monotonic += 2_000;
        await expect(handlers.spawn(call('spawn', { directory: '/w' })))
            .rejects.toThrowError(/lease-expired/);
    });
});

describe('lease expiry does not silently leave a child running', () => {
    it('reports an action-required handoff when no trusted backend can fence', async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', { directory: '/w' }));
        monotonic += 120_000;

        const outcome = await handlers.enforceLeaseExpiry();
        // Nothing here can stop a child that outlived the lease, so this must
        // say so rather than report a clean stop.
        expect(outcome.expired).toBe(true);
        expect(outcome.actionRequired).toBe(true);
        expect(outcome.live.length).toBeGreaterThan(0);
    });
});

describe('receipt query', () => {
    it('returns only the signed run and attempt scope', async () => {
        await grantLease();
        await handlers.spawn(call('spawn', { directory: '/w' }));
        runtime.store.claim({
            requestKey: managedOperationKey({ runId: 'run-2', attemptId: 'attempt-9' }),
            runId: 'run-2', attemptId: 'attempt-9', epoch: 0, now: wallClock,
        });
        const result = await handlers.receipt(call('query', {}));
        expect(result.receipts).toHaveLength(1);
        expect(result.receipts[0]!.runId).toBe(RUN);
    });

    it('reports an absent receipt without inventing one', async () => {
        await grantLease();
        const result = await handlers.receipt(call('query', {}));
        expect(result.receipts).toEqual([]);
    });

    it('does not call a spawning receipt determinate', async () => {
        await grantLease();
        spawnResult = async () => { throw new Error('unclear'); };
        await handlers.spawn(call('spawn', { directory: '/w' })).catch(() => {});
        const result = await handlers.receipt(call('query', {}));
        expect(result.receipts[0]!.certainty).toBe('uncertain');
    });
});

describe('managed runtime RPC allowlist', () => {
    it('refuses at the dispatch boundary, not by rewriting registrations', () => {
        const allowlisted: string[][] = [];
        applyManagedRpcRestrictions({
            setManagedAllowlist: (methods) => { allowlisted.push([...methods]); },
        });
        expect(allowlisted).toHaveLength(1);
        expect(allowlisted[0]).toEqual([...MANAGED_ALLOWED_RPCS]);
    });

    it('refuses to run against a manager that cannot gate dispatch', () => {
        // Silently doing nothing here would leave the whole legacy surface open
        // on a runtime that believes it is restricted.
        expect(() => applyManagedRpcRestrictions({}))
            .toThrowError(/dispatch-level allowlist/);
    });

    it('allows only the managed dispatch methods', () => {
        expect([...MANAGED_ALLOWED_RPCS].sort())
            .toEqual(['managed:lease', 'managed:receipt', 'managed:spawn', 'managed:stop']);
        for (const bypass of ['spawn-happy-session', 'stop-session', 'bash', 'ai-credential:apply']) {
            expect(MANAGED_ALLOWED_RPCS).not.toContain(bypass);
        }
    });
});

describe('lease serialization barrier', () => {
    it('refuses an epoch downgrade that queued behind a higher epoch', async () => {
        // A request minted while the runtime was at epoch 3 can arrive after a
        // promotion to 4 committed. Writing epoch 3 back would silently reopen
        // the generation that was just fenced.
        runtime.store.writeLease({ epoch: 4, renewalSeq: 10, updatedAt: wallClock });
        await expect(handlers.lease(call('lease', {}, {
            epoch: 3, renewalSeq: 11, leaseMs: 60_000, absoluteExpiry: NOW + 600_000,
        }))).rejects.toThrowError(/stale-epoch/);

        const lease = runtime.store.readLease();
        if (lease.kind === 'ok') expect(lease.record.epoch).toBe(4);
    });

    it('re-checks token expiry after an awaited fence', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => {
                // The fence took long enough that the token is no longer fresh.
                wallClock += 300_000;
                return { proven: true, detail: 'ok' };
            },
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        await grantLease({ renewalSeq: 1, epoch: 0 });
        await expect(handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
        }))).rejects.toThrowError(/token-expired|stale/);
    });
});

describe('lease expiry hands off by stable identity', () => {
    beforeEach(async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', { directory: '/w' }));
        monotonic += 120_000;
    });

    it('asks the backend to stop by run and attempt, not by pgid', async () => {
        const calls: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { calls.push(input); return { requested: true, detail: 'ok' }; },
        };
        await handlers.enforceLeaseExpiry();
        expect(calls).toHaveLength(1);
        // A pgid is meaningless to a backend that outlives this process.
        expect(calls[0]).toMatchObject({ runId: RUN, attemptId: ATTEMPT });
    });

    it('does not skip a receipt that never recorded a pgid', async () => {
        const calls: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { calls.push(input); return { requested: true, detail: 'ok' }; },
        };
        runtime.store.update(OP_KEY, { state: 'spawning', pid: null, pgid: null }, wallClock);
        await handlers.enforceLeaseExpiry();
        // `spawning` means a child may exist whose pid was never recorded.
        expect(calls).toHaveLength(1);
    });

    it('keeps action required when the backend cannot prove the stop', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        livePgids.delete(4242);
        const outcome = await handlers.enforceLeaseExpiry();
        // No local trace only means nothing is visible from here.
        expect(outcome.actionRequired).toBe(true);
    });

    it('clears action required only on a proven stop', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'provider stopped' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        const outcome = await handlers.enforceLeaseExpiry();
        expect(outcome.actionRequired).toBe(false);
    });
});

describe('epoch promotion barrier against an in-flight spawn', () => {
    it('refuses to fence while a spawn admitted before it is still launching', async () => {
        await grantLease({ renewalSeq: 1, epoch: 0 });
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };

        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', { directory: '/w' }));
        await Promise.resolve();
        await Promise.resolve();

        // The promotion must not complete while a child is still being started
        // under the old epoch — that is the writer the fence exists to exclude.
        await expect(handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
        }))).rejects.toThrowError(/fence-incomplete/);

        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        await inFlight;
    });

    it('passes the launcher a context taken from the verified token', async () => {
        await grantLease();
        let seen: unknown;
        runtime.spawn = async (_request, context) => {
            seen = context;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        // The caller-supplied params claim a different run; the launcher must
        // be told the signed one.
        await handlers.spawn({
            token: mint('spawn', { directory: '/w', runId: 'attacker-run' }),
            params: { directory: '/w', runId: 'attacker-run' },
        });
        expect(seen).toMatchObject({ runId: RUN, attemptId: ATTEMPT, epoch: 0, projectId: 'proj-1' });
    });
});

describe('stop always reaches the trusted backend', () => {
    function withBackend() {
        const calls: Array<Record<string, unknown>> = [];
        let result: { requested: boolean; detail: string } = { requested: true, detail: 'ok' };
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { calls.push(input); return result; },
        };
        return { calls, setResult: (r: typeof result) => { result = r; } };
    }

    it('delegates a stop for a receipt that never recorded a pgid', async () => {
        await grantLease();
        const backend = withBackend();
        // A persisted `spawning` receipt may have a live child whose pid was
        // never written down. Returning "no local trace" here leaves it running.
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'spawning', pid: null, pgid: null }, wallClock);

        await handlers.stop(call('stop', {}));
        expect(backend.calls).toHaveLength(1);
        expect(backend.calls[0]).toMatchObject({ runId: RUN, attemptId: ATTEMPT, epoch: 0 });
    });

    it('delegates a stop even when the local probe reports EPERM', async () => {
        await grantLease();
        const backend = withBackend();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', { directory: '/w' }));
        runtime.processGroupDeps!.kill = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };

        await handlers.stop(call('stop', {}));
        expect(backend.calls).toHaveLength(1);
    });

    it('reports a backend refusal instead of dropping it', async () => {
        await grantLease();
        const backend = withBackend();
        backend.setResult({ requested: false, detail: 'launcher-unavailable' });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', { directory: '/w' }));

        const outcome = await handlers.stop(call('stop', {}));
        // The intent is durable, the delivery failed, and nothing ended —
        // three facts that must not collapse into one flag.
        expect(outcome.stopIntentRecorded).toBe(true);
        expect(outcome.backendStop).toEqual({ requested: false, detail: 'launcher-unavailable' });
        expect(outcome.terminationProven).toBe(false);
    });

    it('reports that no backend exists rather than implying a stop', async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', { directory: '/w' }));
        const outcome = await handlers.stop(call('stop', {}));
        expect(outcome.stopIntentRecorded).toBe(true);
        expect(outcome.backendStop).toEqual({ requested: false, detail: 'no-launch-backend' });
        expect(outcome.terminationProven).toBe(false);
    });

    it('never signals a process group itself', async () => {
        await grantLease();
        withBackend();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', { directory: '/w' }));
        killed.length = 0;

        await handlers.stop(call('stop', {}));
        // A numeric pid is not authority: the kernel may have reused it.
        expect(killed.filter(([, signal]) => signal !== 0)).toEqual([]);
    });
});

describe('lease renewal, promotion and expiry share one serial section', () => {
    function backend(overrides: Partial<{ proven: boolean }> = {}) {
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: overrides.proven ?? true, detail: 'ok' }),
            requestStop: async (input) => { stops.push(input); return { requested: true, detail: 'ok' }; },
        };
        return stops;
    }

    it('does not let a stale expiry stop a child after a renewal committed', async () => {
        const stops = backend();
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', { directory: '/w' }));
        monotonic += 5_000;

        // The expiry sees an expired lease, but a renewal is queued behind it.
        // If the two are not serialized the expiry stops a child that the
        // renewal has just made legitimate again.
        const expiry = handlers.enforceLeaseExpiry();
        const renewal = handlers.lease(call('lease', {}, {
            renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000,
        }));
        const [expiryOutcome] = await Promise.all([expiry, renewal]);

        if (expiryOutcome.expired) {
            // Expiry ran first: the renewal must have observed a valid lease
            // afterwards, and no stop may be issued once it did.
            expect(handlers.isLeaseValid()).toBe(true);
        }
        const stopsAfterRenewal = stops.length;
        await handlers.enforceLeaseExpiry();
        expect(stops.length).toBe(stopsAfterRenewal);
    });

    it('blocks a new spawn until expiry handling has finished', async () => {
        backend();
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        monotonic += 5_000;
        let releaseStop: () => void = () => {};
        runtime.fencingBackend!.requestStop = () => new Promise((resolve) => {
            releaseStop = () => resolve({ requested: true, detail: 'ok' });
        });
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'running', pid: 4242, pgid: 4242 }, wallClock);

        const expiry = handlers.enforceLeaseExpiry();
        await Promise.resolve();
        const other = managedOperationKey({ runId: 'run-2', attemptId: 'a-2' });
        expect(other).not.toBe(OP_KEY);
        await expect(handlers.spawn(call('spawn', { directory: '/w' })))
            .rejects.toThrowError(/lease-expired|epoch-transition-in-progress/);
        releaseStop();
        await expiry;
    });

    it('re-checks token expiry inside the serial section, not only before it', async () => {
        backend();
        await grantLease({ renewalSeq: 1, epoch: 0 });
        // A promotion is queued first and takes long enough that the renewal
        // waiting behind it has aged out by the time it runs.
        let releaseProof: () => void = () => {};
        runtime.fencingBackend!.proveGenerationStopped = () => new Promise((resolve) => {
            releaseProof = () => { wallClock += 300_000; resolve({ proven: true, detail: 'ok' }); };
        });
        const promotion = handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
        }));
        await Promise.resolve();
        const stale = handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 3, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: NOW, exp: NOW + 60_000,
        }));
        releaseProof();
        await promotion.catch(() => undefined);
        await expect(stale).rejects.toThrowError(/token-expired/);
    });

    it('runs one watchdog tick at a time', async () => {
        backend();
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        monotonic += 5_000;
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'running', pid: 4242, pgid: 4242 }, wallClock);

        let inFlight = 0;
        let maxConcurrent = 0;
        runtime.fencingBackend!.requestStop = async () => {
            inFlight += 1;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return { requested: true, detail: 'ok' };
        };
        await Promise.all([
            handlers.enforceLeaseExpiry(),
            handlers.enforceLeaseExpiry(),
            handlers.enforceLeaseExpiry(),
        ]);
        expect(maxConcurrent).toBe(1);
    });

    it('exposes a barrier that waits for every in-flight lease operation', async () => {
        backend();
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        monotonic += 5_000;
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'running', pid: 4242, pgid: 4242 }, wallClock);

        let finished = false;
        runtime.fencingBackend!.requestStop = async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            finished = true;
            return { requested: true, detail: 'ok' };
        };
        void handlers.enforceLeaseExpiry();
        // Teardown must wait for whatever is running, not just the last tick.
        await handlers.drainLeaseWork();
        expect(finished).toBe(true);
    });
});

describe('spawn acceptance is not the stop delivery result', () => {
    it('still reports the run as accepted when the backend cannot take the stop', async () => {
        await grantLease();
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async () => ({ requested: false, detail: 'launcher-unavailable' }),
        };
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', { directory: '/w' }));
        await Promise.resolve();
        await handlers.stop(call('stop', {}));
        livePgids.add(4242);
        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });

        const result = await inFlight;
        // A child exists. Reporting this as not-accepted would let the caller
        // treat the run as never started and dispatch it a second time.
        expect(result.accepted).toBe(true);
        expect(result.receipt.sessionId).toBe('sess-1');
        expect(result.backendStop).toEqual({ requested: false, detail: 'launcher-unavailable' });
        expect(result.terminationProven).toBe(false);
    });
});

describe('expiry versus a spawn that is still in flight', () => {
    beforeEach(async () => {
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
    });

    it('records a durable stop intent on every live receipt it hands over', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        livePgids.add(4242);
        await handlers.spawn(call('spawn', { directory: '/w' }));
        monotonic += 5_000;

        await handlers.enforceLeaseExpiry();
        const stored = runtime.store.read(OP_KEY);
        expect(stored.kind).toBe('ok');
        // Without this the intent lives only in the backend call, so a process
        // that restarts mid-handover has no record that the run must stop.
        if (stored.kind === 'ok') expect(stored.receipt.stopRequestedAt).not.toBeNull();
    });

    it('stops a spawn that completes after the expiry ran', async () => {
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async (input) => { stops.push(input); return { requested: true, detail: 'ok' }; },
        };
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', { directory: '/w' }));
        await Promise.resolve();

        monotonic += 5_000;
        await handlers.enforceLeaseExpiry();

        livePgids.add(4242);
        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        const result = await inFlight;

        // The child arrived after its lease was gone; leaving it `running`
        // would keep a writer alive that the expiry believed it had handed over.
        expect(result.receipt.state).toBe('stopping');
        expect(stops.length).toBeGreaterThanOrEqual(1);
    });

    it('does not report a clean handover while a spawn is still launching', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', { directory: '/w' }));
        await Promise.resolve();
        monotonic += 5_000;

        const outcome = await handlers.enforceLeaseExpiry();
        // A proof taken now cannot cover a child that has not started yet.
        expect(outcome.actionRequired).toBe(true);

        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        await inFlight;
    });

    it('drains a launching spawn and its post-launch stop before teardown', async () => {
        let stopFinished = false;
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                stopFinished = true;
                return { requested: true, detail: 'ok' };
            },
        };
        let launched = false;
        spawnResult = async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            launched = true;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const inFlight = handlers.spawn(call('spawn', { directory: '/w' }));
        await Promise.resolve();
        monotonic += 5_000;
        await handlers.enforceLeaseExpiry();
        stopFinished = false;

        await handlers.drainLeaseWork();
        // The launcher window closes before the stop that follows it. Waiting
        // only for the launch would release the writer lock while that stop is
        // still writing to the receipt store.
        expect(launched).toBe(true);
        expect(stopFinished).toBe(true);
        await inFlight;
    });
});

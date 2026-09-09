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
        expect(killed.some(([, signal]) => signal === 'SIGTERM')).toBe(true);
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

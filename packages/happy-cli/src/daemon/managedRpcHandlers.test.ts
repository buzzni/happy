import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { createManagedSupervisorReadiness } from './managedSupervisorReadiness';
import { createLauncherClient } from './launch/launcherClient';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalManagedPayloadDigest, parseManagedVerifierKey, type ManagedOp } from './managedDispatchToken';
import { GATEWAY_ROUTES } from '@/managed/managedSpawnBootstrap';
import { MANAGED_PROJECT_ROOT } from './managedRuntimeIdentity';
import { createManagedReceiptStore, managedOperationKey } from './managedReceiptStore';
import {
    applyManagedRpcRestrictions,
    createManagedRpcHandlers,
    MANAGED_ALLOWED_RPCS,
    ManagedRpcError,
    registerManagedRpcHandlers,
    type ManagedRuntime,
    type ManagedSpawnOutcome,
} from './managedRpcHandlers';
import type { ManagedRuntimeIdentity } from './managedRuntimeIdentity';

const keys = generateKeyPairSync('ed25519');
const verifier = parseManagedVerifierKey(keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer);

const NOW = 1_800_000_000_000;
/**
 * A bootstrap envelope of the shape the parent actually sends.
 *
 * Built from the product's own route table rather than a copy of it: a literal
 * here would keep passing after the real one moved, and the gateway row is
 * matched whole by the parser precisely because a plausible-looking field is
 * the mistake worth catching.
 */
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
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
            // The runtime's clock, not the wall clock: the parser compares
            // against the time the handler passes it.
            tokenExpiresAt: NOW + 3_600_000,
        },
        gateway: {
            baseUrl: `https://happy.example.test${route.path}`,
            capability: 'anthropic-messages',
            provider: route.provider,
            endpoint: route.endpoint,
            model: 'claude-opus-5',
        },
        ...over,
    };
}

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
    happyMachineId: 'machine-1',
    provisioningOperationId: 'op-1',
    configDigest: 'digest-1',
    providerMachineId: 'provider-machine-1',
    providerInstanceId: 'provider-instance-1',
    providerVolumeId: 'vol_fixture_1',
    verifier,
    stateDir: '/unused',
    isolation: { backend: 'privileged-launch-supervisor', provider: { uid: 901, gid: 901 }, executor: { uid: 902, gid: 901 }, cgroupRoot: '/c' },
    toolPolicy: { grantTtlMs: 600_000, callTimeoutMs: 120_000 },
    checkpoint: { drainBudgetMs: 15_000 },
    tenant: 'company:acme-1',
    checkpointSchedule: { periodMs: 900_000, onTurnBoundary: true },
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
        /*
         * Production always wires this: the renewal has to reach the thing that
         * stops work. The fixture wires a consumer that confirms enforcement so
         * the ordinary lease tests exercise the ordinary path; the tests that
         * care about a refusing, throwing or absent consumer set their own.
         */
        onLeaseRenewed: async () => ({ enforced: true as const }),
        spawn: async () => { spawnCalls += 1; return spawnResult(); },
        isPidAlive: (pid) => livePgids.has(pid),
        now: () => wallClock,
        monotonicNow: () => monotonic,
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
        await expect(handlers.spawn(call('spawn', envelope(), { projectId: 'proj-2' })))
            .rejects.toThrowError(/token-wrong-project|wrong-project/);
        expect(spawnCalls).toBe(0);
    });

    it('refuses a token signed under a different key id', async () => {
        await grantLease();
        await expect(handlers.spawn(call('spawn', envelope(), { kid: 'kid-2' })))
            .rejects.toThrowError(/key/);
        expect(spawnCalls).toBe(0);
    });
});

describe('lease', () => {
    it('starts expired so a restart cannot execute on an old deadline', async () => {
        expect(handlers.isLeaseValid()).toBe(false);
        await expect(handlers.spawn(call('spawn', envelope())))
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
        const first = await handlers.spawn(call('spawn', envelope()));
        const second = await handlers.spawn(call('spawn', envelope()));
        expect(spawnCalls).toBe(1);
        expect(second.receipt.operationKey).toBe(first.receipt.operationKey);
    });

    it('refuses a second spawn that carries different params under the same operation', async () => {
        await grantLease();
        await handlers.spawn(call('spawn', envelope()));
        // Same run+attempt, different signed payload: this is a conflict, not a
        // retry, and answering it with the first result would hide the bug.
        await expect(handlers.spawn(call('spawn', envelope({ initialPrompt: 'a different prompt' }))))
            .rejects.toThrowError(/operation-payload-conflict/);
        expect(spawnCalls).toBe(1);
    });

    it('records the payload digest without storing the payload', async () => {
        await grantLease();
        await handlers.spawn(call('spawn', envelope({ initialPrompt: 'secret text' })));
        const { readFileSync, readdirSync } = await import('node:fs');
        const dir = join(root, 'receipts');
        const raw = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
        expect(raw).not.toContain('secret text');
        expect(raw).not.toContain('/secret-path');
    });

    it('refuses a dispatch that a stop already tombstoned', async () => {
        await grantLease();
        await handlers.stop(call('stop', {}));
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(/stopped-before-dispatch/);
        expect(spawnCalls).toBe(0);
    });

    it('keeps an unexplained spawn failure recoverable instead of calling it failed', async () => {
        await grantLease();
        spawnResult = async () => { throw new Error('socket closed at /tmp/x with token abc'); };
        await expect(handlers.spawn(call('spawn', envelope())))
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
        await handlers.spawn(call('spawn', envelope())).catch((error: Error) => {
            expect(error.message).not.toContain('abc123');
            expect(error.message).not.toContain('access.key');
        });
    });

    it('marks a run failed only on typed evidence that nothing started', async () => {
        await grantLease();
        spawnResult = async () => ({ type: 'error', errorMessage: 'bad directory', started: false });
        await expect(handlers.spawn(call('spawn', envelope()))).rejects.toThrow();
        const stored = runtime.store.read(OP_KEY);
        if (stored.kind === 'ok') expect(stored.receipt.state).toBe('failed');
    });

    it('keeps the launcher classifier so the refusal can be told apart', async () => {
        /*
         * `spawn-rejected` 하나로는 "봉투가 틀림" 과 "launch 가 거부됨" 이
         * 구분되지 않는다. 분류자 하나만 남기면 그 둘이 갈린다 — 원문은
         * 경로·자격을 담을 수 있으므로 옮기지 않는다.
         */
        await grantLease();
        spawnResult = async () => ({
            type: 'error', errorMessage: 'launch-refused:no-volume', started: false,
        });
        const error = await handlers.spawn(call('spawn', envelope())).catch((e: Error) => e);
        expect((error as Error).message).toBe('spawn-rejected: launch-refused');
        // 전선으로는 경계 이름 하나만 간다.
        expect((error as ManagedRpcError).diagnostic).toBe('launch-refused');
    });

    it('drops a detail that is merely well-formed, such as a digest or a token', async () => {
        /*
         * 문자 클래스와 길이는 allowlist 가 아니다 — 소문자 32 hex 는 그 검사를
         * 통과하지만 digest 이거나 bearer 일 수 있다. stage 이름만 남긴다.
         */
        await grantLease();
        const digest = 'a3f1c09e5b7d4826af10e93c5d7b6142';
        spawnResult = async () => ({
            type: 'error', errorMessage: `launch-refused:${digest}`, started: false,
        });
        const error = await handlers.spawn(call('spawn', envelope())).catch((e: Error) => e);
        expect((error as Error).message).toBe('spawn-rejected: launch-refused');
        expect((error as Error).message).not.toContain(digest);
        expect((error as ManagedRpcError).diagnostic).toBe('launch-refused');
    });

    it('refuses to carry launcher prose, keeping only that it was unclassified', async () => {
        await grantLease();
        spawnResult = async () => ({
            type: 'error',
            errorMessage: 'ENOENT: /Users/secret/path token=abc123',
            started: false,
        });
        const error = await handlers.spawn(call('spawn', envelope())).catch((e: Error) => e);
        expect((error as Error).message).toBe('spawn-rejected: unclassified');
        expect((error as ManagedRpcError).diagnostic).toBe('unclassified');
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
        const inFlight = handlers.spawn(call('spawn', envelope()));
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
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(/lease-expired/);
    });
});

describe('lease expiry does not silently leave a child running', () => {
    it('reports an action-required handoff when no trusted backend can fence', async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 120_000;

        const outcome = await handlers.runLeaseMaintenance();
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
        await handlers.spawn(call('spawn', envelope()));
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
        await handlers.spawn(call('spawn', envelope())).catch(() => {});
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

    it('serves every managed contract it registers, and nothing else', () => {
        /*
         * The gap the joint integration hit, and the reason no helper test
         * could: two lists, drifting. `managed:checkpoint` and
         * `managed:credential` were registered here and refused at the dispatch
         * boundary, so a managed runtime answered `MANAGED_CAPABILITY_REQUIRED`
         * for contracts it implements — a parent-issued checkpoint target could
         * not arrive at all, and a live runtime's bearer could not be renewed.
         * Both are signed contracts the parent already dispatches
         * (`managedRpcTransport.ts` carries both in its own list, and
         * `cloudRuntimeCredentialRenewal.ts` exists to send one), so this is
         * alignment with what exists, not a new surface.
         *
         * Asserted as an equality against what registration actually did,
         * rather than against a literal alone: a literal is the thing that went
         * stale.
         */
        const registered: string[] = [];
        registerManagedRpcHandlers(
            { registerHandler: (method: string) => { registered.push(method); } } as never,
            new Proxy({}, { get: () => async () => ({}) }) as never,
        );
        expect(registered.length).toBeGreaterThan(0);
        expect([...registered].sort()).toEqual([...MANAGED_ALLOWED_RPCS].sort());
    });

    it('allows only the managed dispatch methods', () => {
        expect([...MANAGED_ALLOWED_RPCS].sort())
            .toEqual([
                'managed:checkpoint', 'managed:credential',
                'managed:lease', 'managed:receipt', 'managed:runtime-lease',
                'managed:spawn', 'managed:status', 'managed:stop',
            ]);
        /*
         * Reachable is not trusted: each of those still passes its own handler's
         * token, scope and epoch checks, which have their own tests here.
         *
         * The legacy surface stays closed, and so does every name nobody
         * registered — including ones that merely look like a managed contract.
         * The prefix is not a pass.
         */
        for (const bypass of [
            'spawn-happy-session', 'stop-session', 'bash', 'ai-credential:apply',
            'requestShutdown', 'stop-daemon',
            'managed:checkpoint:execute', 'managed:spawn-session', 'managed:',
        ]) {
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
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 120_000;
    });

    it('asks the backend to stop by run and attempt, not by pgid', async () => {
        const calls: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async (input) => { calls.push(input); return { requested: true, detail: 'ok' }; },
        };
        await handlers.runLeaseMaintenance();
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
        await handlers.runLeaseMaintenance();
        // `spawning` means a child may exist whose pid was never recorded.
        expect(calls).toHaveLength(1);
    });

    it('keeps action required when the backend cannot prove the stop', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        livePgids.delete(4242);
        const outcome = await handlers.runLeaseMaintenance();
        // No local trace only means nothing is visible from here.
        expect(outcome.actionRequired).toBe(true);
    });

    it('clears action required only on a proven stop', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'provider stopped' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        const outcome = await handlers.runLeaseMaintenance();
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
        const inFlight = handlers.spawn(call('spawn', envelope()));
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
            token: mint('spawn', envelope({ runId: 'attacker-run' })),
            params: envelope({ runId: 'attacker-run' }),
        });
        expect(seen).toMatchObject({ runId: RUN, attemptId: ATTEMPT, epoch: 0, projectId: 'proj-1' });
    });
});

describe('the bootstrap envelope the launcher is handed', () => {
    /*
     * The launcher does not trust this process and parses the envelope again on
     * its own side. What this runtime owes it is that the bytes it parses are
     * bytes this runtime validated — and that a document which fails validation
     * never reaches it at all.
     */
    beforeEach(async () => {
        await grantLease();
    });

    it('hands over exactly what parsed, and nothing that rode along', async () => {
        let seen: { bootstrapEnvelope: Buffer; envelope: unknown } | undefined;
        runtime.spawn = async (_request, context) => {
            seen = context as never;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const payload = { ...envelope(), smuggled: 'a field nobody validated' };
        await handlers.spawn({ token: mint('spawn', payload), params: payload });

        const parsed = JSON.parse(seen!.bootstrapEnvelope.toString('utf8'));
        // The field is gone from the bytes that cross the boundary: only what
        // the parser produced is re-serialized.
        expect(parsed.smuggled).toBeUndefined();
        expect(parsed.bootstrap.scopedToken).toBe('scoped.bearer.for.this.run');
        expect(seen!.envelope).toEqual(parsed);
    });

    it.each([
        ['nothing but a directory', undefined],
        ['a directory that is not a path this runtime runs in', 'not-a-root'],
        ['a directory that is not the managed project root', { directory: '/somewhere/else' }],
        ['an agent this runtime does not support', { agent: 'not-an-agent' }],
        ['a gateway route belonging to another agent', { gateway: { baseUrl: 'https://happy.example.test/api/cloud/gateway/openai/v1/responses', capability: 'openai-responses', provider: 'openai', endpoint: 'openai-responses', model: 'claude-opus-5' } }],
        ['a model that disagrees with the gateway', { model: 'claude-sonnet-5' }],
        ['a raw key that is not 32 bytes', { bootstrap: { rawKeyBase64: Buffer.alloc(16).toString('base64') } }],
    ])('refuses %s without reaching the launcher', async (_name, over) => {
        let launched = false;
        runtime.spawn = async () => {
            launched = true;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const payload = over === undefined
            ? { directory: MANAGED_PROJECT_ROOT }
            : typeof over === 'string'
                ? { directory: over }
                : {
                    ...envelope(),
                    ...over,
                    ...(('bootstrap' in over)
                        ? { bootstrap: { ...(envelope().bootstrap as object), ...(over as { bootstrap: object }).bootstrap } }
                        : {}),
                };
        await expect(handlers.spawn({ token: mint('spawn', payload), params: payload }))
            .rejects.toThrowError(/spawn-rejected/);
        expect(launched).toBe(false);
    });

    it('names the field it refused and never the value', async () => {
        /*
         * The document holds a scoped bearer and the session's raw key. A
         * message that echoed the offending value would put one of them in a
         * log line, which is the one place a secret is copied without anybody
         * deciding to copy it.
         */
        const payload = {
            ...envelope(),
            bootstrap: { ...(envelope().bootstrap as object), scopedToken: '' },
        };
        const error = await handlers.spawn({ token: mint('spawn', payload), params: payload })
            .then(() => null, (caught: Error) => caught);
        expect(error).toBeTruthy();
        expect(error!.message).toContain('bootstrap.scopedToken');
        // Nothing from the document itself.
        expect(error!.message).not.toContain('scoped.bearer.for.this.run');
        expect(error!.message).not.toContain(Buffer.alloc(32, 9).toString('base64'));
    });
});

describe('the wire shape the parent sends', () => {
    /*
     * The defect this exists for: this handler looked for the envelope under a
     * field of its own, while the parent's builder returns those keys **flat**
     * and the dispatcher signs and forwards that shape unchanged. Every real
     * spawn was refused, and every test that built its own nested request still
     * passed.
     *
     * The cross-package half — that the parent's *actual* builder produces
     * exactly these keys — lives in the parent's own suite, because this
     * package has to build and test on a checkout where the parent does not
     * exist.
     */
    it('takes the envelope from the request itself, with nothing nested', async () => {
        await grantLease();
        let seen: { envelope: { bootstrap: { scopedToken: string } } } | undefined;
        runtime.spawn = async (_request, context) => {
            seen = context as never;
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const flat = envelope();
        await expect(handlers.spawn(call('spawn', flat)))
            .resolves.toMatchObject({ accepted: true, receipt: { state: 'running' } });
        expect(seen!.envelope.bootstrap.scopedToken).toBe('scoped.bearer.for.this.run');
    });

    it('refuses the same content nested under a field of its own', async () => {
        // The shape this handler briefly required. It is not the wire.
        await grantLease();
        const nested = { directory: MANAGED_PROJECT_ROOT, envelope: envelope() };
        await expect(handlers.spawn(call('spawn', nested)))
            .rejects.toThrowError(/spawn-rejected/);
    });
});

describe('taking a renewed credential', () => {
    /*
     * The runtime cannot renew its own — both control-plane routes that issue a
     * daemon credential require the parent's signature — and the file it was
     * delivered in is written once, at start. So this is the only way a
     * long-running runtime's bearer is ever replaced, and every refusal here is
     * a way the identity could be *moved* rather than renewed.
     */
    /**
     * A provisioning-scoped token, like `status` and unlike `spawn`.
     *
     * The identity outlives every run on this runtime, so the signature that
     * replaces it names the provisioning operation rather than a run.
     */
    function credentialToken(payload: unknown, over: Record<string, unknown> = {}): string {
        const body = {
            v: 1, kid: 'kid-1', aud: 'runtime-1',
            op: 'credential',
            workspaceId: 'ws-1', projectId: 'proj-1',
            provisioningOperationId: 'op-1', epoch: 0,
            requestKey: 'client-request-key',
            payloadDigest: canonicalManagedPayloadDigest(payload),
            iat: NOW, exp: NOW + 60_000,
            ...over,
        };
        const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
        return `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`;
    }

    function credentialCall(over: Record<string, unknown> = {}, tokenOver: Record<string, unknown> = {}) {
        const payload = {
            token: 'renewed.bearer',
            expiresAt: NOW + 3_600_000,
            // The identity the replacement claims. Signed into the digest, so
            // the runtime can compare it with what it holds.
            machineId: 'machine-1',
            serverOrigin: 'https://happy.example.test',
            ...over,
        };
        return { token: credentialToken(payload, tokenOver), params: payload };
    }

    it('writes it and reports the expiry that took', async () => {
        const taken: { token: string; expiresAt: number }[] = [];
        runtime.replaceCredential = async (input) => {
            taken.push(input);
            return { ok: true as const, expiresAt: input.expiresAt };
        };
        await expect(handlers.credential(credentialCall()))
            .resolves.toEqual({ accepted: true, expiresAt: NOW + 3_600_000 });
        expect(taken).toEqual([{
            token: 'renewed.bearer', expiresAt: NOW + 3_600_000,
            machineId: 'machine-1', serverOrigin: 'https://happy.example.test',
        }]);
    });

    it('reports the expiry the daemon wrote, not the one that was asked for', async () => {
        // The parent must be able to see which renewal actually took. Echoing
        // the request would make every push look applied.
        runtime.replaceCredential = async () => ({ ok: true as const, expiresAt: NOW + 10 });
        await expect(handlers.credential(credentialCall()))
            .resolves.toEqual({ accepted: true, expiresAt: NOW + 10 });
    });

    it('reports a replacement issued for another Machine', async () => {
        runtime.replaceCredential = async () => ({ ok: false as const, reason: 'credential-not-mine' as const });
        await expect(handlers.credential(credentialCall()))
            .rejects.toThrowError(/credential-not-mine/);
    });

    it('refuses one that is already past', async () => {
        // Writing it produces a runtime that authenticates once and stops.
        runtime.replaceCredential = async () => ({ ok: true as const, expiresAt: NOW + 3_600_000 });
        await expect(handlers.credential(credentialCall({ expiresAt: NOW - 1 })))
            .rejects.toThrowError(/credential-expired/);
    });

    it('passes a replacement that does not outlive the stored one to the daemon, and reports its refusal', async () => {
        /*
         * The comparison is the daemon's, because the stored expiry is on its
         * disk. What this asserts is that the refusal reaches the parent as a
         * code it can act on rather than as an unclassified failure — a parent
         * that cannot tell "already newer" from "broken" keeps retrying.
         */
        runtime.replaceCredential = async () => ({ ok: false as const, reason: 'credential-not-newer' as const });
        await expect(handlers.credential(credentialCall()))
            .rejects.toThrowError(/credential-not-newer/);
    });

    it('reports an unwritable credential rather than claiming the renewal took', async () => {
        runtime.replaceCredential = async () => ({ ok: false as const, reason: 'credential-unwritable' as const });
        await expect(handlers.credential(credentialCall()))
            .rejects.toThrowError(/credential-unwritable/);
    });

    it('says so when nothing is wired to accept one', async () => {
        // A parent that believes it renewed and did not is a parent that stops
        // trying, and the runtime dies at its own expiry.
        runtime.replaceCredential = undefined;
        await expect(handlers.credential(credentialCall()))
            .rejects.toThrowError(/capability-unavailable/);
    });

    it.each([
        ['no token', { token: '' }],
        ['a token that is not a string', { token: 42 }],
        ['an expiry that is not an integer', { expiresAt: 1.5 }],
        ['no Machine named', { machineId: '' }],
        ['no origin named', { serverOrigin: '' }],
    ])('refuses a body with %s', async (_name, over) => {
        runtime.replaceCredential = async () => ({ ok: true as const, expiresAt: NOW + 3_600_000 });
        await expect(handlers.credential(credentialCall(over)))
            .rejects.toThrowError(/malformed-request/);
    });

    it('refuses once entries are closed, and is waited for by teardown', async () => {
        /*
         * Two properties every other RPC has and this one did not.
         *
         * A credential push accepted after `closeEntries` writes the runtime's
         * identity while teardown believes nothing is running, and one that is
         * not tracked lets teardown finish while the write is still in flight —
         * a half-written credential is exactly the state the write-once file
         * exists to prevent.
         */
        let release!: () => void;
        const inFlight = new Promise<void>((resolve) => { release = resolve; });
        runtime.replaceCredential = async () => {
            await inFlight;
            return { ok: true as const, expiresAt: NOW + 3_600_000 };
        };
        const pending = handlers.credential(credentialCall());
        // Teardown must wait for it: the drain does not settle while it runs.
        let drained = false;
        void handlers.drainLeaseWork().then(() => { drained = true; });
        await new Promise((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        release();
        await pending;
        await handlers.drainLeaseWork();

        handlers.closeEntries();
        await expect(handlers.credential(credentialCall()))
            .rejects.toThrowError(/shutting-down/);
    });

    it('refuses a signature for a different operation', async () => {
        /*
         * The point of giving this its own operation: an assertion authorising
         * work on a run must not also be able to replace the bearer the runtime
         * authenticates with.
         */
        runtime.replaceCredential = async () => ({ ok: true as const, expiresAt: NOW + 3_600_000 });
        const payload = { token: 'renewed.bearer', expiresAt: NOW + 3_600_000 };
        await expect(handlers.credential({ token: credentialToken(payload, { op: 'status' }), params: payload }))
            .rejects.toThrowError(/token-/);
    });
});

describe('telling the launcher what the lease now is', () => {
    /*
     * The deadline lives here and the thing that enforces it lives in the
     * launcher. Without this call the two drift apart on the very first
     * renewal: the parent believes it extended the lease, this module agrees,
     * and what actually stops work — and what decides whether a managed child
     * may still report activity — is still holding the deadline the run started
     * with.
     */
    it('reports the new deadline after a verified renewal, with the run it was granted for', async () => {
        const renewals: unknown[] = [];
        runtime.onLeaseRenewed = async (input) => {
            renewals.push(input);
            return { enforced: true };
        };
        await grantLease();
        expect(renewals).toHaveLength(1);
        expect(renewals[0]).toMatchObject({ epoch: 0, runId: RUN, attemptId: ATTEMPT });
        expect((renewals[0] as { leaseExpiresMonotonic: number }).leaseExpiresMonotonic)
            .toBeGreaterThan(monotonic);
    });

    it('refuses the renewal when nothing enforces it, and persists nothing', async () => {
        /*
         * A renewal that does not reach the thing which stops work is worse than
         * a refusal: the parent is told `ok`, stops renewing, and the generation
         * is killed at the deadline captured when it launched — which is exactly
         * what a live run did, to the millisecond.
         *
         * So the consumer is awaited and its answer decides. Nothing is written
         * before it: a store that recorded the extension while the enforcer kept
         * the old deadline is this runtime lying to itself.
         */
        const before = runtime.store.readLease();
        runtime.onLeaseRenewed = async () => ({ enforced: false, detail: 'never-launched' });
        await expect(grantLease()).rejects.toThrowError(/renewal-not-enforced/);
        expect(runtime.store.readLease()).toEqual(before);
    });

    it('refuses the renewal when the enforcement attempt itself throws', async () => {
        // 이유는 소비자의 것이다. 집행되지 않았다는 사실만으로 거절한다.
        runtime.onLeaseRenewed = async () => { throw new Error('/var/run/launcher.sock: ECONNREFUSED'); };
        await expect(grantLease()).rejects.toThrowError(/renewal-not-enforced/);
    });

    it('refuses when no consumer is wired at all, rather than masking it', async () => {
        /*
         * 예전에는 콜백이 없거나 아무 답도 안 하면 성공으로 봤다. 그것이 정확히
         * **배선이 끊긴 것을 가리는** 방법이었다 — production 은 이 콜백을 반드시
         * 꽂고, 꽂히지 않았다면 그 갱신은 집행된 적이 없다. 그래서 거절한다.
         */
        delete (runtime as { onLeaseRenewed?: unknown }).onLeaseRenewed;
        await expect(grantLease()).rejects.toThrowError(/renewal-not-enforced/);
    });

    it('does not extend local admission when the lease record cannot be written', async () => {
        /*
         * 집행은 성공했는데 기록이 실패하면, 이 프로세스만 연장된 권한을 갖는다 —
         * store 는 옛 lease 이고 부모는 거절을 받는다. 그 상태로 `isLeaseValid()`
         * 가 옛 deadline 을 넘겨 true 이면, 아무도 동의하지 않은 권한으로 일을
         * 계속 admit 한다. Astra 가 재현한 그 결함이다.
         */
        await grantLease();
        const stored = runtime.store.readLease();
        monotonic += 50_000;
        runtime.onLeaseRenewed = async () => ({ enforced: true });
        runtime.store.writeLease = () => { throw new Error('disk-full'); };

        await expect(grantLease({ renewalSeq: 2 })).rejects.toThrowError(/disk-full/);

        // 기록은 그대로고, 이 프로세스의 권한도 그대로다.
        expect(runtime.store.readLease()).toEqual(stored);
        monotonic += 11_000;
        expect(handlers.isLeaseValid()).toBe(false);
    });

    it('publishes the committed deadline once on a promotion, not twice', async () => {
        /*
         * 승격 경로는 보통 갱신과 **다른 분기**다. 그쪽에 공개 호출이 두 번 있으면
         * 권한을 넓히는 소비자가 같은 lease 로 두 번 불리고, 테스트는 조용히
         * 통과한다 — 실제로 제 편집 사고로 그 분기에 한 줄이 중복돼 있었고 129건이
         * 전부 녹색이었다. 그래서 **횟수**를 세는 회귀가 필요하다.
         */
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        const committed: unknown[] = [];
        runtime.onLeaseCommitted = (input) => { committed.push(input); };
        runtime.onLeaseRenewed = async () => ({ enforced: true });

        await grantLease({ epoch: 1, renewalSeq: 1 });

        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ epoch: 1, runId: RUN, attemptId: ATTEMPT });
    });

    it('publishes the committed deadline only after the record is written', async () => {
        // 권한을 넓히는 쪽(report capability 등)은 기록 뒤에만 알림을 받는다.
        const committed: unknown[] = [];
        runtime.onLeaseCommitted = (input) => { committed.push(input); };
        runtime.onLeaseRenewed = async () => ({ enforced: true });
        await grantLease();
        expect(committed).toHaveLength(1);

        committed.length = 0;
        runtime.store.writeLease = () => { throw new Error('disk-full'); };
        await expect(grantLease({ renewalSeq: 2 })).rejects.toThrowError(/disk-full/);
        // 기록이 실패했으면 아무것도 넓히지 않는다.
        expect(committed).toEqual([]);
    });

    it('makes a spawn wait for the renewal window, so it registers on the enforced deadline', async () => {
        /*
         * 갱신이 집행과 기록 사이에 있을 때 들어온 spawn 이 그냥 통과하면, 그
         * 세대는 **옛** deadline 을 들고 시작하고 이 갱신의 snapshot 밖이라 아무도
         * 다시 재무장하지 않는다 — 부모는 `ok` 를 받고 갱신을 멈춘다. Astra 가
         * 그것을 측정했다(신참은 70_000, 갱신은 100_000).
         *
         * 거절도 창을 닫지만 기다리는 편이 낫다: 창은 집행 한 번 + 기록 한 번이고,
         * 그 뒤에 등록되면 실제로 집행되는 deadline 을 들고 시작한다.
         */
        await grantLease();
        monotonic += 30_000;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
            runtime.onLeaseRenewed = () => {
                resolve();
                return new Promise((settle) => { release = () => settle({ enforced: true }); });
            };
        });
        const renewing = grantLease({ renewalSeq: 2 });
        await entered;

        let context: { leaseExpiresMonotonic: number } | undefined;
        runtime.spawn = async (_request, given) => {
            context = given as { leaseExpiresMonotonic: number };
            return { type: 'success', sessionId: 'sess-1', pid: 4242 };
        };
        const spawning = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        // 아직 창 안이다 — spawn 은 등록을 시작하지 않았다.
        expect(context).toBeUndefined();

        release();
        await renewing;
        await spawning;
        // 집행된 deadline 으로 등록됐다.
        expect(context?.leaseExpiresMonotonic).toBe(monotonic + 60_000);
    });

    it('refuses a renewal while a spawn is still on its way to being registered', async () => {
        // 반대 방향도 같다: 이미 들어온 spawn 이 등록되기 전이면 그 세대는 갱신의
        // snapshot 에 없다.
        await grantLease();
        let releaseSpawn!: () => void;
        spawnResult = () => new Promise((resolve) => {
            releaseSpawn = () => resolve({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        });
        const spawning = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        await expect(grantLease({ renewalSeq: 2 })).rejects.toThrowError(/renewal-race/);
        releaseSpawn();
        await spawning;
    });

    it('grants when the consumer confirms the extension is enforced', async () => {
        runtime.onLeaseRenewed = async () => ({ enforced: true });
        await expect(grantLease()).resolves.toMatchObject({ ok: true, renewalSeq: 1 });
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok' });
    });

    it('says nothing when the renewal was refused', async () => {
        // Folding a refusal into an extension would make the expiry meaningless
        // — the registry would keep a capability the runtime does not have.
        const renewals: unknown[] = [];
        await grantLease();
        runtime.onLeaseRenewed = (input) => { renewals.push(input); };
        await expect(grantLease({ renewalSeq: 1 })).rejects.toThrowError(/stale-renewal/);
        expect(renewals).toEqual([]);
    });
});

describe('withdrawing what a generation was allowed to do', () => {
    /*
     * A report accepted after the child is gone re-registers state for a
     * generation that no longer exists, and nothing later removes it. The
     * capability has to be withdrawn by whatever ends the generation — and the
     * two things that actually end one are the stop RPC and the watchdog, not
     * the session paths that were doing it.
     */
    it('withdraws before the stop is requested, on the explicit stop', async () => {
        const order: string[] = [];
        runtime.onGenerationTerminated = (input) => {
            order.push(`withdrawn:${input.runId}:${input.attemptId}:${input.epoch}`);
        };
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'stopped' }),
            requestStop: async () => {
                order.push('stop-requested');
                return { requested: true, detail: 'asked' };
            },
        };
        await grantLease();
        await handlers.spawn(call('spawn', envelope()));
        await handlers.stop(call('stop', {}));

        // Withdrawn first: the window in which a late report could land is
        // closed, not merely short.
        expect(order).toEqual([`withdrawn:${RUN}:${ATTEMPT}:0`, 'stop-requested']);
    });

    it('withdraws when the lease runs out, not only when somebody asks', async () => {
        // The watchdog path ends a generation without an RPC. It used to leave
        // the capability standing.
        const withdrawn: unknown[] = [];
        runtime.onGenerationTerminated = (input) => { withdrawn.push(input); };
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'stopped' }),
            requestStop: async () => ({ requested: true, detail: 'asked' }),
        };
        await grantLease();
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 120_000;
        await handlers.runLeaseMaintenance();
        expect(withdrawn).toEqual([{ runId: RUN, attemptId: ATTEMPT, epoch: 0 }]);
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
        await handlers.spawn(call('spawn', envelope()));
        runtime.processGroupDeps!.kill = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };

        await handlers.stop(call('stop', {}));
        expect(backend.calls).toHaveLength(1);
    });

    it('reports a backend refusal instead of dropping it', async () => {
        await grantLease();
        const backend = withBackend();
        backend.setResult({ requested: false, detail: 'launcher-unavailable' });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));

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
        await handlers.spawn(call('spawn', envelope()));
        const outcome = await handlers.stop(call('stop', {}));
        expect(outcome.stopIntentRecorded).toBe(true);
        expect(outcome.backendStop).toEqual({ requested: false, detail: 'no-launch-backend' });
        expect(outcome.terminationProven).toBe(false);
    });

    it('never signals a process group itself', async () => {
        await grantLease();
        withBackend();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
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
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 5_000;

        // The expiry sees an expired lease, but a renewal is queued behind it.
        // If the two are not serialized the expiry stops a child that the
        // renewal has just made legitimate again.
        const expiry = handlers.runLeaseMaintenance();
        const renewal = handlers.lease(call('lease', {}, {
            renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000,
        }));
        const [expiryOutcome] = await Promise.all([expiry, renewal]);

        expect(handlers.isLeaseValid()).toBe(true);
        const obligation = runtime.store.read(OP_KEY);
        expect(obligation.kind).toBe('ok');

        const before = stops.length;
        await handlers.runLeaseMaintenance();
        if (expiryOutcome.expired && obligation.kind === 'ok'
            && obligation.receipt.stopRequestedAt !== null) {
            // The expiry got there first and recorded the obligation, so the
            // retry continues — a renewal restores the right to run new work,
            // not the right to forget a stop (see the obligation suite below).
            expect(stops.length).toBeGreaterThan(before);
        } else {
            // The renewal got there first: the lease was valid when the expiry
            // looked, so it must not have invented an obligation at all.
            expect(stops.length).toBe(before);
        }
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

        const expiry = handlers.runLeaseMaintenance();
        await Promise.resolve();
        const other = managedOperationKey({ runId: 'run-2', attemptId: 'a-2' });
        expect(other).not.toBe(OP_KEY);
        await expect(handlers.spawn(call('spawn', envelope())))
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
            handlers.runLeaseMaintenance(),
            handlers.runLeaseMaintenance(),
            handlers.runLeaseMaintenance(),
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
        void handlers.runLeaseMaintenance();
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
        const inFlight = handlers.spawn(call('spawn', envelope()));
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
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 5_000;

        await handlers.runLeaseMaintenance();
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
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();

        monotonic += 5_000;
        await handlers.runLeaseMaintenance();

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
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        monotonic += 5_000;

        const outcome = await handlers.runLeaseMaintenance();
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
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();
        monotonic += 5_000;
        await handlers.runLeaseMaintenance();
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

describe('shutdown entry gate is separate from store ownership', () => {
    it('refuses a new spawn once entries are closed', async () => {
        await grantLease();
        handlers.closeEntries();
        await expect(handlers.spawn(call('spawn', envelope())))
            .rejects.toThrowError(/shutting-down/);
        expect(spawnCalls).toBe(0);
    });

    it('refuses a new stop and a new lease once entries are closed', async () => {
        await grantLease();
        handlers.closeEntries();
        await expect(handlers.stop(call('stop', {}))).rejects.toThrowError(/shutting-down/);
        await expect(grantLease({ renewalSeq: 9 })).rejects.toThrowError(/shutting-down/);
    });

    it('lets an already-entered spawn finish its bookkeeping', async () => {
        await grantLease();
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        spawnResult = () => new Promise((resolve) => { release = resolve; });
        const inFlight = handlers.spawn(call('spawn', envelope()));
        await Promise.resolve();

        handlers.closeEntries();
        release({ type: 'success', sessionId: 'sess-1', pid: 4242 });
        const result = await inFlight;

        // Closing the door must not undo work that is already inside.
        expect(result.accepted).toBe(true);
        const stored = runtime.store.read(OP_KEY);
        if (stored.kind === 'ok') expect(stored.receipt.state).toBe('running');
    });
});

describe('explicit stop is drained too', () => {
    it('waits for a stop that is still handing over to the backend', async () => {
        await grantLease();
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));

        let handoverFinished = false;
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: false, detail: 'unproven' }),
            requestStop: async () => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                handoverFinished = true;
                return { requested: true, detail: 'ok' };
            },
        };
        void handlers.stop(call('stop', {}));
        await Promise.resolve();

        await handlers.drainLeaseWork();
        // Without tracking the stop RPC the drain finds nothing outstanding and
        // the writer lock goes while the handover is still in progress.
        expect(handoverFinished).toBe(true);
    });
});

describe('a stop obligation survives a lease renewal', () => {
    async function refusedExpiryStop() {
        let accept = false;
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: accept, detail: 'x' }),
            requestStop: async (input) => {
                stops.push(input);
                return accept ? { requested: true, detail: 'ok' } : { requested: false, detail: 'down' };
            },
        };
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 5_000;
        const expiry = await handlers.runLeaseMaintenance();
        expect(expiry.actionRequired).toBe(true);
        return { stops, acceptFrom: () => { accept = true; } };
    }

    it('keeps retrying after a same-epoch renewal extends the deadline', async () => {
        const ctx = await refusedExpiryStop();
        const beforeRenewal = ctx.stops.length;

        await handlers.lease(call('lease', {}, {
            renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000,
        }));
        expect(handlers.isLeaseValid()).toBe(true);

        // The obligation was already recorded; a renewal restores the right to
        // run new work, not the right to forget a stop that was refused.
        ctx.acceptFrom();
        const tick = await handlers.runLeaseMaintenance();
        expect(ctx.stops.length).toBeGreaterThan(beforeRenewal);
        expect(tick.pendingStopsRetried).toBe(1);
    });

    it('stops retrying once the receipt reaches a trusted terminal state', async () => {
        const ctx = await refusedExpiryStop();
        runtime.store.update(OP_KEY, { state: 'stopped' }, wallClock);
        const before = ctx.stops.length;
        const tick = await handlers.runLeaseMaintenance();
        expect(ctx.stops.length).toBe(before);
        expect(tick.pendingStopsRetried).toBe(0);
    });

    it('does not treat a recorded stop request as a termination', async () => {
        const ctx = await refusedExpiryStop();
        const stored = runtime.store.read(OP_KEY);
        expect(stored.kind).toBe('ok');
        if (stored.kind === 'ok') {
            expect(stored.receipt.stopRequestedAt).not.toBeNull();
            // Requested is not terminated: the receipt must not have moved to a
            // terminal state on the strength of an unaccepted handover.
            expect(stored.receipt.state).not.toBe('stopped');
        }
        expect(ctx.stops.length).toBeGreaterThan(0);
    });

    it('reports the outstanding obligation while the lease is valid', async () => {
        await refusedExpiryStop();
        await handlers.lease(call('lease', {}, {
            renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000,
        }));
        const tick = await handlers.runLeaseMaintenance();
        expect(tick.expired).toBe(false);
        expect(tick.actionRequired).toBe(true);
    });
});

describe('maintenance reports what it could not read', () => {
    it('requires action when the receipt store is unreadable under a valid lease', async () => {
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async () => ({ requested: true, detail: 'ok' }),
        };
        await grantLease();
        const { writeFileSync } = await import('node:fs');
        const { join: joinPath } = await import('node:path');
        const { managedReceiptFileName } = await import('./managedReceiptStore');
        writeFileSync(joinPath(root, 'receipts', managedReceiptFileName(OP_KEY)), '{broken');

        const tick = await handlers.runLeaseMaintenance();
        // A store we cannot read may hold a pending stop; reporting all-clear
        // would drop that obligation silently.
        expect(tick.expired).toBe(false);
        expect(tick.actionRequired).toBe(true);
        expect(tick.storeUnreadable).toBe(true);
    });

    it('asks the backend once per attempt in a tick, not twice', async () => {
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven: true, detail: 'ok' }),
            requestStop: async (input) => { stops.push(input); return { requested: true, detail: 'ok' }; },
        };
        await grantLease({ renewalSeq: 1, leaseMs: 1_000 });
        livePgids.add(4242);
        await handlers.spawn(call('spawn', envelope()));
        monotonic += 5_000;

        await handlers.runLeaseMaintenance();
        const first = stops.length;
        await handlers.runLeaseMaintenance();
        // The pending pass and the expiry pass must not both hand over the
        // same attempt within one tick.
        expect(first).toBe(1);
        expect(stops.length - first).toBe(1);
    });
});

describe('epoch promotion rests on the backend proof, not on local pid guesses', () => {
    /**
     * A stale receipt keeps a numeric pgid. The kernel may have handed that
     * number to something unrelated, so what the local probe sees about it says
     * nothing about the generation being fenced.
     */
    async function staleReceiptFrom(observation: 'alive' | 'eperm', proven: boolean) {
        const stops: Array<Record<string, unknown>> = [];
        runtime.fencingBackend = {
            proveGenerationStopped: async () => ({ proven, detail: proven ? 'provider stopped' : 'unproven' }),
            requestStop: async (input) => { stops.push(input); return { requested: true, detail: 'ok' }; },
        };
        await grantLease({ renewalSeq: 1, epoch: 0 });
        runtime.store.claim({
            requestKey: OP_KEY, runId: RUN, attemptId: ATTEMPT, epoch: 0, now: wallClock,
        });
        runtime.store.update(OP_KEY, { state: 'running', pid: 4242, pgid: 4242 }, wallClock);

        if (observation === 'alive') livePgids.add(4242);
        else {
            runtime.processGroupDeps!.kill = () => {
                throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
            };
        }
        killed.length = 0;
        return { stops };
    }

    function promote(overrides: Record<string, unknown> = {}) {
        return handlers.lease(call('lease', {}, {
            epoch: 1, renewalSeq: 2, leaseMs: 60_000, absoluteExpiry: NOW + 900_000,
            iat: wallClock, exp: wallClock + 60_000, ...overrides,
        }));
    }

    it('promotes when the backend proved the generation stopped, though a reused pgid still looks alive', async () => {
        await staleReceiptFrom('alive', true);
        const result = await promote();
        expect(result).toMatchObject({ ok: true, epoch: 1, fenced: true });
        // Unconditional: a lease that came back `unknown` would otherwise slip
        // through as a pass.
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok', record: { epoch: 1 } });
    });

    it('promotes when the local probe cannot even see the group (EPERM)', async () => {
        await staleReceiptFrom('eperm', true);
        const result = await promote();
        expect(result).toMatchObject({ ok: true, epoch: 1 });
    });

    it('still refuses when the backend cannot prove it', async () => {
        await staleReceiptFrom('alive', false);
        await expect(promote()).rejects.toThrowError(/fence-proof-unavailable/);
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok', record: { epoch: 0 } });
    });

    it('still refuses while a spawn is reaching the launcher', async () => {
        await staleReceiptFrom('alive', true);
        let release: (v: ManagedSpawnOutcome) => void = () => {};
        // Resolves once the launcher has actually been entered, so the
        // promotion below races a real in-flight spawn rather than a guess
        // about how many microtasks that takes.
        let launcherEntered!: () => void;
        const inLauncher = new Promise<void>((resolve) => { launcherEntered = resolve; });
        spawnResult = () => new Promise((resolve) => {
            release = resolve;
            launcherEntered();
        });
        const other = handlers.spawn({
            token: mint('spawn', envelope(), { runId: 'run-2', attemptId: 'a-2' }),
            params: envelope(),
        });
        await inLauncher;

        try {
            await expect(promote()).rejects.toThrowError(/fence-incomplete/);
        } finally {
            release({ type: 'success', sessionId: 's', pid: 5555 });
            await Promise.allSettled([other]);
        }
    });

    it('still refuses a token that aged out during the proof', async () => {
        await staleReceiptFrom('alive', true);
        runtime.fencingBackend!.proveGenerationStopped = async () => {
            wallClock += 300_000;
            return { proven: true, detail: 'ok' };
        };
        await expect(promote()).rejects.toThrowError(/token-expired/);
    });

    it('still refuses a renewal sequence that did not advance', async () => {
        await staleReceiptFrom('alive', true);
        await expect(promote({ renewalSeq: 1 })).rejects.toThrowError(/stale-renewal/);
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok', record: { epoch: 0 } });
    });

    it('still refuses when the receipt store cannot be read in full', async () => {
        await staleReceiptFrom('alive', true);
        const { writeFileSync } = await import('node:fs');
        const { join: joinPath } = await import('node:path');
        const { managedReceiptFileName } = await import('./managedReceiptStore');
        writeFileSync(joinPath(root, 'receipts', managedReceiptFileName(OP_KEY)), '{broken');
        await expect(promote()).rejects.toThrowError(/fence-incomplete/);
    });

    it('reports the local observation as diagnostics without acting on it', async () => {
        const ctx = await staleReceiptFrom('alive', true);
        const result = await promote();
        expect(runtime.store.readLease()).toMatchObject({ kind: 'ok', record: { epoch: 1 } });
        // Useful for an operator; never a veto, and never a reason to signal a
        // pid this process does not own.
        expect(result.localEvidence.length).toBeGreaterThan(0);
        expect(killed.filter(([, signal]) => signal !== 0)).toEqual([]);
        expect(ctx.stops.length).toBeGreaterThan(0);
    });
});

/**
 * Reading a runtime's status, and granting it a lease before it has a run.
 *
 * The parent asks both before it will dispatch anything, and both happen
 * before an attempt exists — so neither can name one. Reading changes nothing;
 * granting goes through the same fencing path the run-scoped lease uses.
 */
describe('managed status and runtime lease', () => {
    /** Provisioning-scoped tokens carry no run or attempt at all. */
    function provisioningToken(over: Record<string, unknown>): string {
        const body = {
            v: 1, kid: 'kid-1', aud: 'runtime-1',
            workspaceId: 'ws-1', projectId: 'proj-1',
            requestKey: 'client-request-key',
            payloadDigest: canonicalManagedPayloadDigest({}),
            iat: NOW, exp: NOW + 60_000,
            ...over,
        };
        const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
        return `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`;
    }

    function statusToken(over: Record<string, unknown> = {}) {
        return provisioningToken({
            op: 'status', provisioningOperationId: 'op-1', epoch: 0, ...over,
        });
    }

    const readyFacts = () => ({
        filesystem: { ok: false as const, reason: 'root-not-mounted' as const },
        restore: { status: 'pending' as const, checkpointId: null, manifestDigest: null },
        isolation: { verified: true, backend: 'privileged-launch-supervisor' },
    });
    it('awaits deferred facts before answering and does not mutate the lease', async () => {
        let finish!: (facts: ReturnType<typeof readyFacts>) => void;
        runtime.runtimeFacts = () => new Promise((resolve) => { finish = resolve; });
        const before = runtime.store.readLease(); let settled = false;
        const pending = handlers.status({ token: statusToken(), params: {} }).then((result) => { settled = true; return result; });
        await Promise.resolve(); expect(settled).toBe(false);
        finish(readyFacts());
        expect(await pending).toMatchObject({ isolation: { verified: true } });
        expect(runtime.store.readLease()).toEqual(before);
    });
    it('reverifies expiration after awaiting facts without changing the lease', async () => {
        let finish!: (facts: ReturnType<typeof readyFacts>) => void;
        runtime.runtimeFacts = () => new Promise((resolve) => { finish = resolve; });
        const before = runtime.store.readLease();
        const pending = handlers.status({ token: statusToken(), params: {} });
        const refused = expect(pending).rejects.toThrow(/token-expired/);
        wallClock = NOW + 120_000; finish(readyFacts());
        await refused; expect(runtime.store.readLease()).toEqual(before);
    });
    it('preserves the status epoch exemption and reads the lease committed during the facts await', async () => {
        let finish!: (facts: ReturnType<typeof readyFacts>) => void;
        runtime.runtimeFacts = () => new Promise((resolve) => { finish = resolve; });
        const pending = handlers.status({ token: statusToken({ epoch: 0 }), params: {} });
        const proof = vi.fn(async () => ({ proven: true, detail: 'fixture-empty' }));
        runtime.fencingBackend = { proveGenerationStopped: proof, requestStop: async () => ({ requested: false, detail: 'unused' }) };
        await handlers['runtime-lease']({ token: provisioningToken({
            op: 'runtime-lease', provisioningOperationId: 'op-1', epoch: 1,
            renewalSeq: 7, leaseMs: 60_000, absoluteExpiry: NOW + 120_000,
        }), params: {} });
        expect(proof).toHaveBeenCalledWith({ belowEpoch: 1 });
        const committed = runtime.store.readLease();
        expect(committed).toMatchObject({ kind: 'ok', record: { epoch: 1, renewalSeq: 7 } });
        finish(readyFacts());
        expect(await pending).toMatchObject({ epoch: 1, renewalSeq: 7, isolation: { verified: true } });
        expect(runtime.store.readLease()).toEqual(committed);
    });
    it('keeps absent and synchronous facts supported and never observes for invalid authorization', async () => {
        expect(await handlers.status({ token: statusToken(), params: {} })).toMatchObject({ isolation: { verified: false } });
        const facts = vi.fn(readyFacts); runtime.runtimeFacts = facts;
        await expect(handlers.status({ token: 'invalid', params: {} })).rejects.toThrow();
        expect(facts).not.toHaveBeenCalled();
        expect(await handlers.status({ token: statusToken(), params: {} })).toMatchObject({ isolation: { verified: true } });
        expect(facts).toHaveBeenCalledOnce();
    });

    it('answers with the runtime facts, without touching the lease', async () => {
        const before = runtime.store.readLease();
        const response = await handlers.status({ token: statusToken(), params: {} });

        expect(response).toMatchObject({
            version: 1,
            identity: expect.objectContaining({
                runtimeId: 'runtime-1',
                happyMachineId: 'machine-1',
                provisioningOperationId: 'op-1',
            }),
        });
        // Asking is not a renewal: the stored lease is untouched.
        expect(runtime.store.readLease()).toEqual(before);
    });

    it('answers for a runtime that has never held an epoch', async () => {
        const response = await handlers.status({ token: statusToken(), params: {} });
        expect(response.epoch).toBe(0);
        expect(response.leaseRemainingMs).toBe(0);
    });

    it('refuses a status token minted for another provisioning operation', async () => {
        // Refused, and named: the operation is what ties a status token to
        // this runtime's generation now that it carries no epoch gate.
        await expect(handlers.status({
            token: statusToken({ provisioningOperationId: 'op-other' }),
            params: {},
        })).rejects.toThrow(/wrong-operation/);
    });

    it.each([
        ['another project', { projectId: 'proj-other' }, /wrong-project/],
        ['a key this runtime does not know', { kid: 'kid-other' }, /unknown-key/],
    ])('refuses a status token minted for %s', async (_name, over, expected) => {
        // The verifier binds audience and workspace, not project or key id.
        // Those are this runtime's trusted identity, and the run-scoped path
        // has always checked them — the provisioning-scoped path did not, so
        // the same signer could have a token for a sibling project accepted
        // here.
        await expect(handlers.status({ token: statusToken(over), params: {} }))
            .rejects.toThrow(expected);
    });

    it.each([
        ['another project', { projectId: 'proj-other' }, /wrong-project/],
        ['a key this runtime does not know', { kid: 'kid-other' }, /unknown-key/],
    ])('refuses a runtime-lease token minted for %s, changing nothing', async (
        _name, over, expected,
    ) => {
        // A lease is a write. Refused before anything is written, so the
        // stored lease is exactly what it was.
        const before = runtime.store.readLease();
        await expect(handlers['runtime-lease']({
            token: provisioningToken({
                op: 'runtime-lease',
                provisioningOperationId: 'op-1',
                epoch: 1,
                renewalSeq: 1,
                leaseMs: 60_000,
                absoluteExpiry: NOW + 3_600_000,
                ...over,
            }),
            params: {},
        })).rejects.toThrow(expected);
        expect(runtime.store.readLease()).toEqual(before);
    });

    it('shouldForwardTheVerbatimGrantEnvelopeOnTheRuntimeLeasePath', async () => {
        /*
         * The supervisor is another process holding the marker and the verifier
         * key. Everything below this handler is derived numbers, so without the
         * original `{token, params}` there is nothing for it to authenticate -
         * it would be asked to trust the daemon's word, which is the whole
         * thing this relay removes.
         */
        const renewals: Array<Record<string, unknown>> = [];
        runtime.onLeaseRenewed = async (input) => {
            renewals.push(input as Record<string, unknown>);
            return { enforced: true };
        };
        // Signed over the params it is sent with, as the parent does.
        const params = { requestedMs: 60_000 };
        const token = provisioningToken({
            op: 'runtime-lease', provisioningOperationId: 'op-1', epoch: 0,
            renewalSeq: 11, leaseMs: 60_000, absoluteExpiry: NOW + 120_000,
            payloadDigest: canonicalManagedPayloadDigest(params),
        });
        await handlers['runtime-lease']({ token, params });
        expect(renewals).toHaveLength(1);
        // Unaltered, both halves: a re-mint or a re-serialisation here would
        // make the daemon the issuer of the authority being checked.
        expect(renewals[0]?.grant).toEqual({ token, params: { requestedMs: 60_000 } });
    });

    it('shouldNotForwardAGrantEnvelopeOnTheRunScopedLeasePath', async () => {
        /*
         * `managed:lease` is a different op with a different claim shape, and
         * it is unchanged by this increment. Attaching an envelope here would
         * relay a run-scoped token as a runtime grant, which the supervisor
         * would then refuse as `wrong-op` - turning a working path into a
         * failing one.
         */
        const renewals: Array<Record<string, unknown>> = [];
        runtime.onLeaseRenewed = async (input) => {
            renewals.push(input as Record<string, unknown>);
            return { enforced: true };
        };
        await grantLease();
        expect(renewals).toHaveLength(1);
        expect(renewals[0]?.grant).toBeUndefined();
        // And it still does everything it did before: enforced, persisted, ACKed.
        expect(renewals[0]).toMatchObject({ epoch: 0, runId: RUN, attemptId: ATTEMPT });
    });

    it('returns the absolute expiry it actually applied', async () => {
        /*
         * The parent bounds the deadline it publishes by this value. Without
         * it the parent knows only what it asked for, and a deadline taken
         * from the request rather than from the grant is a lease that outlives
         * what this runtime agreed to.
         *
         * The cross-repo half of this check — that the parent's reader accepts
         * exactly this reply — lives outside this repository. A test here that
         * imported the parent's parser would break every standalone clone.
         */
        await grantLease();
        const reply = await handlers['runtime-lease']({
            token: provisioningToken({
                op: 'runtime-lease',
                provisioningOperationId: 'op-1',
                // Same epoch the stored lease already holds: no promotion, so
                // the ordinary grant path runs without a fencing backend.
                epoch: 0,
                renewalSeq: 9,
                leaseMs: 60_000,
                absoluteExpiry: NOW + 120_000,
            }),
            params: {},
        });

        expect(reply).toMatchObject({
            ok: true,
            epoch: 0,
            renewalSeq: 9,
            fenced: false,
            absoluteExpiry: NOW + 120_000,
        });
        // Every field the wire contract names is present — a missing one is
        // read as a malformed reply by whoever consumes it.
        for (const field of [
            'ok', 'epoch', 'renewalSeq', 'grantedMs', 'fenced', 'localEvidence', 'absoluteExpiry',
        ]) {
            expect(reply).toHaveProperty(field);
        }
    });

    it('grants a lease to a runtime with no run, and fences when it promotes', async () => {
        await expect(handlers['runtime-lease']({
            token: provisioningToken({
                op: 'runtime-lease',
                provisioningOperationId: 'op-1',
                epoch: 1,
                renewalSeq: 1,
                leaseMs: 60_000,
                absoluteExpiry: NOW + 3_600_000,
            }),
            params: {},
        // No fencing backend is wired, so a promotion cannot be proven and the
        // grant is refused rather than taken on trust — the same refusal the
        // run-scoped lease gives, because it is the same code.
        })).rejects.toThrow(/fence-proof-unavailable/);
    });
});

/*
 * Taking a checkpoint target the parent issued.
 *
 * The runtime cannot issue one: the destinations are presigned by the parent's
 * storage credentials and the authorisation is signed with a key no process
 * here holds. So the target arrives, and what this handler owes is the same two
 * things every write path owes — that the token authorises *this* runtime for
 * *this* checkpoint, and that the runtime still holds the right to write at all.
 */
describe('accepting a checkpoint target', () => {
    const TARGET_PARAMS = {
        checkpointId: 'ckpt-7',
        areas: [{ area: 'project', putUrl: 'https://storage.test/PUT/o', headUrl: 'https://storage.test/HEAD/o' }],
        manifest: { putUrl: 'https://storage.test/PUT/m', headUrl: 'https://storage.test/HEAD/m' },
        pointer: { putUrl: 'https://storage.test/PUT/p', getUrl: 'https://storage.test/GET/p' },
        key: Buffer.alloc(32, 5).toString('base64'),
        expiresAt: NOW + 600_000,
    };

    function checkpointCall(payload: unknown = TARGET_PARAMS, overrides: Record<string, unknown> = {}) {
        const body = {
            v: 1,
            kid: 'kid-1',
            aud: 'runtime-1',
            op: 'checkpoint',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            provisioningOperationId: 'op-1',
            checkpointId: (payload as { checkpointId?: string }).checkpointId ?? 'ckpt-7',
            requestKey: 'client-request-key',
            epoch: 0,
            payloadDigest: canonicalManagedPayloadDigest(payload),
            paramsDigest: canonicalManagedPayloadDigest(payload),
            iat: NOW,
            exp: NOW + 60_000,
            ...overrides,
        };
        const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
        return {
            token: `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), keys.privateKey).toString('base64url')}`,
            params: payload,
        };
    }

    it('shouldForwardTheOriginalTokenBesideTheParamsItSigned', async () => {
        /*
         * The daemon verifying and discarding leaves the supervisor with an
         * unauthenticated document: it holds the marker and the verifier key
         * and would have nothing to check them against. The token travels
         * **unaltered** - re-minting it here would make the daemon the issuer
         * of its own authority.
         */
        const seen: Array<{ target: unknown; token: unknown }> = [];
        runtime.acceptCheckpointTarget = async (target, dispatchToken) => {
            seen.push({ target, token: dispatchToken });
            return { accepted: true, state: 'queued', detail: 'queued' };
        };
        await grantLease();
        const call = checkpointCall();
        await expect(handlers.checkpoint(call))
            .resolves.toEqual({ accepted: true, checkpointId: 'ckpt-7', state: 'queued' });
        expect(seen[0]?.token).toBe((call as { token: string }).token);
        expect(seen[0]?.target).toEqual(TARGET_PARAMS);
    });

    it('hands the parent-issued target to the runtime and reports the checkpoint', async () => {
        const taken: unknown[] = [];
        runtime.acceptCheckpointTarget = async (target) => {
            taken.push(target);
            return { accepted: true, state: 'queued', detail: 'queued' };
        };
        await grantLease();
        await expect(handlers.checkpoint(checkpointCall()))
            .resolves.toEqual({ accepted: true, checkpointId: 'ckpt-7', state: 'queued' });
        expect(taken).toEqual([TARGET_PARAMS]);
    });

    it.each([
        'in-flight', 'completed', 'deferred', 'unknown', 'needs-verification',
    ] as const)('carries the acceptance state %s to the parent', async (state) => {
        /*
         * 전부 **수락**이다 — 문서는 도착했고 부모는 이 hop 을 재시도하면
         * 안 된다. 다른 것은 이 전달로 아카이브가 따라오는지이고, 그 판정은
         * 부모가 `state` 로 한다. 거절 코드로 만들면 "도착 못 함" 과 "도착했고
         * 아카이브는 안 생김" 이 한 자리에 섞인다.
         */
        runtime.acceptCheckpointTarget = async () => ({ accepted: true, state, detail: state });
        await grantLease();
        await expect(handlers.checkpoint(checkpointCall()))
            .resolves.toEqual({ accepted: true, checkpointId: 'ckpt-7', state });
    });

    it('refuses an acceptance that does not say what happened to it', async () => {
        // 상태 없는 수락은 그 사실을 지운 것이다.
        runtime.acceptCheckpointTarget = async () => ({ accepted: true, detail: 'accepted' });
        await grantLease();
        await expect(handlers.checkpoint(checkpointCall()))
            .rejects.toThrowError(/malformed-request/);
    });

    it('does not report an acceptance the runtime refused', async () => {
        /*
         * The runtime that takes it is in another process, and it can say no —
         * it may have no checkpoint session configured at all. Reporting
         * `accepted: true` anyway tells the parent a credential it issued is
         * in place, and that credential then expires where nobody is looking.
         */
        runtime.acceptCheckpointTarget = async () => ({
            accepted: false, detail: 'checkpoint-unconfigured',
        });
        await grantLease();
        await expect(handlers.checkpoint(checkpointCall()))
            .rejects.toThrowError(/checkpoint-target-refused/);
    });

    it('refuses one whose lease has lapsed', async () => {
        /*
         * A checkpoint is a write, and it publishes a pointer other runtimes
         * read. Taken without the right to write, it archives a volume this
         * runtime may no longer own and then tells everybody that archive is
         * the latest.
         */
        runtime.acceptCheckpointTarget = async () => ({ accepted: true, state: 'queued', detail: 'queued' });
        await expect(handlers.checkpoint(checkpointCall()))
            .rejects.toThrowError(/lease-expired/);
    });

    it('refuses a target whose destinations were not the ones signed', async () => {
        // The digest is the grant: without it the same signature authorises
        // uploading this volume anywhere the caller likes.
        await grantLease();
        runtime.acceptCheckpointTarget = async () => ({ accepted: true, state: 'queued', detail: 'queued' });
        const call = checkpointCall()
        const moved = {
            ...TARGET_PARAMS,
            areas: [{ ...TARGET_PARAMS.areas[0], putUrl: 'https://attacker.test/PUT/o' }],
        };
        await expect(handlers.checkpoint({ token: call.token, params: moved }))
            .rejects.toThrowError(/token-/);
    });

    it('refuses a token whose checkpoint is not the one in the parameters', async () => {
        // Otherwise a target for one checkpoint is accepted under another's
        // authorisation, and the namespace the parent named is not the one
        // written.
        await grantLease();
        runtime.acceptCheckpointTarget = async () => ({ accepted: true, state: 'queued', detail: 'queued' });
        await expect(handlers.checkpoint(checkpointCall(TARGET_PARAMS, { checkpointId: 'ckpt-8' })))
            .rejects.toThrowError(/token-/);
    });

    it('says so when nothing is wired to take one', async () => {
        // A parent that believes it issued a target and did not is a parent
        // whose checkpoints silently never happen.
        await grantLease();
        runtime.acceptCheckpointTarget = undefined;
        await expect(handlers.checkpoint(checkpointCall()))
            .rejects.toThrowError(/capability-unavailable/);
    });

    it('refuses once entries are closed, and is waited for by teardown', async () => {
        let release!: () => void;
        const inFlight = new Promise<void>((resolve) => { release = resolve; });
        runtime.acceptCheckpointTarget = async () => {
            await inFlight;
            return { accepted: true, state: 'queued', detail: 'queued' };
        };
        await grantLease();
        const pending = handlers.checkpoint(checkpointCall());
        let drained = false;
        void handlers.drainLeaseWork().then(() => { drained = true; });
        await new Promise((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        release();
        await pending;
        await handlers.drainLeaseWork();

        handlers.closeEntries();
        await expect(handlers.checkpoint(checkpointCall()))
            .rejects.toThrowError(/shutting-down/);
    });
});


describe('actual daemon readiness wiring without importing daemon startup', () => {
    it('captures one marker/client binding, observes before admission and freshly on every facts call', async () => {
        const source = ts.createSourceFile('run.ts', readFileSync(join(__dirname, 'run.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
        const declarations = new Map<string, ts.VariableDeclaration>();
        let factsAdapter: ts.PropertyAssignment | undefined;
        function visit(node: ts.Node) {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
            if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'runtimeFacts') factsAdapter = node;
            ts.forEachChild(node, visit);
        }
        visit(source);
        const marker = declarations.get('managedMarkerPath');
        expect(marker).toBeDefined();
        const admitted = declarations.get('managedIdentity')!;
        const launcher = declarations.get('launcher')!;
        const statement = launcher.parent.parent;
        if (!ts.isBlock(statement.parent)) throw new Error('launcher must be in the active admission block');
        const statements = [...statement.parent.statements];
        const start = statements.indexOf(statement as ts.Statement);
        const end = statements.findIndex((node, index) => index >= start && node.getText(source).includes(' admitted`'));
        expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
        const body = [marker!.parent.parent.getText(source), admitted.parent.parent.getText(source),
            'let managedFencingBackend = null; let managedRuntimeFacts;',
            ...statements.slice(start, end + 1).map((node) => node.getText(source)),
            `return { facts: (${factsAdapter!.initializer.getText(source)}), backend: managedFencingBackend };`].join('\n');
        const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        const events: string[] = [];
        const sha = 'a'.repeat(64); const nonce = 'n'.repeat(32);
        const binding = { token: 't'.repeat(43), socketPath: '/state/launcher.sock' };
        const hello = { instanceNonce: nonce, runtimeId: identity.runtimeId,
            provisioningOperationId: identity.provisioningOperationId, markerSha256: sha };
        const request = vi.fn(async () => { events.push('hello'); return JSON.stringify({ ok: true, result: hello }); });
        const startupBinding = vi.fn(() => ({ ok: true, binding }));
        const readMarker = vi.fn(() => ({ kind: 'ok' as const, content: '', sha256: sha }));
        const readBinding = vi.fn(() => ({ ok: true as const, binding: { token: 't'.repeat(43), socketPath: '/state/launcher.sock' } }));
        const helper = vi.fn((...args: Parameters<typeof createManagedSupervisorReadiness>) => {
            expect(args).toHaveLength(1);
            return createManagedSupervisorReadiness(args[0], {
                provisioning: { getuid: () => 0, lstatDir: () => ({ uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false }),
                    probeIsolationBackend: () => { throw new Error('must not probe'); } },
                readProtectedFile: readMarker, readBinding,
                readAttestation: () => ({ ok: true, attestation: { version: 1, ...hello, socketPath: '/state/launcher.sock' } }),
            });
        });
        const markerPath = vi.fn(() => '/etc/saycode/managed-runtime.json');
        const resolveIdentity = vi.fn(() => ({ status: 'active', identity: { ...identity }, markerSha256: sha }));
        const socketRequest = vi.fn(() => ({ request }));
        const dependencies = {
            managedProvisioningPath: markerPath, resolveManagedRuntimeIdentity: resolveIdentity,
            readManagedLauncherBinding: startupBinding, defaultProvisioningDeps: {},
            createLauncherClient, createUnixSocketRequest: socketRequest, createManagedSupervisorReadiness: helper,
            logger: { debug: (message: string) => { if (message.endsWith(' admitted')) events.push('admitted'); } },
            resolveManagedVolumeBinding: async () => ({ ok: true, binding: { providerVolumeId: 'volume', fsUuid: 'uuid' } }),
            observeManagedVolume: () => { throw new Error('not used by fixture volume reader'); },
            MANAGED_PROJECT_ROOT: '/workspace/project', readMountinfoText: () => '', readFsUuidForDevice: () => null,
            verifyOpenPathDevice: () => false,
            resolveManagedFilesystemFacts: () => { events.push('filesystem'); return { ok: false, reason: 'root-not-mounted' }; },
            readManagedRestoreState: () => { events.push('restore'); return { status: 'pending', checkpointId: null, manifestDigest: null }; },
        };
        // Execute the actual selected AST statements, not a copied readiness predicate.
        const execute = new Function(...Object.keys(dependencies), `return (async () => { ${js} })();`);
        const wired = await execute(...Object.values(dependencies));
        expect(markerPath).toHaveBeenCalledOnce();
        expect(resolveIdentity).toHaveBeenCalledExactlyOnceWith('/etc/saycode/managed-runtime.json');
        expect(startupBinding).toHaveBeenCalledOnce(); expect(socketRequest).toHaveBeenCalledExactlyOnceWith('/state/launcher.sock');
        expect(helper).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
        expect(events.indexOf('hello')).toBeLessThan(events.indexOf('admitted'));
        expect(events).not.toContain('filesystem');
        runtime.runtimeFacts = wired.facts;
        const statusRequest = call('status', {}, { runId: undefined, attemptId: undefined, provisioningOperationId: 'op-1' });
        binding.token = 'caller-mutated'; binding.socketPath = '/changed';
        events.length = 0;
        expect(await handlers.status(statusRequest)).toMatchObject({ isolation: { verified: true } });
        expect(events).toEqual(['hello', 'filesystem', 'restore']);
        expect(await handlers.status(statusRequest)).toMatchObject({ isolation: { verified: true } });
        expect(request).toHaveBeenCalledTimes(3); expect(readMarker).toHaveBeenCalledTimes(3);
        expect(readBinding).toHaveBeenCalledTimes(3); expect(startupBinding).toHaveBeenCalledOnce();
        request.mockResolvedValueOnce(JSON.stringify({ ok: false, reason: 'hello-unavailable' }));
        dependencies.logger.debug = () => { throw new Error('logger failed'); };
        expect(await handlers.status(statusRequest)).toMatchObject({ isolation: { verified: false } });
    });
});

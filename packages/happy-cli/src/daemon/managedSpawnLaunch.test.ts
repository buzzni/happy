/**
 * `managed:spawn` → supervisor, two phases with registration between them.
 *
 * The order is the contract: nothing may exec before the daemon knows the pid.
 * The other half is what a failure is allowed to claim — `started: false`
 * closes a run, so it is only ever said where nothing can have run.
 */
import { describe, it, expect } from 'vitest';

import {
    decideManagedStopRoute,
    launchManagedSpawn,
    stopManagedGeneration,
    type ManagedLaunchBackend,
} from './managedSpawnLaunch';
import type { ManagedSpawnContext } from './managedRpcHandlers';
import { parseManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';
import { MANAGED_PROJECT_ROOT } from './managedRuntimeIdentity';
import { parseManagedReportCredential } from './launch/managedReportCredential';

const SESSION_ID = 'sess-managed-1';
const REPORT_BASE_URL = 'http://127.0.0.1:8799';

function envelope() {
    return parseManagedSpawnEnvelope({
        directory: MANAGED_PROJECT_ROOT,
        agent: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'a'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: 'https://happy.example.test',
            sessionId: SESSION_ID,
            encryptionVariant: 'dataKey',
            rawKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            wrappedKeyBase64: Buffer.alloc(105, 9).toString('base64'),
            scopedToken: 'scoped.bearer.value',
            tokenExpiresAt: Date.now() + 3_600_000,
        },
        gateway: {
            baseUrl: 'https://studio.example.test/api/cloud/gateway/anthropic/v1/messages',
            capability: 'cap-1',
            provider: 'anthropic',
            endpoint: 'anthropic-messages',
            model: 'claude-opus-5',
        },
    }, Date.now());
}

function context(): ManagedSpawnContext {
    const parsed = envelope();
    return {
        operationKey: 'op-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        epoch: 3,
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        leaseExpiresMonotonic: 90_000,
        bootstrapEnvelope: Buffer.from(JSON.stringify(parsed), 'utf8'),
        envelope: parsed,
    };
}

/** Records the order of everything the daemon and the launcher do. */
function recorder(over: Partial<ManagedLaunchBackend> = {}) {
    const events: string[] = [];
    const registered: Array<{
        launchId: string; secret: Buffer;
        encryption: { encryptionKey: string; encryptionVariant: string };
    }> = [];
    const backend: ManagedLaunchBackend = {
        requestStop: async () => {
            events.push('request-stop');
            return { requested: true, detail: 'observed-empty' };
        },
        prepareLaunch: async () => {
            events.push('prepare');
            return { prepared: true, pid: 4242, handle: 'h'.repeat(32) };
        },
        releaseLaunch: async () => {
            events.push('release');
            return { released: true, detail: 'exec-attempted' };
        },
        ...over,
    };
    return {
        events,
        backend,
        registered,
        register: (entry: {
            pid: number; sessionId: string; launchId: string; secret: Buffer;
            encryption: { encryptionKey: string; encryptionVariant: string };
        }) => {
            registered.push({
                launchId: entry.launchId, secret: entry.secret, encryption: entry.encryption,
            });
            events.push(`register:${entry.pid}:${entry.sessionId}`);
        },
        unregister: (entry: { pid: number }) => { events.push(`unregister:${entry.pid}`); },
        waitForChildReady: async (pid: number) => {
            events.push(`await-ready:${pid}`);
            return { ready: true as const, sessionId: SESSION_ID };
        },
    };
}

describe('managed spawn goes through the supervisor', () => {
    it('registers the parked pid before the child is released', async () => {
        const r = recorder();
        const outcome = await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        expect(outcome).toEqual({ type: 'success', sessionId: SESSION_ID, pid: 4242 });
        // A release before the registration is a child nobody can stop.
        // The wait is armed before the gate opens: a report can arrive the
        // instant the child execs.
        expect(r.events).toEqual([
            'prepare', `register:4242:${SESSION_ID}`, 'await-ready:4242', 'release',
        ]);
    });

    it('sends the key and the lease from the verified context, and the envelope as bytes', async () => {
        let seen: Parameters<ManagedLaunchBackend['prepareLaunch']>[0] | null = null;
        const r = recorder({
            prepareLaunch: async (request) => {
                seen = request;
                return { prepared: true, pid: 7, handle: 'h'.repeat(32) };
            },
        });
        const ctx = context();
        await launchManagedSpawn({
            backend: r.backend, context: ctx, register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        expect(seen!.key).toEqual({ runId: 'run-1', attemptId: 'attempt-1', epoch: 3 });
        expect(seen!.leaseExpiresMonotonic).toBe(90_000);
        expect(seen!.bootstrap).toBe(ctx.bootstrapEnvelope);
    });

    it('never spawns an ordinary child when no supervisor is wired', async () => {
        const r = recorder();
        const outcome = await launchManagedSpawn({
            backend: null, context: context(), register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        // An unmanaged fallback would be a run that looks managed and is not.
        expect(outcome).toEqual({
            type: 'error', errorMessage: 'launcher-unavailable', started: false,
        });
        expect(r.events).toEqual([]);
    });

    it('a refused park is the one failure that closes the run', async () => {
        const r = recorder({
            prepareLaunch: async () => ({ prepared: false, detail: 'managed-run-unconfigured' }),
        });
        const outcome = await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        // Parking happens before execve, so nothing ran.
        expect(outcome).toEqual({
            type: 'error',
            errorMessage: 'launch-refused:managed-run-unconfigured',
            started: false,
        });
        expect(r.events).toEqual([]);
    });

    it('a failed release stays reconcilable instead of claiming nothing started', async () => {
        const r = recorder({
            releaseLaunch: async () => {
                r.events.push('release');
                return { released: false, detail: 'launch-failed' };
            },
        });
        const outcome = await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        // The gate may already have opened when the answer came back.
        expect(outcome).toMatchObject({ type: 'error', errorMessage: 'release-failed:launch-failed' });
        expect(outcome).not.toHaveProperty('started');
        expect(r.events).toEqual([
            'prepare', `register:4242:${SESSION_ID}`, 'await-ready:4242', 'release', 'unregister:4242',
        ]);
    });

    it('does not release a parked generation it cannot register', async () => {
        const r = recorder({
            prepareLaunch: async () => ({ prepared: true, pid: null, handle: 'h'.repeat(32) }),
        });
        const outcome = await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        expect(outcome).toMatchObject({ type: 'error', errorMessage: 'prepared-without-pid' });
        // Its fate belongs to the supervisor's release deadline, not to a guess.
        expect(outcome).not.toHaveProperty('started');
        expect(r.events).not.toContain('release');
    });

    it('does not report success for a child that never reported itself', async () => {
        const r = recorder();
        const outcome = await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, reportBaseUrl: REPORT_BASE_URL,
            // `exec-attempted` is not a running agent: the helper can die
            // between its ACK and `execve`.
            waitForChildReady: async () => ({ ready: false, detail: 'webhook-timeout' }),
        });
        expect(outcome).toMatchObject({ type: 'error', errorMessage: 'child-not-ready:webhook-timeout' });
        // It was released, so a child may exist. The run stays reconcilable.
        expect(outcome).not.toHaveProperty('started');
    });

    it('refuses a child that reported a session the parent did not create', async () => {
        const r = recorder();
        const outcome = await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, reportBaseUrl: REPORT_BASE_URL,
            waitForChildReady: async () => ({ ready: true, sessionId: 'some-other-session' }),
        });
        // Two records would claim this run; the receipt would attach to the
        // wrong one.
        expect(outcome).toMatchObject({ type: 'error', errorMessage: 'child-reported-another-session' });
        expect(outcome).not.toHaveProperty('started');
    });

    it('gives the launch a report identity that cannot be computed from the run', async () => {
        const r = recorder();
        await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        const [entry] = r.registered;
        /*
         * The control server refuses a managed report that no launch vouched
         * for, and the run's ids are known to everything that can ask — a
         * report credential derived from them would not be a credential.
         */
        expect(entry!.secret).toHaveLength(32);
        expect(entry!.launchId).toMatch(/^[0-9a-f]{32}$/);
        const text = entry!.secret.toString('utf8');
        for (const known of ['run-1', 'attempt-1', SESSION_ID]) expect(text).not.toContain(known);
    });

    it('hands the child a report credential the launcher can carry on its own descriptor', async () => {
        let seen: Buffer | null = null;
        const r = recorder({
            prepareLaunch: async (request) => {
                seen = request.reportCredential;
                return { prepared: true, pid: 4242, handle: 'h'.repeat(32) };
            },
        });
        await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        /*
         * Minted before the launch, because the descriptors the launcher
         * inherits at `prepare-launch` are the only thing that reaches this
         * child. A secret minted afterwards could only go through the
         * environment, which every tool call inherits.
         */
        const credential = parseManagedReportCredential(seen!);
        expect(credential.launchId).toBe(r.registered[0]!.launchId);
        // The child's only route: it cannot read the daemon's state file.
        expect(credential.reportBaseUrl).toBe(REPORT_BASE_URL);
        expect(credential.secret.equals(r.registered[0]!.secret)).toBe(true);
    });

    it('registers the envelope\'s own encryption identity, not the first report\'s', async () => {
        const r = recorder();
        const ctx = context();
        await launchManagedSpawn({
            backend: r.backend, context: ctx, register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        // Registering without it makes every legitimate signed report look
        // like a session whose envelope was swapped.
        expect(r.registered[0]!.encryption).toEqual({
            encryptionKey: ctx.envelope.bootstrap.rawKeyBase64,
            encryptionVariant: 'dataKey',
        });
    });

    it('stops a managed generation through the supervisor, never by signalling a pid', async () => {
        const r = recorder();
        const stopped = await stopManagedGeneration({
            backend: r.backend, key: { runId: 'run-1', attemptId: 'attempt-1', epoch: 3 },
        });
        // The generation's tools run in its cgroup under another uid; only the
        // supervisor can kill them and observe the cgroup empty.
        expect(stopped).toEqual({ stopped: true, detail: 'observed-empty' });
        expect(r.events).toEqual(['request-stop']);
    });

    it('reports an unproven managed stop rather than claiming one', async () => {
        const r = recorder({
            requestStop: async () => ({ requested: false, detail: 'not-observed-empty' }),
        });
        expect(await stopManagedGeneration({
            backend: r.backend, key: { runId: 'run-1', attemptId: 'attempt-1', epoch: 3 },
        })).toEqual({ stopped: false, detail: 'not-observed-empty' });
    });

    it('refuses to call a managed stop stopped when no supervisor answered', async () => {
        expect(await stopManagedGeneration({
            backend: null, key: { runId: 'run-1', attemptId: 'attempt-1', epoch: 3 },
        })).toEqual({ stopped: false, detail: 'launcher-unavailable' });
    });

    it('refuses a PID-only stop for a managed session whose generation it lost', async () => {
        /*
         * A daemon restart hydrates tracked sessions from disk but not the
         * generation identity. Signalling the pid there stops neither the
         * generation's tools nor its broker and proves nothing.
         */
        expect(decideManagedStopRoute({ managedRuntimeActive: true, key: undefined }))
            .toEqual({ route: 'refuse', detail: 'unknown-generation' });
    });

    it('leaves an ordinary daemon session on the ordinary stop path', async () => {
        expect(decideManagedStopRoute({ managedRuntimeActive: false, key: undefined }))
            .toEqual({ route: 'signal' });
    });

    it('sends a known managed generation to the supervisor', async () => {
        const key = { runId: 'run-1', attemptId: 'attempt-1', epoch: 3 };
        expect(decideManagedStopRoute({ managedRuntimeActive: true, key }))
            .toEqual({ route: 'supervisor', key });
    });

    it('carries no envelope content back to the caller', async () => {
        const r = recorder({
            prepareLaunch: async () => ({ prepared: false, detail: 'bootstrap-invalid' }),
        });
        const outcome = await launchManagedSpawn({
            backend: r.backend, context: context(), register: r.register,
            unregister: r.unregister, waitForChildReady: r.waitForChildReady,
            reportBaseUrl: REPORT_BASE_URL,
        });
        const text = JSON.stringify(outcome);
        for (const secret of ['scoped.bearer.value', Buffer.alloc(32, 7).toString('base64'), 'do the thing']) {
            expect(text).not.toContain(secret);
        }
    });
});

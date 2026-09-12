/**
 * A managed lifecycle report, end to end over the real control HTTP server.
 *
 * Producer → verifier → waiter, with nothing between them stubbed: the child's
 * own signer reads the credential off a real descriptor and mints a real
 * capability, the real `startDaemonControlServer` verifies it against a real
 * registry, and the real awaiter is what resolves.
 *
 * This is the test the registry wiring alone could not stand in for. The
 * registry was wired first and every real report was still refused, because
 * nothing delivered the credential to the child — a gap invisible to any test
 * that mints the capability on the daemon's side of the boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { startDaemonControlServer, type ManagedReportClaim } from '../controlServer';
import { createManagedLaunchRegistry } from './managedLaunchRegistry';
import { createManagedReportVerifier } from './verifyManagedReport';
import {
    createManagedReportSigner,
    encodeManagedReportCredential,
    MANAGED_REPORT_FD_ENV,
    readManagedReportCredentialFromFd,
} from './managedReportCredential';
import { MANAGED_REPORT_CAPABILITY_HEADER } from './managedReportCapability';
import { writeDaemonState } from '@/persistence';

const SESSION_ID = 'sess-managed-report';
const LAUNCH_ID = 'a'.repeat(32);
const HOST_PID = 4242;
const SECRET = randomBytes(32);
const ENCRYPTION = { encryptionKey: Buffer.alloc(32, 7).toString('base64'), encryptionVariant: 'dataKey' as const };

describe('a managed report over the real control server', () => {
    let dir: string;
    let stop: (() => Promise<void>) | null = null;
    let port = 0;
    let controlSecret = '';
    let registry: ReturnType<typeof createManagedLaunchRegistry>;
    let started: Array<{ sessionId: string; hostPid: number }>;

    /** The credential exactly as the launcher stages it: a file, opened read-only. */
    function stageCredentialFd(): number {
        const path = join(dir, `${randomBytes(8).toString('hex')}.cred`);
        writeFileSync(path, encodeManagedReportCredential({
            launchId: LAUNCH_ID, secret: SECRET, reportBaseUrl: `http://127.0.0.1:${port}`,
        }), { mode: 0o600 });
        return openSync(path, 'r');
    }

    let previousHome: string | undefined;
    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'managed-report-'));
        // The control client reads the daemon state out of the happy home dir.
        previousHome = process.env.HAPPY_HOME_DIR;
        process.env.HAPPY_HOME_DIR = join(dir, 'home');
        started = [];
        registry = createManagedLaunchRegistry();
        const verify = createManagedReportVerifier({ registry, now: Date.now });
        const server = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => ({ stopped: false, reason: 'not-found' }),
            spawnSession: async () => ({ type: 'error', errorMessage: 'not used here' }),
            requestShutdown: () => undefined,
            onHappySessionWebhook: (sessionId: string, metadata: { hostPid?: number }) => {
                started.push({ sessionId, hostPid: metadata?.hostPid ?? 0 });
            },
            onHappySessionRuntime: () => undefined,
            managedRuntime: true,
            verifyManagedReport: async (claim: ManagedReportClaim) => verify(claim),
        } as never);
        port = server.port;
        controlSecret = server.controlSecret;
        stop = server.stop;
    });

    afterEach(async () => {
        await stop?.();
        stop = null;
        delete process.env[MANAGED_REPORT_FD_ENV];
        if (previousHome === undefined) delete process.env.HAPPY_HOME_DIR;
        else process.env.HAPPY_HOME_DIR = previousHome;
        rmSync(dir, { recursive: true, force: true });
    });

    async function post(body: unknown, headers: Record<string, string>) {
        return fetch(`http://127.0.0.1:${port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
    }

    it('accepts a report the child signed with the credential it was handed', async () => {
        registry.register({
            launchId: LAUNCH_ID,
            scope: {
                operationKey: 'op-1', runId: 'run-1', attemptId: 'attempt-1', epoch: 0,
                workspaceId: 'ws-1', projectId: 'proj-1',
            },
            sessionId: SESSION_ID,
            hostPids: [HOST_PID],
            encryption: ENCRYPTION,
            expiresAt: Date.now() + 60_000,
            secret: SECRET,
        });

        // The child's own path: the descriptor number in the environment, the
        // secret only behind it.
        const fd = stageCredentialFd();
        const env: NodeJS.ProcessEnv = { [MANAGED_REPORT_FD_ENV]: String(fd) };
        const signer = await createManagedReportSigner(env);
        expect(signer).not.toBeNull();
        // The address rides with the credential, not the daemon's state file.
        expect(signer!.reportBaseUrl).toBe(`http://127.0.0.1:${port}`);
        // Consumed: the variable is gone and the descriptor is closed.
        expect(env[MANAGED_REPORT_FD_ENV]).toBeUndefined();

        const body = {
            sessionId: SESSION_ID,
            metadata: { hostPid: HOST_PID },
            encryption: { ...ENCRYPTION, seq: 1, metadataVersion: 1, agentStateVersion: 1 },
        };
        const response = await post(body, {
            Authorization: `Bearer ${controlSecret}`,
            [MANAGED_REPORT_CAPABILITY_HEADER]: signer!.sign({
                kind: 'session-started', seq: 1, expiresAt: Date.now() + 60_000, body,
            }),
        });

        expect(response.status).toBe(200);
        // The waiter's side: the daemon actually saw this session start.
        expect(started).toEqual([{ sessionId: SESSION_ID, hostPid: HOST_PID }]);
    });

    it('refuses the same report with no capability at all', async () => {
        registry.register({
            launchId: LAUNCH_ID,
            scope: {
                operationKey: 'op-1', runId: 'run-1', attemptId: 'attempt-1', epoch: 0,
                workspaceId: 'ws-1', projectId: 'proj-1',
            },
            sessionId: SESSION_ID,
            hostPids: [HOST_PID],
            encryption: ENCRYPTION,
            expiresAt: Date.now() + 60_000,
            secret: SECRET,
        });
        const body = { sessionId: SESSION_ID, metadata: { hostPid: HOST_PID } };
        /*
         * This is what every real child did before the credential was
         * delivered: the loopback bearer alone, which proves "something on this
         * host" and nothing about which launch is reporting.
         */
        const response = await post(body, { Authorization: `Bearer ${controlSecret}` });
        expect(response.status).not.toBe(200);
        expect(started).toEqual([]);
    });

    it('refuses a report signed for a launch this daemon never registered', async () => {
        const fd = stageCredentialFd();
        const signer = await createManagedReportSigner({ [MANAGED_REPORT_FD_ENV]: String(fd) });
        const body = { sessionId: SESSION_ID, metadata: { hostPid: HOST_PID } };
        const response = await post(body, {
            Authorization: `Bearer ${controlSecret}`,
            [MANAGED_REPORT_CAPABILITY_HEADER]: signer!.sign({
                kind: 'session-started', seq: 1, expiresAt: Date.now() + 60_000, body,
            }),
        });
        expect(response.status).not.toBe(200);
        expect(started).toEqual([]);
    });

    it('is signed by the CLI\'s own report path, not only by a test that mints one', async () => {
        /*
         * The producer here is `notifyDaemonSessionStarted` itself. Signing the
         * capability in the test proves the verifier; it does not prove the
         * child's own path attaches it — which is exactly the gap that left
         * every real report refused while the registry looked wired.
         */
        registry.register({
            launchId: LAUNCH_ID,
            scope: {
                operationKey: 'op-1', runId: 'run-1', attemptId: 'attempt-1', epoch: 0,
                workspaceId: 'ws-1', projectId: 'proj-1',
            },
            sessionId: SESSION_ID,
            hostPids: [process.pid],
            encryption: ENCRYPTION,
            expiresAt: Date.now() + 60_000,
            secret: SECRET,
        });
        // The daemon state the CLI's control client reads to find the server.
        writeDaemonState({
            pid: process.pid,
            httpPort: port,
            startTime: new Date().toLocaleString(),
            startedWithCliVersion: 'test',
            daemonLogPath: join(dir, 'daemon.log'),
            state: 'running',
            controlSecret,
        } as never);
        process.env[MANAGED_REPORT_FD_ENV] = String(stageCredentialFd());

        vi.resetModules();
        const { notifyDaemonSessionStarted } = await import('../controlClient');
        const result = await notifyDaemonSessionStarted(
            SESSION_ID,
            { hostPid: process.pid } as never,
            { ...ENCRYPTION, seq: 1, metadataVersion: 1, agentStateVersion: 1 },
        );

        expect(result?.error).toBeUndefined();
        expect(started).toEqual([{ sessionId: SESSION_ID, hostPid: process.pid }]);
    });

    it('refuses to report at all when a managed child has no readable credential', async () => {
        writeDaemonState({
            pid: process.pid,
            httpPort: port,
            startTime: new Date().toLocaleString(),
            startedWithCliVersion: 'test',
            daemonLogPath: join(dir, 'daemon.log'),
            state: 'running',
            controlSecret,
        } as never);
        // Managed (the variable is set) but the descriptor is not readable.
        process.env[MANAGED_REPORT_FD_ENV] = '9999';

        // A fresh module: the signer and the managed flag are per-process.
        vi.resetModules();
        const { notifyDaemonSessionStarted } = await import('../controlClient');
        const result = await notifyDaemonSessionStarted(
            SESSION_ID,
            { hostPid: process.pid } as never,
        );

        /*
         * No unsigned fallback. The server would refuse it anyway, but sending
         * it would put this session's metadata on the wire for a launch that
         * cannot prove it owns it — and on a real runtime the daemon-wide
         * bearer it would have attached is a secret this child must not hold.
         */
        expect(result?.error).toMatch(/credential unavailable/);
        expect(started).toEqual([]);
    });

    it('reads the credential off the descriptor once and leaves nothing behind', async () => {
        const fd = stageCredentialFd();
        const credential = await readManagedReportCredentialFromFd(fd);
        expect(credential.launchId).toBe(LAUNCH_ID);
        expect(credential.secret.equals(SECRET)).toBe(true);
        // Closed by the read, so a second reader finds nothing.
        await expect(readManagedReportCredentialFromFd(fd)).rejects.toThrow();
        expect(() => closeSync(fd)).toThrow();
    });
});

/**
 * 별도 supervisor **프로세스** 와 daemon client 의 수명주기.
 *
 * 함수 호출로만 확인하면 소켓 인증·핸들 수명·프로세스 경계가 검증되지 않는다.
 * 여기서는 supervisor 를 자식 프로세스로 띄우고 실제 Unix 소켓으로 대화한다.
 * cgroup 이 없는 환경(개발 macOS 포함)에서도 도는 부분만 다룬다 — 실제 exec 과
 * fencing 은 `docker/managed-launch/verify-*.sh` 가 Linux 에서 판정한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import {
    existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createSupervisorRuntime, type SupervisorRuntimeOptions } from './main';
import {
    managedSupervisorAttestationPath,
} from '@/managed/managedSupervisorAttestation';

import { createLauncherClient, createUnixSocketRequest } from '@/daemon/launch/launcherClient';
import {
    MANAGED_PROJECT_ROOT,
    probeIsolationBackendUnavailable,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';
import { MANAGED_REPORT_CHILD_FD } from '@/daemon/launch/managedReportCredential';
import { encodeManagedReportCredential } from '@/daemon/launch/managedReportCredential';

const TOKEN = 'process-fixture-token';
// `@/` alias 를 쓰는 소스를 자식 프로세스에서 그대로 돌리려면 tsconfig 를 명시해야 한다.
const PACKAGE_ROOT = resolve(__dirname, '../..');
const TSX_CLI = createRequire(__filename).resolve('tsx/cli');
const TSCONFIG = join(PACKAGE_ROOT, 'tsconfig.json');
const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };

/** 자식이 보고를 서명할 자격. 봉투와 별개의 문서다. */
function reportCredential(): Buffer {
    return encodeManagedReportCredential({
        launchId: 'a'.repeat(32),
        secret: Buffer.alloc(32, 5),
        reportBaseUrl: 'http://127.0.0.1:8799',
    });
}

/** 파서를 실제로 통과하는 봉투. 거부 사유가 모양 때문이 아님을 확실히 한다. */
function validEnvelope(): Record<string, unknown> {
    return {
        directory: MANAGED_PROJECT_ROOT,
        agent: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'a'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: ENVELOPE_ORIGIN,
            sessionId: 'sess-1',
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
    };
}

/** The Happy this fixture's envelopes name, and the runtime is provisioned for. */
const ENVELOPE_ORIGIN = 'https://happy.example.test';

describe('supervisor process ↔ daemon client', () => {
    let dir: string;
    let child: ChildProcess | null = null;
    let socketPath: string;
    let entryDir: string;

    async function startSupervisor(over: { bootstrapFd?: number; managedRun?: boolean } = {}): Promise<void> {
        const entry = join(entryDir, 'run-supervisor.ts');
        writeFileSync(entry, `
/*
 * The supervisor reports its own open descriptor count on request.
 *
 * The staging directory cannot answer this: \`stageBootstrap\` unlinks the file
 * the instant it has a read descriptor, precisely so a live child cannot
 * reopen it by path. The leak is a *descriptor* leak and nothing on disk
 * records it.
 *
 * Read from the process's own fd table rather than by patching \`fs\`: the
 * supervisor imports \`openSync\` as an ESM binding, so a patched CJS object is
 * never consulted — an instrument that sees nothing reports zero for both
 * orderings and proves nothing.
 */
import { readdirSync as readdirSyncForFds } from 'node:fs';
process.on('message', (m) => {
  if (m === 'fd-report') {
    let fds = -1;
    try { fds = readdirSyncForFds('/dev/fd').length; } catch { fds = -1; }
    process.send?.({ fds });
  }
});

import { createSupervisorRuntime } from ${JSON.stringify(join(__dirname, 'main'))};
import { defaultManagedRunConfig } from ${JSON.stringify(join(__dirname, 'managedRunConfig'))};
/*
 * A real composition, not a stub.
 *
 * Without \`managedRun\` this supervisor refuses at the capability check,
 * which is *before* anything is staged — so the descriptor guard is never
 * reached and a test against this fixture could not tell the two orderings
 * apart. The production path has to be provisioned to be exercised.
 */
const composition = defaultManagedRunConfig({
  identity: {
    isolation: {
      backend: 'privileged-launch-supervisor',
      provider: { uid: 10601, gid: 10601 },
      executor: { uid: 10602, gid: 10600 },
      cgroupRoot: '/sys/fs/cgroup/saycode',
    },
  },
  policy: { ttlMs: 60000, toolTimeoutMs: 5000 },
  onUnprovenTermination: () => undefined,
  // The same Happy the fixture's envelope names. A runtime provisioned for a
  // different one refuses the envelope before anything else, which is the
  // origin gate doing its job — not what these cases are about.
  serverOrigin: ${JSON.stringify(ENVELOPE_ORIGIN)},
  checkpoint: {
    tenant: { tenantId: 'co_1', projectId: 'pr_1' },
    volume: () => ({ volumeId: 'vol_1', deviceUuid: 'dev-1' }),
    image: { imageVersion: 'img@1' },
    areas: [{ area: 'project', root: ${JSON.stringify(join(dir, 'project'))} }],
    drainBudgetMs: 1000,
    flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
    targets: { next: async () => null },
    policy: null,
    workDir: ${JSON.stringify(join(dir, 'work'))},
  },
});
const runtime = createSupervisorRuntime({
  ${over.managedRun ? 'managedRun: composition.managedRun,' : ''}
  config: {
    cgroupRoot: '/sys/fs/cgroup/saycode',
    helperPath: '/usr/local/lib/saycode/exec-helper',
    workloadPath: '/usr/local/lib/saycode/node',
    resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
  },
  manifestRoot: ${JSON.stringify(join(dir, 'manifest'))},
  stagingRoot: ${JSON.stringify(join(dir, 'staging'))},
  socketPath: ${JSON.stringify(socketPath)},
  watchdogIntervalMs: 250,
  releaseDeadlineMs: 2000,
  runtimeId: 'fixture-' + process.pid,
  token: ${JSON.stringify(TOKEN)},
  ${over.bootstrapFd === undefined ? '' : `bootstrapFd: ${over.bootstrapFd},`}
  // 운영은 Linux 추상 소켓 잠금을 쓴다. 이 fixture 는 macOS 에서도 돌아야 해서
  // 그 자리만 바꾼다 — 잠금 자체의 계약은 아래 전용 테스트가 확인한다.
  acquireLock: async () => ({ ok: true, release: async () => {} }),
});
await runtime.start();
process.send?.('ready');
`);
        child = spawn(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, entry], {
            cwd: PACKAGE_ROOT,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('supervisor did not start')), 20_000);
            child!.on('message', () => { clearTimeout(timer); resolve(); });
            let stderr = '';
            child!.stderr?.on('data', (chunk) => { stderr += String(chunk); });
            child!.on('exit', (code) => {
                clearTimeout(timer);
                reject(new Error(`exited ${code}: ${stderr.slice(0, 600)}`));
            });
        });
    }

    /**
     * 경로 게이트는 **끄지 않는다.** 관측만 좁힌다.
     *
     * 이 픽스처의 소켓은 `mkdtemp(tmpdir())` 아래에 있다. 그 트리는 테스트 사용자
     * 소유이고(Linux 의 `/tmp` 은 `1777`), 실제 `lstat` 으로는 정확히 거절된다 —
     * 그러면 이 파일이 증명하려던 실제 프로세스 간 왕복이 통째로 사라진다. 걷기와
     * root 전용 정책은 그대로 돌고, 바뀌는 것은 각 구성요소를 무엇으로 보느냐뿐이다.
     * (macOS 의 `/var` 는 symlink 이므로 임시 트리 밖은 고정 값으로 관측한다.)
     */
    function trustedObservation(): ManagedProvisioningDeps {
        return {
            getuid: () => 0,
            lstatDir: (path: string) => {
                if (!path.startsWith(dir) || path === dir) {
                    return { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false };
                }
                const stat = lstatSync(path);
                return {
                    uid: 0,
                    mode: stat.mode,
                    isDirectory: stat.isDirectory(),
                    isSymbolicLink: stat.isSymbolicLink(),
                };
            },
            statGate: () => null,
            probeIsolationBackend: probeIsolationBackendUnavailable,
        } as ManagedProvisioningDeps;
    }

    function client(token = TOKEN) {
        return createLauncherClient({
            token,
            deps: createUnixSocketRequest(socketPath, 5_000, { provisioning: trustedObservation() }),
        });
    }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'supervisor-process-'));
        socketPath = join(dir, 'launcher.sock');
        // 진입 스크립트는 패키지 안에 둔다. 패키지 밖의 절대 `.ts` 경로를
        // import 하면 tsx 가 변환하지 못한다.
        entryDir = mkdtempSync(join(PACKAGE_ROOT, '.supervisor-fixture-'));
    });

    afterEach(() => {
        child?.kill('SIGKILL');
        child = null;
        rmSync(dir, { recursive: true, force: true });
        rmSync(entryDir, { recursive: true, force: true });
    });

    it('answers a fencing question over the real socket', async () => {
        await startSupervisor();
        // 아무것도 띄운 적이 없으니 증명할 대상이 없다.
        expect(await client().proveGenerationStopped({ belowEpoch: Number.MAX_SAFE_INTEGER }))
            .toMatchObject({ proven: true });
    }, 30_000);

    it('refuses a client without the boot token', async () => {
        await startSupervisor();
        expect(await client('wrong-token').requestStop(KEY))
            .toEqual({ requested: false, detail: 'unauthorized' });
    }, 30_000);

    it('refuses a bootstrap that is not a real B2 envelope, without staging it', async () => {
        await startSupervisor();
        const prepared = await client().prepareLaunch({
            key: KEY, leaseExpiresMonotonic: Date.now() + 60_000,
            bootstrap: Buffer.from('{"not":"an envelope"}'),
            reportCredential: reportCredential(),
        });
        expect(prepared).toEqual({ prepared: false, detail: 'bootstrap-invalid' });
    }, 30_000);

    it('refuses a valid envelope when this supervisor has no managed run config', async () => {
        await startSupervisor();
        // 이 fixture 는 `managedRun` 없이 뜬다. 봉투가 완전히 유효해도 park 하면
        // broker 도 provider plan 도 별도 executor uid 도 없이 runtime 의 고정
        // workload 를 띄우게 된다 — managed 처럼 보이는데 아닌 자식이다.
        const prepared = await client().prepareLaunch({
            key: KEY, leaseExpiresMonotonic: Date.now() + 60_000,
            bootstrap: Buffer.from(JSON.stringify(validEnvelope())),
            reportCredential: reportCredential(),
        });
        expect(prepared).toEqual({ prepared: false, detail: 'managed-run-unconfigured' });
    }, 30_000);

    /** Asks the supervisor how many descriptors it currently holds. */
    function fdReport(): Promise<{ fds: number }> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no fd report')), 5_000);
            child!.once('message', (m) => { clearTimeout(timer); resolve(m as never); });
            child!.send('fd-report');
        });
    }

    it('refuses a descriptor conflict without opening either document', async () => {
        /*
         * `bootstrapFd` is configurable, so it can be pointed at a slot that
         * is already spoken for — here the report credential's own descriptor.
         * Two documents on one descriptor means the child reads one as the
         * other, and the failure surfaces far away.
         *
         * The assertion is what the supervisor **opened**, not the refusal
         * code: the code is identical with the guard on either side of
         * staging. `stageBootstrap` opens one descriptor per document and the
         * descriptor-conflict return closes nothing, so a guard after staging
         * leaks two per refused launch.
         */
        await startSupervisor({ managedRun: true, bootstrapFd: MANAGED_REPORT_CHILD_FD });
        // Baseline taken with the socket already listening, so the only thing
        // that could move it is this launch.
        const { fds: before } = await fdReport();
        expect(before).toBeGreaterThan(0);

        const prepared = await client().prepareLaunch({
            key: KEY, leaseExpiresMonotonic: Date.now() + 60_000,
            bootstrap: Buffer.from(JSON.stringify(validEnvelope())),
            reportCredential: reportCredential(),
        });

        expect(prepared).toEqual({ prepared: false, detail: 'descriptor-conflict' });
        // Nothing was opened, so nothing can have been left open.
        expect((await fdReport()).fds).toBe(before);
    }, 30_000);

    it('lets a well-formed launch through and closes what it opened', async () => {
        /*
         * Two things at once, and both matter.
         *
         * The guard let this launch through — a guard that refused everything
         * would satisfy the case above for the wrong reason. And the launch
         * then failed for its own reason (no cgroup, no root here) while
         * leaving the descriptor count where it started, which is the
         * `prepare-failed` path closing both documents.
         *
         * That the instrument can see a leak at all is shown by mutation:
         * moving the guard back after staging makes the case above report
         * two descriptors that are never closed.
         */
        await startSupervisor({ managedRun: true });
        const { fds: before } = await fdReport();

        const prepared = await client().prepareLaunch({
            key: KEY, leaseExpiresMonotonic: Date.now() + 60_000,
            bootstrap: Buffer.from(JSON.stringify(validEnvelope())),
            reportCredential: reportCredential(),
        });

        /*
         * The exact refusal, not merely "not descriptor-conflict": a weaker
         * assertion passes on any unrelated earlier refusal, and an earlier
         * refusal is precisely what would mean the guard was never reached.
         *
         * `launch-failed` is the generation launch itself failing — this
         * process has no cgroup and no root — which is only reachable after
         * both documents were staged.
         */
        expect(prepared).toEqual({ prepared: false, detail: 'launch-failed' });
        expect((await fdReport()).fds).toBe(before);
    }, 30_000);

    it('a release handle that was never issued is refused', async () => {
        await startSupervisor();
        expect(await client().releaseLaunch('0'.repeat(32)))
            .toEqual({ released: false, detail: 'unknown-handle' });
    }, 30_000);

    it('refuses to renew a generation this supervisor never launched', async () => {
        await startSupervisor();
        expect(await client().renew({
            key: KEY, renewalSeq: 1, leaseExpiresMonotonic: Date.now() + 60_000,
        })).toEqual({ renewed: false, detail: 'never-launched' });
    }, 30_000);

    it.skipIf(process.platform !== 'linux')('a second supervisor on the same runtime id refuses to start', async () => {
        await startSupervisor();
        const entry = join(entryDir, 'second.ts');
        writeFileSync(entry, `
import { acquireSupervisorLock } from ${JSON.stringify(join(__dirname, 'supervisor'))};
const shared = { runtimeId: 'fixtureshared', manifestRoot: '/tmp', cgroupRoot: '/tmp' };
const first = await acquireSupervisorLock(shared);
// 같은 물리 자원을 **다른 runtimeId** 로 열어도 막혀야 한다.
const second = await acquireSupervisorLock({ ...shared, runtimeId: 'fixtureother' });
console.log(JSON.stringify({ first: first.ok, second }));
process.exit(0);
`);
        const output = await new Promise<string>((resolve) => {
            const probe = spawn(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, entry], {
                cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            probe.stdout.on('data', (chunk) => { out += String(chunk); });
            probe.on('close', () => resolve(out));
        });
        const parsed = JSON.parse(output.trim().split('\n').pop() ?? '{}');
        expect(parsed.first).toBe(true);
        // 두 번째는 같은 이름을 잡지 못한다 — 원장과 cgroup 을 나눠 쓰지 않는다.
        expect(parsed.second).toMatchObject({ ok: false, reason: 'already-held' });
    }, 30_000);
});

describe('supervisor exclusivity', () => {
    it('is a Linux-only lock and says so rather than pretending', async () => {
        const { acquireSupervisorLock } = await import('./supervisor');
        const result = await acquireSupervisorLock({
            runtimeId: 'exclusivityprobe', manifestRoot: '/tmp', cgroupRoot: '/tmp',
        });
        if (process.platform === 'linux') {
            expect(result).toMatchObject({ ok: true });
            if (result.ok) await result.release();
        } else {
            // managed 는 Linux 전용이다. 다른 곳에서 잠금을 흉내내면 두
            // supervisor 가 같은 원장을 쓰는 것을 막는다고 착각하게 된다.
            expect(result).toEqual({ ok: false, reason: 'not-linux' });
        }
    });

    it('refuses a runtime id that could escape the lock namespace', async () => {
        const { supervisorLockAddress } = await import('./supervisor');
        for (const runtimeId of ['a b', '../x', '']) {
            expect(() => supervisorLockAddress({
                runtimeId, manifestRoot: '/tmp', cgroupRoot: '/tmp',
            })).toThrow(/safe runtimeId/);
        }
    });
});

describe('the runtime grant snapshot follows the lock', () => {
    /*
     * The snapshot is this supervisor's record of the parent's statement. It
     * has to be dropped exactly when this supervisor stops speaking for the
     * runtime - after the IPC drain and with the lock released - and kept for
     * as long as the lock is kept, including a stop that could not prove
     * itself. Clearing earlier would be undone by a handler the drain is still
     * waiting for; clearing on an unproven stop would leave a supervisor still
     * holding the lock with no record of what it was told.
     */
    const harness = async (root: string, cleared: string[]) => {
        const { createSupervisorRuntime } = await import('./main');
        return createSupervisorRuntime({
            config: {
                cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/h', workloadPath: '/w',
                resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
            },
            manifestRoot: join(root, 'manifest'),
            stagingRoot: join(root, 'staging'),
            socketPath: join(root, 'launcher.sock'),
            watchdogIntervalMs: 10_000,
            releaseDeadlineMs: 5_000,
            runtimeId: 'grantsnapshot',
            acquireLock: async () => ({ ok: true, release: async () => { cleared.push('lock'); } }),
            clearRuntimeGrant: () => { cleared.push('snapshot'); },
        });
    };

    it('shouldClearTheSnapshotOnlyAfterTheDrainAndTheLockRelease', async () => {
        const root = mkdtempSync(join(tmpdir(), 'grant-stop-'));
        const cleared: string[] = [];
        try {
            const runtime = await harness(root, cleared);
            await runtime.start();
            expect(await runtime.stop()).toEqual({ stopped: true });
            // The lock goes first; the snapshot is dropped behind it, so no
            // in-flight handler can repopulate what has already been cleared.
            expect(cleared).toEqual(['lock', 'snapshot']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('shouldKeepTheSnapshotWhenTheStopCouldNotBeProvenAndTheLockIsHeld', async () => {
        const root = mkdtempSync(join(tmpdir(), 'grant-stop-unproven-'));
        const cleared: string[] = [];
        try {
            const runtime = await harness(root, cleared);
            await runtime.start();
            runtime.manifest.recordLaunch({
                key: { runId: 'r', attemptId: 'a', epoch: 0 }, launchedAt: Date.now(),
            });
            expect(await runtime.stop()).toMatchObject({ stopped: false });
            // Neither released: this supervisor still speaks for the runtime.
            expect(cleared).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('shutdown does not orphan released children (Astra P1-3)', () => {
    it('keeps the watchdog and the lock when an open generation cannot be proven stopped', async () => {
        const { createSupervisorRuntime } = await import('./main');
        const root = mkdtempSync(join(tmpdir(), 'shutdown-guard-'));
        try {
            let lockReleased = false;
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode',
                    helperPath: '/usr/local/lib/saycode/exec-helper',
                    workloadPath: '/usr/local/lib/saycode/node',
                    resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(root, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'shutdown-guard',
                acquireLock: async () => ({
                    ok: true,
                    release: async () => { lockReleased = true; },
                }),
            });
            await runtime.start();
            // 이전에 놓아준 자식이 남아 있는 상태를 만든다: 원장에 열린 기록이
            // 있고, cgroup 은 이 환경에 없어 정지를 증명할 수 없다.
            runtime.manifest.recordLaunch({
                key: { runId: 'r', attemptId: 'a', epoch: 0 }, launchedAt: Date.now(),
            });
            const result = await runtime.stop();
            expect(result).toMatchObject({ stopped: false });
            if (!result.stopped) expect(result.open).toHaveLength(1);
            // 감시를 놓는 것이 곧 그 자식을 잃는 것이다.
            expect(runtime.watchdog.armedCount()).toBe(1);
            expect(lockReleased).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('refuses to release the lock while the inventory cannot be read', async () => {
        const { createSupervisorRuntime } = await import('./main');
        const { writeFileSync } = await import('node:fs');
        const root = mkdtempSync(join(tmpdir(), 'shutdown-unreadable-'));
        try {
            let lockReleased = false;
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/h', workloadPath: '/w',
                    resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(root, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'shutdownunreadable',
                acquireLock: async () => ({ ok: true, release: async () => { lockReleased = true; } }),
            });
            await runtime.start();
            // 읽을 수 없는 기록 하나. 무엇이 열려 있는지 알 수 없는 상태다.
            writeFileSync(join(root, 'manifest', `${'a'.repeat(64)}.json`), 'broken');
            const result = await runtime.stop();
            expect(result).toMatchObject({ stopped: false, unreadable: 1 });
            expect(lockReleased).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('releases the lock only when nothing is left open', async () => {
        const { createSupervisorRuntime } = await import('./main');
        const root = mkdtempSync(join(tmpdir(), 'shutdown-clean-'));
        try {
            let lockReleased = false;
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode',
                    helperPath: '/h', workloadPath: '/w',
                    resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(root, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'shutdown-clean',
                acquireLock: async () => ({
                    ok: true,
                    release: async () => { lockReleased = true; },
                }),
            });
            await runtime.start();
            expect(await runtime.stop()).toEqual({ stopped: true });
            expect(lockReleased).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe('the lock is bound to the physical resources, not to a name', () => {
    it('two different runtime ids over the same roots produce the same lock', async () => {
        const { supervisorLockAddress } = await import('./supervisor');
        const roots = { manifestRoot: '/tmp', cgroupRoot: '/tmp' };
        // 같은 원장과 같은 cgroup 을 여는 두 supervisor 는 서로를 막아야 한다.
        expect(supervisorLockAddress({ runtimeId: 'alpha', ...roots }))
            .toBe(supervisorLockAddress({ runtimeId: 'beta', ...roots }));
    });

    it('the same runtime over different roots is a different lock', async () => {
        const { supervisorLockAddress } = await import('./supervisor');
        expect(supervisorLockAddress({ runtimeId: 'r', manifestRoot: '/tmp', cgroupRoot: '/tmp' }))
            .not.toBe(supervisorLockAddress({ runtimeId: 'r', manifestRoot: '/var', cgroupRoot: '/tmp' }));
    });
});

describe('publishing the supervisor attestation from a live runtime', () => {
    /*
     * Driven through real runtimes from `createSupervisorRuntime` and the real
     * writer - never a test-local copy of the gate. A test that recomputed the
     * three flags itself would keep passing with the product's gate deleted.
     */
    /** Root-owned ancestry is asserted by the real writer, so it is faked here. */
    const trustAll = (): ManagedProvisioningDeps => ({
        getuid: () => 0,
        lstatDir: () => ({ uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false }),
        probeIsolationBackend: () => ({ verified: true as const }),
    });

    function build(root: string, over: Partial<Pick<SupervisorRuntimeOptions, 'runtimeId' | 'socketPath' | 'acquireLock' | 'attestation'>> & { stateDir?: string } = {}) {
        const stateDir = over.stateDir ?? join(root, 'state');
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        return createSupervisorRuntime({
            config: {
                cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/h', workloadPath: '/w',
                resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
            },
            manifestRoot: join(root, `manifest-${over.runtimeId ?? 'a'}`),
            stagingRoot: join(root, `staging-${over.runtimeId ?? 'a'}`),
            socketPath: over.socketPath ?? join(stateDir, 'launcher.sock'),
            watchdogIntervalMs: 10_000,
            releaseDeadlineMs: 5_000,
            runtimeId: over.runtimeId ?? 'rt-a',
            acquireLock: over.acquireLock ?? (async () => ({ ok: true, release: async () => {} })),
            attestation: over.attestation ?? {
                stateDir,
                provisioningOperationId: 'op-1',
                markerSha256: 'c'.repeat(64),
                provisioning: trustAll(),
            },
        });
    }

    it('serves the same copied hello through runtime and real IPC as the published record', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hello-live-'));
        const scope = { stateDir: join(root, 'state'), provisioningOperationId: 'op-original',
            markerSha256: 'c'.repeat(64), provisioning: trustAll() };
        const runtime = build(root, { attestation: scope });
        try {
            expect(runtime.hello()).toBeNull();
            await runtime.start();
            expect(existsSync(managedSupervisorAttestationPath(join(root, 'state')))).toBe(false);
            const first = runtime.hello();
            expect(existsSync(managedSupervisorAttestationPath(join(root, 'state')))).toBe(false);
            expect(first).not.toBeNull();
            scope.provisioningOperationId = 'mutated';
            scope.markerSha256 = 'd'.repeat(64);
            expect(runtime.publishAttestation()).toBe('published');
            const record = JSON.parse(readFileSync(managedSupervisorAttestationPath(join(root, 'state')), 'utf8'));
            const expected = { instanceNonce: record.instanceNonce, runtimeId: record.runtimeId,
                provisioningOperationId: record.provisioningOperationId, markerSha256: record.markerSha256 };
            expect(first).toEqual(expected);
            if (!first) throw new Error('hello missing');
            first.runtimeId = 'caller-mutated';
            expect(runtime.hello()).toEqual(expected);
            const response = await new Promise<unknown>((resolve, reject) => {
                const socket = connect(join(root, 'state', 'launcher.sock'));
                socket.on('error', reject);
                socket.on('connect', () => socket.write(JSON.stringify({ op: 'hello', token: runtime.token }) + '\n'));
                let raw = '';
                socket.on('data', (chunk) => {
                    raw += chunk.toString();
                    if (raw.includes('\n')) { socket.destroy(); resolve(JSON.parse(raw.trim())); }
                });
            });
            expect(response).toEqual({ ok: true, result: expected });
            const stopped = runtime.stop();
            expect(runtime.hello()).toBeNull();
            await stopped;
            expect(runtime.hello()).toBeNull();
        } finally {
            await runtime.stop();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('uses one transferred lock acquisition and releases it only through proven runtime stop', async () => {
        const root = mkdtempSync(join(tmpdir(), 'runtime-handoff-'));
        let takes = 0; let releases = 0;
        const runtime = build(root, { acquireLock: async (scope) => {
            takes += 1;
            expect(scope).toEqual({ runtimeId: 'rt-a', manifestRoot: join(root, 'manifest-a'), cgroupRoot: '/sys/fs/cgroup/saycode' });
            return { ok: true, release: async () => { releases += 1; } };
        } });
        try {
            await runtime.start();
            expect(takes).toBe(1); expect(releases).toBe(0);
            expect(await runtime.stop()).toEqual({ stopped: true });
            expect(releases).toBe(1);
        } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
    });

    it('shouldRefuseBeforeListenAndPublishAfterIt', async () => {
        const root = mkdtempSync(join(tmpdir(), 'att-listen-'));
        try {
            const runtime = build(root);
            // Constructed but not listening: nothing has bound the socket.
            expect(runtime.publishAttestation()).toBe('refused-not-current');
            expect(runtime.hello()).toBeNull();
            await runtime.start();
            expect(runtime.publishAttestation()).toBe('published');

            // The writer runs as this test user. Inspect its actual bytes and
            // mode; the production reader correctly requires root ownership.
            const path = managedSupervisorAttestationPath(join(root, 'state'));
            const record = JSON.parse(readFileSync(path, 'utf8'));
            expect(lstatSync(path).mode & 0o777).toBe(0o600);
            expect(record.runtimeId).toBe('rt-a');
            expect(record.markerSha256).toBe('c'.repeat(64));
            expect(record.socketPath).toBe(join(root, 'state', 'launcher.sock'));
            expect(record.instanceNonce).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
            await runtime.stop();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('shouldRefuseFromStopsFirstLineAndNeverComeBack', async () => {
        /*
         * `stop()` sets its flag on its **first line**, before any await. So a
         * publish attempted after `stop()` is invoked - and before any of its
         * awaits have settled - must already refuse. The lock release is held
         * open here so the attempt genuinely lands inside a running `stop()`
         * rather than after it.
         */
        const root = mkdtempSync(join(tmpdir(), 'att-stop-'));
        try {
            let releaseHeld: (() => void) | null = null;
            const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
            const stateDir = join(root, 'state');
            mkdirSync(stateDir, { recursive: true, mode: 0o700 });
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/h', workloadPath: '/w',
                    resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(stateDir, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'rt-stop',
                acquireLock: async () => ({ ok: true, release: async () => { await held; } }),
                attestation: {
                    stateDir,
                    provisioningOperationId: 'op-1',
                    markerSha256: 'c'.repeat(64),
                    provisioning: trustAll(),
                },
            });
            await runtime.start();
            expect(runtime.publishAttestation()).toBe('published');

            const stopping = runtime.stop();
            // Synchronously after the call, with `stop()` still in flight.
            expect(runtime.publishAttestation()).toBe('refused-not-current');
            expect(runtime.hello()).toBeNull();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(runtime.publishAttestation()).toBe('refused-not-current');
            expect(runtime.hello()).toBeNull();
            releaseHeld!();
            await stopping;
            // Never reset: a stop that has begun has begun.
            expect(runtime.publishAttestation()).toBe('refused-not-current');
            expect(runtime.hello()).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('shouldKeepTwoRuntimesIndependentAndLetBReplaceA', async () => {
        /*
         * Instance-local flags: A stopping must not silence B. And the
         * replacement case - A published, A stopped, B publishes - leaves B's
         * record, with A unable to publish again.
         */
        const root = mkdtempSync(join(tmpdir(), 'att-ab-'));
        const stateDir = join(root, 'state');
        try {
            const a = build(root, { runtimeId: 'rt-a' });
            const b = build(root, { runtimeId: 'rt-b', stateDir });
            await a.start();
            expect(a.publishAttestation()).toBe('published');
            const previous = JSON.parse(readFileSync(managedSupervisorAttestationPath(stateDir), 'utf8'));
            await a.stop();
            // A is done; B is untouched by that.
            expect(a.publishAttestation()).toBe('refused-not-current');
            await b.start();
            expect(b.publishAttestation()).toBe('published');

            const current = JSON.parse(readFileSync(managedSupervisorAttestationPath(stateDir), 'utf8'));
            expect(current.runtimeId).toBe('rt-b');
            expect(current.instanceNonce).not.toBe(previous.instanceNonce);
            expect(a.publishAttestation()).toBe('refused-not-current');
            await b.stop();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('shouldRefuseWithNoScopeWhenNoAttestationConfigWasGiven', async () => {
        // The generic factory has non-managed consumers; they supply no
        // identity axes and must not be made to invent any.
        const root = mkdtempSync(join(tmpdir(), 'att-scope-'));
        try {
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/h', workloadPath: '/w',
                    resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(root, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'rt-generic',
                acquireLock: async () => ({ ok: true, release: async () => {} }),
            });
            await runtime.start();
            expect(runtime.publishAttestation()).toBe('refused-no-scope');
            expect(runtime.hello()).toBeNull();
            expect(existsSync(managedSupervisorAttestationPath(root))).toBe(false);
            await runtime.stop();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('shouldJudgeAncestryWithTheRealObservationWhenNoneIsInjected', async () => {
        /*
         * No injected `provisioning`: the runtime uses the real one, and the
         * writer judges the live ancestry with it. Under a temporary root -
         * not a root-only chain - that is a refusal, and **nothing is written**.
         *
         * This is the default path exercised as the default path. It asserts
         * the refusal that a non-root ancestry actually produces here rather
         * than asserting a success that would need root to reach.
         */
        const root = mkdtempSync(join(tmpdir(), 'att-real-'));
        const stateDir = join(root, 'state');
        try {
            mkdirSync(stateDir, { recursive: true, mode: 0o700 });
            const runtime = createSupervisorRuntime({
                config: {
                    cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/h', workloadPath: '/w',
                    resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
                },
                manifestRoot: join(root, 'manifest'),
                stagingRoot: join(root, 'staging'),
                socketPath: join(stateDir, 'launcher.sock'),
                watchdogIntervalMs: 10_000,
                releaseDeadlineMs: 5_000,
                runtimeId: 'rt-real',
                acquireLock: async () => ({ ok: true, release: async () => {} }),
                // No `provisioning` key at all.
                attestation: {
                    stateDir,
                    provisioningOperationId: 'op-1',
                    markerSha256: 'd'.repeat(64),
                },
            });
            await runtime.start();
            expect(runtime.publishAttestation()).toBe('refused-write:untrusted');
            expect(existsSync(managedSupervisorAttestationPath(stateDir))).toBe(false);
            await runtime.stop();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it('shouldReportTheWritersOwnStageAndLeaveTheEarlierRecordInPlace', async () => {
        /*
         * A failing promote keeps the previous bytes. The stage travels from
         * the writer unchanged rather than being folded into one "failed".
         */
        const root = mkdtempSync(join(tmpdir(), 'att-stage-'));
        const stateDir = join(root, 'state');
        try {
            const runtime = build(root, { stateDir });
            await runtime.start();
            expect(runtime.publishAttestation()).toBe('published');
            const first = readFileSync(managedSupervisorAttestationPath(stateDir));

            // A directory where the temporary file must go: the writer cannot
            // create it, and says which stage it stopped at.
            mkdirSync(`${managedSupervisorAttestationPath(stateDir)}.tmp`, { recursive: true });
            expect(runtime.publishAttestation()).toBe('refused-write:temporary-exists');
            expect(readFileSync(managedSupervisorAttestationPath(stateDir)).equals(first)).toBe(true);
            await runtime.stop();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
    it('shouldRefuseWhileAnAcceptedSocketKeepsTheIpcDrainOpen', async () => {
        const root = mkdtempSync(join(tmpdir(), 'att-drain-'));
        let released = false;
        const runtime = build(root, { acquireLock: async () => ({ ok: true, release: async () => { released = true; } }) });
        let socket: ReturnType<typeof connect> | undefined;
        try {
            await runtime.start();
            expect(runtime.publishAttestation()).toBe('published');
            const path = managedSupervisorAttestationPath(join(root, 'state'));
            const before = readFileSync(path);
            socket = connect(join(root, 'state', 'launcher.sock'));
            await new Promise<void>((resolve, reject) => { socket!.once('connect', resolve); socket!.once('error', reject); });
            const stopping = runtime.stop();
            await Promise.resolve();
            expect(released).toBe(false);
            expect(runtime.publishAttestation()).toBe('refused-not-current');
            expect(runtime.hello()).toBeNull();
            expect(readFileSync(path)).toEqual(before);
            socket.destroy();
            await stopping;
            expect(released).toBe(true);
        } finally {
            socket?.destroy();
            await runtime.stop();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('shouldRetainThePublicationRefusalAfterAnUnprovenStop', async () => {
        const root = mkdtempSync(join(tmpdir(), 'att-unproven-'));
        let released = false;
        const runtime = build(root, { acquireLock: async () => ({ ok: true, release: async () => { released = true; } }) });
        const key = { runId: 'unobserved', attemptId: 'attempt', epoch: 1 };
        try {
            await runtime.start();
            expect(runtime.publishAttestation()).toBe('published');
            const before = readFileSync(managedSupervisorAttestationPath(join(root, 'state')));
            runtime.manifest.recordLaunch({ key, launchedAt: Date.now() });
            expect(await runtime.stop()).toMatchObject({ stopped: false });
            expect(released).toBe(false);
            expect(runtime.publishAttestation()).toBe('refused-not-current');
            expect(runtime.hello()).toBeNull();
            expect(readFileSync(managedSupervisorAttestationPath(join(root, 'state')))).toEqual(before);
        } finally {
            // This fixture launched no process. Close its synthetic intent so
            // cleanup can release the real runtime's watchdog and socket.
            runtime.manifest.recordTermination({ key, observedEmptyAt: Date.now() });
            await runtime.stop();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('shouldKeepTheConstructionScopeAndNonceAcrossPublications', async () => {
        const root = mkdtempSync(join(tmpdir(), 'att-copy-'));
        const stateDir = join(root, 'state');
        const attestation = { stateDir, provisioningOperationId: 'original-op', markerSha256: 'a'.repeat(64), provisioning: trustAll() };
        const runtime = build(root, { attestation });
        try {
            attestation.stateDir = join(root, 'elsewhere');
            attestation.provisioningOperationId = 'changed-op';
            attestation.markerSha256 = 'b'.repeat(64);
            await runtime.start();
            expect(runtime.publishAttestation()).toBe('published');
            const path = managedSupervisorAttestationPath(stateDir);
            const first = readFileSync(path);
            expect(JSON.parse(first.toString())).toMatchObject({ provisioningOperationId: 'original-op', markerSha256: 'a'.repeat(64) });
            expect(runtime.publishAttestation()).toBe('published');
            expect(readFileSync(path)).toEqual(first);
            expect(existsSync(managedSupervisorAttestationPath(attestation.stateDir))).toBe(false);
        } finally {
            await runtime.stop();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('shouldRefuseAfterTheLockIsAcquiredButListenFails', async () => {
        const root = mkdtempSync(join(tmpdir(), 'att-listen-failed-'));
        const runtime = build(root, { socketPath: join(root, 'state', 'missing-parent', 'launcher.sock') });
        try {
            await expect(runtime.start()).rejects.toThrow();
            expect(runtime.publishAttestation()).toBe('refused-not-current');
            expect(runtime.hello()).toBeNull();
            expect(existsSync(managedSupervisorAttestationPath(join(root, 'state')))).toBe(false);
        } finally {
            await runtime.stop();
            rmSync(root, { recursive: true, force: true });
        }
    });

});


describe('checkpoint work settles before supervisor ownership is released', () => {
    function runtimeFor(root: string, stopCheckpointWork: () => Promise<{ pendingPublication: boolean }>, release: () => Promise<void>) {
        return createSupervisorRuntime({
            config: { cgroupRoot: '/sys/fs/cgroup/saycode', helperPath: '/h', workloadPath: '/w',
                resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }) },
            manifestRoot: join(root, 'manifest'), stagingRoot: join(root, 'staging'),
            socketPath: join(root, 'launcher.sock'), runtimeId: 'checkpoint-stop',
            watchdogIntervalMs: 60_000, releaseDeadlineMs: 1000,
            acquireLock: async () => ({ ok: true, release }), stopCheckpointWork,
        });
    }

    it.each([false, true])('holds real coordinator work and admission through stop (timeout=%s)', async (timeout) => {
        const { createManagedCheckpointRunner } = await import('@/managed/checkpoint/managedCheckpointRunner');
        const { createManagedCheckpointCoordinator } = await import('@/managed/checkpoint/managedCheckpointCoordinator');
        const { createManagedCheckpointTickLoop } = await import('@/managed/checkpoint/managedCheckpointTickLoop');
        const root = mkdtempSync(join(tmpdir(), 'checkpoint-stop-'));
        const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'file'), 'local bytes');
        let finishPut!: () => void;
        let enteredPut!: () => void;
        const entered = new Promise<void>(resolve => { enteredPut = resolve; });
        const held = new Promise<void>(resolve => { finishPut = resolve; });
        const settlements: string[] = [];
        const runner = createManagedCheckpointRunner({
            tenant: { tenantId: 'tenant', projectId: 'project' }, volume: () => ({ volumeId: 'volume', deviceUuid: 'device' }),
            image: { imageVersion: 'fixture' }, sources: [{ area: 'project', root: project }],
            workDir: join(root, 'checkpoint-work'), drainBudgetMs: 1000, writeTools: new Set<string>(),
            flushDeps: { run: async () => ({ code: 0, stdout: '' }) }, now: () => 1000,
            fetchImpl: async () => { enteredPut(); await held; throw new Error('simulated remote reply lost'); },
        });
        const coordinator = createManagedCheckpointCoordinator({
            runner, policy: { periodMs: 1000, onTurnBoundary: true },
            targets: {
                next: async () => ({ checkpointId: 'a'.repeat(64), key: Buffer.alloc(32, 1), targets: {
                    objects: new Map([['project' as const, { putUrl: 'https://store.invalid/project', headUrl: 'https://store.invalid/project' }]]),
                    manifest: { putUrl: 'https://store.invalid/manifest', headUrl: 'https://store.invalid/manifest' },
                    pointer: { putUrl: 'https://store.invalid/latest', getUrl: 'https://store.invalid/latest' },
                } }),
                settle: ({ outcome }) => { settlements.push(outcome); },
            },
        });
        const timers = new Map<number, { fn: () => void; ms: number }>(); let timerId = 0;
        const loop = createManagedCheckpointTickLoop({
            coordinator, intervalMs: 1000, shutdownWaitMs: 17, idle: () => ({ state: 'idle', forMs: 1 }), now: () => 1000,
            setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
            clearTimer: handle => { timers.delete(handle as number); },
        });
        const releasedStates: { inFlight: boolean | undefined; draining: boolean }[] = [];
        const release = vi.fn(async () => {
            releasedStates.push({ inFlight: coordinator.scheduleState().inFlight, draining: runner.checkpointDrain.drain.isDraining() });
        });
        const stopWork = vi.fn(() => loop.stop());
        const runtime = runtimeFor(root, stopWork, release);
        let tick: ReturnType<typeof loop.tickNow> | undefined;
        try {
            await runtime.start();
            const providerCleanup = vi.spyOn(runtime.manifest, 'listOpen');
            const watchdogStop = vi.spyOn(runtime.watchdog, 'stop');
            loop.start(); tick = loop.tickNow('periodic'); await entered;
            expect(runner.checkpointDrain.drain.isDraining()).toBe(true);
            const stopping = runtime.stop();
            expect(stopWork).toHaveBeenCalledOnce(); // Before runtime.stop's first await.
            expect(await loop.tickNow('periodic')).toEqual({ ticked: false });
            expect([...timers.values()].map(timer => timer.ms)).toEqual([17]);
            expect(providerCleanup).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
            if (timeout) {
                [...timers.values()][0].fn();
                expect(await stopping).toMatchObject({ stopped: false, detail: 'checkpoint-work-unproven' });
                expect(providerCleanup).not.toHaveBeenCalled(); expect(watchdogStop).not.toHaveBeenCalled();
                expect(release).not.toHaveBeenCalled();
                expect(coordinator.scheduleState().inFlight).toBe(true);
            }
            finishPut(); await tick;
            expect(settlements).toEqual(['uncertain']);
            expect(coordinator.checkpointState().saved).toBe(false);
            expect(await (timeout ? runtime.stop() : stopping)).toEqual({ stopped: true });
            expect(release).toHaveBeenCalledOnce(); expect(watchdogStop).toHaveBeenCalledOnce();
            expect(releasedStates).toEqual([{ inFlight: false, draining: false }]);
            expect(timers.size).toBe(0); // Settling work cannot rearm after stop.
        } finally {
            finishPut(); await tick; await loop.stop(); await runtime.stop();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each(['throw', 'reject', 'missing', 'null', 'true', 'getter'] as const)('keeps ownership for a %s checkpoint-stop result', async mode => {
        const root = mkdtempSync(join(tmpdir(), 'checkpoint-stop-refused-'));
        let cleanup = false;
        const release = vi.fn(async () => {});
        const stopWork = () => {
            if (cleanup) return Promise.resolve({ pendingPublication: false });
            if (mode === 'throw') throw new Error('private path');
            if (mode === 'reject') return Promise.reject(new Error('private path'));
            if (mode === 'getter') return Promise.resolve({ get pendingPublication(): boolean { throw new Error('private field'); } });
            return Promise.resolve(mode === 'true' ? { pendingPublication: true } : mode === 'null' ? null : {}) as Promise<{ pendingPublication: boolean }>;
        };
        const runtime = runtimeFor(root, stopWork, release);
        try {
            await runtime.start();
            const providerCleanup = vi.spyOn(runtime.manifest, 'listOpen');
            const watchdogStop = vi.spyOn(runtime.watchdog, 'stop');
            expect(await runtime.stop()).toEqual({ stopped: false, open: [], unreadable: 0, detail: 'checkpoint-work-unproven' });
            expect(providerCleanup).not.toHaveBeenCalled(); expect(watchdogStop).not.toHaveBeenCalled();
            expect(release).not.toHaveBeenCalled();
        } finally { cleanup = true; await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
    });

    it.each([false, true])('closes tick admission before a real IPC drain and observes rejection immediately (%s)', async rejects => {
        const root = mkdtempSync(join(tmpdir(), 'checkpoint-ipc-drain-'));
        const release = vi.fn(async () => {});
        let cleanup = false;
        const stopWork = vi.fn(() => rejects && !cleanup
            ? Promise.reject(new Error('private checkpoint failure'))
            : Promise.resolve({ pendingPublication: false }));
        const runtime = runtimeFor(root, stopWork, release);
        let socket: ReturnType<typeof connect> | undefined;
        try {
            await runtime.start();
            const providerCleanup = vi.spyOn(runtime.manifest, 'listOpen');
            socket = connect(join(root, 'launcher.sock'));
            await new Promise<void>((resolve, reject) => { socket!.once('connect', resolve); socket!.once('error', reject); });
            const stopping = runtime.stop();
            expect(stopWork).toHaveBeenCalledOnce();
            let finished = false;
            void stopping.then(() => { finished = true; });
            await new Promise(resolve => setTimeout(resolve, 15));
            expect(finished).toBe(false);
            expect(providerCleanup).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
            socket.destroy();
            expect(await stopping).toEqual(rejects
                ? { stopped: false, open: [], unreadable: 0, detail: 'checkpoint-work-unproven' }
                : { stopped: true });
            expect(release).toHaveBeenCalledTimes(rejects ? 0 : 1);
        } finally { socket?.destroy(); cleanup = true; await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
    });

});

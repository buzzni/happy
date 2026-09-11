/**
 * The root boot stage: order, refusals, and what never leaks.
 *
 * The individual pieces have their own tests. What is only visible here is the
 * sequence — a record published before the supervisor is listening names an
 * address nothing answers on, and a daemon that reads it reports a wired
 * backend that cannot prove anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as launcherMain from '@/launcher/main';
import * as managedRunConfig from '@/launcher/managedRunConfig';
import * as runtimeCheckpointing from '@/managed/checkpoint/managedRuntimeCheckpointing';
import type { ManagedCheckpointTickLoop } from '@/managed/checkpoint/managedCheckpointTickLoop';
import { supervisorLockAddress } from '@/launcher/supervisor';
import { tmpdir } from 'node:os';

import {
    assignTreeSync,
    defaultManagedRuntimeBootDeps,
    managedLauncherSocketPath,
    runManagedRuntimeBoot,
} from '@/managed/managedRuntimeBoot';
import { readManagedLauncherBinding } from '@/daemon/launch/managedLauncherBinding';
import {
    probeIsolationBackendUnavailable,
    type ManagedIdentityResolution,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const AGENT_UID = 10_602;
const PROVIDER_UID = 10_601;
const TOKEN = 'a-token-only-this-boot-knows';

function provisioning(): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: (path) => {
            if (!path.startsWith(base) || path === base) {
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
    };
}

/** The digest the active resolution carries beside the identity (freeze93/94). */
const MARKER_SHA256 = 'b'.repeat(64);

function identity(over: Partial<ManagedIdentityResolution> = {}): () => ManagedIdentityResolution {
    return () => ({
        status: 'active',
        markerSha256: MARKER_SHA256,
        identity: {
            runtimeId: 'rt-1',
            workspaceId: 'ws-1',
            projectId: 'proj-1',
            keyId: 'kid-1',
            happyMachineId: 'machine-1',
            provisioningOperationId: 'op-1',
            configDigest: 'digest-1',
            providerMachineId: 'provider-machine-1',
            providerInstanceId: 'provider-instance-1',
            providerVolumeId: 'vol_1',
            verifier: {} as never,
            stateDir,
            isolation: {
                backend: 'privileged-launch-supervisor',
                provider: { uid: PROVIDER_UID, gid: PROVIDER_UID },
                executor: { uid: AGENT_UID, gid: AGENT_UID },
                cgroupRoot: '/sys/fs/cgroup/saycode',
            },
            toolPolicy: { grantTtlMs: 600_000, callTimeoutMs: 120_000 },
        },
        ...over,
    } as ManagedIdentityResolution);
}

type Recorded = { event: string; detail?: string };


function bootDeps(over: Partial<Parameters<typeof runManagedRuntimeBoot>[0]> = {}) {
    const log: Recorded[] = [];
    const deps = {
        resolveIdentity: identity() as never,
        acquireOwnership: async (scope: { runtimeId: string; manifestRoot: string; cgroupRoot: string }) => ({
            ok: true as const, ownership: { scope: { ...scope }, address: supervisorLockAddress(scope), release: async () => {} },
        }),
        provisioning: provisioning(),
        makeTrustedDirectory: async (path: string, mode: number) => {
            log.push({ event: 'directory', detail: path });
            await mkdir(path, { recursive: true, mode });
            chmodSync(path, mode);
        },
        startSupervisor: async () => {
            log.push({ event: 'supervisor' });
            return {
                token: TOKEN,
                publishAttestation: () => {
                    log.push({ event: 'attestation' });
                    return 'published' as const;
                },
            };
        },
        // The image states the account; the fixture states it the same way.
        resolveDaemonAccount: () => ({ uid: 999, gid: 999 }),
        provisionDaemonStateLeaf: async (input: {
            path: string; uid: number; gid: number; mode: number;
        }) => {
            log.push({
                event: 'daemon-leaf',
                detail: `${input.path}:${input.uid}:${input.gid}:${input.mode.toString(8)}`,
            });
            await mkdir(input.path, { recursive: true, mode: input.mode });
            return { ok: true as const, created: true };
        },
        assignWorkspace: async (input: { path: string; uid: number; gid: number }) => {
            log.push({ event: 'workspace', detail: `${input.path}:${input.uid}:${input.gid}` });
        },
        assignProviderHome: async (input: { path: string; uid: number; gid: number; mode: number }) => {
            log.push({
                event: 'provider-home',
                detail: `${input.path}:${input.uid}:${input.gid}:${input.mode.toString(8)}`,
            });
        },
        // The default for cases that are not about staging. Every case that is
        // overrides it, and the real CLI's own is asserted separately.
        inspectRestoreStaging: async () => 'clear' as const,
        // Likewise for the identity handoff: the cases about it override this,
        // and the real CLI's own is asserted in its own file.
        adoptCredential: async () => ({ status: 'absent' as const }),
        // 저장된 credential 의 origin. 실제로는 디스크에서 읽는다.
        readTrustedServerOrigin: () => 'https://happy.fixture.test',
        // The marker producer. Cases about it override this; everything else
        // is about what happens once a marker exists.
        writeMarker: async () => ({ status: 'adopted' as const }),
        readDeliveredMachineId: () => ({ status: 'ok' as const, machineId: 'machine-1' }),
        observeVolume: async () => ({ ok: false as const }),
        narrowDeliveredCredential: () => 'absent' as const,
        providerInstance: () => ({ providerMachineId: 'fly_m1', providerInstanceId: 'inst_1' }),
        ...over,
    };
    const start = deps.startSupervisor;
    deps.startSupervisor = async (input: Parameters<Parameters<typeof runManagedRuntimeBoot>[0]['startSupervisor']>[0]) => {
        input.ownership.registerRuntime({ stop: async () => ({ stopped: true }) });
        const taken = await input.ownership.take({ runtimeId: input.identity.runtimeId,
            manifestRoot: join(input.identity.stateDir, 'manifest'), cgroupRoot: input.identity.isolation.cgroupRoot });
        if (!taken.ok) throw new Error(taken.reason);
        return start(input);
    };
    return { deps: deps as Parameters<typeof runManagedRuntimeBoot>[0], log };
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'managed-boot-'));
    stateDir = join(base, 'state');
    mkdirSync(stateDir, { mode: 0o700, recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('the production ownership steps', () => {
    it('applies ownership to everything inside the provider home', async () => {
        /*
         * Run against a real tree with the test user's own ids — the only
         * ownership change an unprivileged process may make. What is under test
         * is the **walk**: a restore promotes this area as root, so the files
         * inside arrive owned by somebody else, and a step that touched only the
         * top level would leave the provider unable to read its own sessions.
         */
        const home = join(base, 'codex-home');
        mkdirSync(join(home, 'sessions'), { recursive: true });
        writeFileSync(join(home, 'sessions', 'state.db'), 'x');
        const visited: string[] = [];
        await defaultManagedRuntimeBootDeps((target) => { visited.push(target); })
            .assignProviderHome({ path: home, uid: 4242, gid: 4242, mode: 0o700 });
        // The mode belongs to the home itself; the ownership belongs to
        // everything the provider will read back.
        expect(lstatSync(home).mode & 0o777).toBe(0o700);
        expect(visited).toContain(join(home, 'sessions', 'state.db'));
    });

    it('reaches every file under the root, and follows no symlink out of it', () => {
        /*
         * The files a restore promotes arrive owned by root, so what matters is
         * that the walk **reaches** them. Symlinks are left alone rather than
         * followed: a link planted in a restored tree would otherwise hand the
         * provider something outside its own home.
         */
        const home = join(base, 'walk');
        mkdirSync(join(home, 'sessions', 'nested'), { recursive: true });
        writeFileSync(join(home, 'sessions', 'state.db'), 'x');
        writeFileSync(join(home, 'sessions', 'nested', 'deep.json'), 'y');
        symlinkSync(join(base, 'outside'), join(home, 'escape'));
        const visited: string[] = [];
        assignTreeSync(home, 4242, 4242, (target) => { visited.push(target); });
        expect(visited).toContain(join(home, 'sessions', 'state.db'));
        expect(visited).toContain(join(home, 'sessions', 'nested', 'deep.json'));
        expect(visited).not.toContain(join(home, 'escape'));
    });

    it('refuses a provider home reached through a symlink', async () => {
        const target = join(base, 'elsewhere');
        mkdirSync(target, { recursive: true });
        const link = join(base, 'linked-home');
        symlinkSync(target, link);
        await expect(defaultManagedRuntimeBootDeps().assignProviderHome({
            path: link, uid: 0, gid: 0, mode: 0o700,
        })).rejects.toThrow(/symlink/);
    });
});

describe('the root boot stage of a managed runtime', () => {
    it('makes the socket directory, starts the supervisor, then publishes it — in that order', async () => {
        const { deps, log } = bootDeps();
        const outcome = await runManagedRuntimeBoot(deps);

        expect(outcome).toEqual({
            ok: true, socketPath: managedLauncherSocketPath(stateDir), published: 'created',
            // Absent here: this fixture's volume cannot be observed, and an
            // observation that failed is absent rather than guessed.
            volume: null,
            // This fixture's `startSupervisor` starts no consumer, so there is
            // nothing for a shutdown to wait for — said as `null`, not omitted.
            checkpointTicks: null,
        });
        /*
         * `daemon-leaf` sits between the launcher directory and the supervisor:
         * root creates the daemon's own writable place before anything the daemon
         * could reach exists.
         */
        expect(log.map((entry) => entry.event))
            .toEqual(['directory', 'daemon-leaf', 'supervisor', 'workspace', 'provider-home', 'attestation']);
        // And the record the daemon will read is really there, readable through
        // the same trust rules the daemon applies.
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() })).toEqual({
            ok: true,
            binding: { socketPath: managedLauncherSocketPath(stateDir), token: TOKEN },
        });
    });

    it('carries the checkpoint consumer the supervisor started out of the boot', async () => {
        /*
         * The wait for a checkpoint in flight belongs to whoever owns this
         * process, not to the boot — so the handle has to leave the boot. A
         * consumer that stayed inside would tick fine and be abandoned
         * mid-upload on every stop, leaving an archive with no pointer at it.
         */
        const ticks = {
            start: () => {},
            tickNow: async () => ({ ticked: false }),
            stop: async () => ({ pendingPublication: false }),
        };
        const { deps } = bootDeps({
            startSupervisor: async () => ({ token: TOKEN, checkpointTicks: ticks, publishAttestation: () => 'published' as const }),
        });
        const outcome = await runManagedRuntimeBoot(deps);
        expect(outcome.ok).toBe(true);
        // The same object, not a copy of its shape.
        expect(outcome.ok && outcome.checkpointTicks).toBe(ticks);
    });

    it('refuses the boot when the daemon leaf is not what it must be, rather than correcting it', async () => {
        /*
         * 이미 있는 leaf 를 고치면 이 부팅이 쓰지 않은 상태를 바꾸는 것이고, 이
         * 부팅은 daemon 의 writer lock 을 들고 있지 않다 — 그 순간 daemon 이 그
         * 안에 쓰고 있을 수 있다. 그래서 거절이고, 거절이면 launcher 기록도
         * 남기지 않는다.
         */
        const { deps } = bootDeps({
            provisionDaemonStateLeaf: async () => ({ ok: false as const, detail: 'owner' }),
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'daemon-state-leaf-unusable' });
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() }))
            .toEqual({ ok: false, reason: 'absent' });
    });

    it('refuses the boot when the image states no daemon account', async () => {
        // 기본값을 주면 아무도 고르지 않은 uid 가 그 디렉터리를 소유한다.
        const { deps } = bootDeps({ resolveDaemonAccount: () => null });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'daemon-account-unusable' });
    });

    it('refuses the boot when the daemon account is one of the agent accounts', async () => {
        /*
         * marker 의 provider uid 와 같은 계정이면, 이 슬라이스가 만드는 leaf 는
         * provider 가 쓸 수 있는 곳이 된다 — 그 안에는 자기 세대가 계속 돌아도
         * 되는지를 결정하는 lease 가 있다. 기존 resolver 는 **실행** uid 만 보므로
         * 이것을 잡지 못한다.
         */
        const { deps } = bootDeps({
            resolveDaemonAccount: () => ({ uid: PROVIDER_UID, gid: 999 }),
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'daemon-account-unusable' });
    });

    it('publishes nothing when the supervisor does not start', async () => {
        // A record with nothing behind it is worse than no record: the daemon
        // reports a wired backend and every fencing answer is a transport error.
        const { deps } = bootDeps({ startSupervisor: async () => null });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'supervisor-unavailable' });
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() }))
            .toEqual({ ok: false, reason: 'absent' });
    });

    it('publishes nothing when the supervisor throws', async () => {
        const { deps } = bootDeps({
            startSupervisor: async () => { throw new Error('/state/launcher.sock: EADDRINUSE token=secret'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'supervisor-unavailable' });
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() }))
            .toEqual({ ok: false, reason: 'absent' });
    });

    it('gives the workspace to the executor and the provider home to the provider', async () => {
        /*
         * Two uids, two directories, and swapping them breaks a different thing
         * each way: the workspace under the provider uid makes every tool write
         * fail with EACCES, and the provider's home under the executor uid puts
         * the session's own state where the code the model chose can read it.
         */
        const { deps, log } = bootDeps();
        await runManagedRuntimeBoot(deps);
        expect(log.filter((entry) => entry.event === 'workspace')).toEqual([
            { event: 'workspace', detail: `/workspace/project:${AGENT_UID}:${AGENT_UID}` },
        ]);
        expect(log.filter((entry) => entry.event === 'provider-home')).toEqual([
            { event: 'provider-home', detail: `/workspace/.codex:${PROVIDER_UID}:${PROVIDER_UID}:700` },
        ]);
        /*
         * Exactly one thing under the state directory is handed to another
         * account: the daemon's own leaf. The receipts of the old layout, the
         * volume seal, the adopted credential and the launcher record stay root's,
         * and the launcher socket directory is *made* under it rather than handed
         * over.
         */
        const assignments = log.filter((entry) => entry.event !== 'directory');
        const underStateDir = assignments.filter((entry) => entry.detail?.startsWith(stateDir));
        expect(underStateDir).toEqual([
            { event: 'daemon-leaf', detail: `${join(stateDir, 'daemon')}:999:999:700` },
        ]);
    });

    it('assigns ownership after a restore, never before it', async () => {
        /*
         * A restore promotes by renaming a tree it built as root, so what it
         * promotes arrives root-owned. Ownership settled first would leave every
         * restored file unwritable by the executor — the runtime reports ready
         * and no tool can touch its own project.
         */
        const { deps, log } = bootDeps({
            restore: async () => { log.push({ event: 'restore' }); return 'restored' as const; },
        });
        await runManagedRuntimeBoot(deps);
        const events = log.map((entry) => entry.event);
        expect(events.indexOf('restore')).toBeLessThan(events.indexOf('workspace'));
        expect(events.indexOf('restore')).toBeLessThan(events.indexOf('provider-home'));
    });

    it('stops when a restore fails, without reporting the boot as done', async () => {
        // A half-laid tree with ownership applied over it looks like a prepared
        // volume. It is not one, and the parent must not be told it is.
        const { deps, log } = bootDeps({
            restore: async () => { throw new Error('promotion-failed'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'workspace-unassignable' });
        expect(log.some((entry) => entry.event === 'workspace')).toBe(false);
    });

    it('treats "no checkpoint to restore" as a start, not a failure', async () => {
        // A volume this operation created has nothing behind it. Reporting that
        // as a failed boot stops every new project from ever starting.
        const { deps } = bootDeps({ restore: async () => 'nothing-to-restore' as const });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });

    it('refuses to start when a crashed promotion left an unresolved tree', async () => {
        /*
         * The leftovers can be the **only** copy of what a destination held: a
         * rollback that did not finish is exactly why they are there. So this
         * neither sweeps them nor continues over them — a mixed tree served to
         * an agent is customer data quietly diverging from what was restored.
         */
        const { deps } = bootDeps({ inspectRestoreStaging: async () => 'unresolved' as const });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'restore-unresolved' });
    });

    it('treats an inspection that fails as unresolved, never as clear', async () => {
        const { deps } = bootDeps({
            inspectRestoreStaging: async () => { throw new Error('cannot read staging'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'restore-unresolved' });
    });

    it('starts when a recovery has proven the leftovers reclaimable', async () => {
        const { deps } = bootDeps({ inspectRestoreStaging: async () => 'clear' as const });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });

    it('hands the provider its whole home, not just the directory', async () => {
        /*
         * A restore promotes this area as root, so `sessions/` and the native
         * state database arrive root-owned. Owning only the top level lets the
         * provider write new files and read none of the ones it was given
         * back — which presents as an empty session, not as a permissions bug.
         */
        const { deps, log } = bootDeps();
        await runManagedRuntimeBoot(deps);
        const home = log.find((entry) => entry.event === 'provider-home');
        expect(home?.detail).toBe(`/workspace/.codex:${PROVIDER_UID}:${PROVIDER_UID}:700`);
    });

    it('stops when the provider home cannot be assigned', async () => {
        // codex writes its state there and dies without it. Reporting the boot
        // as done would hand the parent a runtime that cannot start a provider.
        const { deps } = bootDeps({
            assignProviderHome: async () => { throw new Error('EACCES'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'workspace-unassignable' });
    });

    it('does not start a supervisor for a marker it cannot trust, and says why', async () => {
        /*
         * "Boot anyway" here means running the agent unfenced, which is the
         * state this whole path exists to prevent.
         *
         * The refusal carries the identity's own classifier. Without it every
         * way a marker can be untrustworthy — not root owned, isolation
         * unverified, a tool policy the parent never approved — reaches the
         * operator as one word, and the one thing they need to know next is
         * exactly the part that was dropped. These are fixed codes, never paths
         * or values, so carrying them is safe.
         */
        const started = vi.fn();
        const { deps } = bootDeps({
            resolveIdentity: (() => ({
                status: 'refused', reason: 'isolation-unverified', detail: 'probe-uid-not-applied',
            })) as never,
            startSupervisor: started as never,
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({
            ok: false,
            reason: 'identity-inactive',
            detail: 'isolation-unverified: probe-uid-not-applied',
        });
        expect(started).not.toHaveBeenCalled();
    });

    it('reports the identity refusal even when it carries no detail', async () => {
        const { deps } = bootDeps({
            resolveIdentity: (() => ({ status: 'refused', reason: 'not-root-owned' })) as never,
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'identity-inactive', detail: 'not-root-owned' });
    });

    it('separates an ordinary machine from a broken managed one', async () => {
        // No marker is a BYOS machine with nothing to do here; it must not be
        // reported as a managed runtime that failed.
        const { deps } = bootDeps({ resolveIdentity: (() => ({ status: 'absent' })) as never });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'not-managed' });
    });

    it('stops when the trusted directory cannot be made', async () => {
        const started = vi.fn();
        const { deps } = bootDeps({
            makeTrustedDirectory: async () => { throw new Error('EROFS'); },
            startSupervisor: started as never,
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'trusted-directory-unavailable' });
        expect(started).not.toHaveBeenCalled();
    });

    it('brings the published token back to the supervisor on a restart', async () => {
        /*
         * The launcher record is write-once **and** the supervisor mints a fresh
         * token whenever it is not given one. A second boot that let it mint
         * again would publish a different token for the same socket, the record
         * would refuse it, and the runtime would never start again — a
         * permanent failure produced entirely by a restart.
         */
        const first = bootDeps();
        await runManagedRuntimeBoot(first.deps);
        const offered: Array<string | undefined> = [];
        const second = bootDeps({
            startSupervisor: async ({ token }) => {
                offered.push(token);
                // A supervisor handed a token uses it; only an unspecified one
                // is minted. This fixture mirrors that.
                return { token: token ?? 'a-freshly-minted-token', publishAttestation: () => 'published' as const };
            },
        });
        expect(await runManagedRuntimeBoot(second.deps)).toMatchObject({ ok: true });
        expect(offered).toEqual([TOKEN]);
    });

    it('adopts a record a previous boot already published', async () => {
        const first = bootDeps();
        await runManagedRuntimeBoot(first.deps);
        const second = bootDeps();
        expect(await runManagedRuntimeBoot(second.deps)).toMatchObject({ published: 'existing' });
    });

    it('refuses when a record names a different supervisor', async () => {
        await runManagedRuntimeBoot(bootDeps().deps);
        const { deps } = bootDeps({ startSupervisor: async () => ({ token: 'another-boots-token', publishAttestation: () => 'published' as const }) });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'binding-unpublishable' });
        // The first boot stays the authority: it owns the ledger and the
        // children, and the daemon must keep talking to it.
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() })).toMatchObject({
            ok: true, binding: { token: TOKEN },
        });
    });

    it('keeps the boot token out of the environment', async () => {
        const { deps } = bootDeps();
        await runManagedRuntimeBoot(deps);
        expect(Object.values(process.env).some((value) => value === TOKEN)).toBe(false);
    });
});

describe('the delivered credential\'s mode, before anything reads it', () => {
    /*
     * The provider writes the file and chooses its mode. Every read of it is
     * judged by a gate that refuses anything another uid can read — correctly —
     * so a `0644` delivery has to be narrowed before the *first* of those
     * reads. Narrowing before adoption was late: the machine id comes out of
     * the same file earlier, to write the marker, and that read hit the strict
     * gate and reported an unusable credential on an ordinary delivery.
     */
    it('narrows before the machine id is read', async () => {
        const order: string[] = [];
        const { deps } = bootDeps({
            narrowDeliveredCredential: () => { order.push('narrow'); return 'ok' as const; },
            readDeliveredMachineId: () => {
                order.push('read');
                return { status: 'ok' as const, machineId: 'machine-1' };
            },
        });
        await runManagedRuntimeBoot(deps);
        expect(order).toEqual(['narrow', 'read']);
    });

    it('refuses the boot when the mode cannot be narrowed', async () => {
        // A symlink where the file belongs, or a path this process may not
        // touch. Reading on would mean judging a file somebody else controls.
        const { deps, log } = bootDeps({
            narrowDeliveredCredential: () => 'refused' as const,
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'credential-unusable' });
        expect(log.some((entry) => entry.event === 'supervisor')).toBe(false);
    });

    it('boots on when there is nothing delivered to narrow', async () => {
        const { deps } = bootDeps({ narrowDeliveredCredential: () => 'absent' as const });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });
});

describe('what this boot observed about its volume', () => {
    /*
     * The filesystem uuid is an observation of this machine's mounts. The
     * marker is the parent's description of what it attached — a different
     * kind of statement, and the one thing that must not stand in for the
     * other: a checkpoint bound to a described uuid is a checkpoint bound to
     * whatever the description happened to say.
     */
    it('carries the sealed observation out of the boot', async () => {
        const { deps } = bootDeps({
            observeVolume: async () => ({
                ok: true as const,
                binding: { providerVolumeId: 'vol_1', deviceMajorMinor: '259:1', fsUuid: 'fs-uuid-1' },
            }),
        });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({
            ok: true,
            volume: { providerVolumeId: 'vol_1', deviceMajorMinor: '259:1', fsUuid: 'fs-uuid-1' },
        });
    });

    it('hands the supervisor a volume reference that answers after the observation', async () => {
        /*
         * A **function**, not a value.
         *
         * The supervisor is started before the volume is observed — it has to
         * be, because observing it is not what makes a runtime ready — so a
         * value read at that moment would be the one from before anybody
         * looked, and a checkpoint bound to it would be bound to nothing that
         * was confirmed. Asked later, it answers what the kernel said.
         */
        let observed: (() => { volumeId: string; deviceUuid: string } | null) | null = null;
        const { deps } = bootDeps({
            startSupervisor: async ({ observedVolume }) => {
                observed = observedVolume;
                // 이 시점에는 아직 아무도 보지 않았다.
                expect(observedVolume()).toBeNull();
                return { token: 'launcher-token', publishAttestation: () => 'published' as const };
            },
            observeVolume: async () => ({
                ok: true as const,
                binding: { providerVolumeId: 'vol_9', deviceMajorMinor: '259:3', fsUuid: 'fs-uuid-9' },
            }),
        });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
        expect(observed).not.toBeNull();
        expect((observed as unknown as () => unknown)())
            .toEqual({ volumeId: 'vol_9', deviceUuid: 'fs-uuid-9' });
    });

    it('leaves the volume reference answering null when nothing was observed', async () => {
        // 관측되지 않은 볼륨은 차단이지 추측이 아니다 — coordinator 가
        // `volume-unobserved` 로 접는다.
        let observed: (() => unknown) | null = null;
        const { deps } = bootDeps({
            startSupervisor: async ({ observedVolume }) => {
                observed = observedVolume;
                return { token: 'launcher-token', publishAttestation: () => 'published' as const };
            },
            observeVolume: async () => ({ ok: false as const }),
        });
        await runManagedRuntimeBoot(deps);
        expect((observed as unknown as () => unknown)()).toBeNull();
    });

    it('reports no observation rather than a guess when it could not be sealed', async () => {
        const { deps } = bootDeps({ observeVolume: async () => ({ ok: false as const }) });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true, volume: null });
    });

    it('reports no observation when observing threw, and still boots', async () => {
        // An observation that failed is an absent observation. It is not a
        // reason to refuse a runtime that is otherwise ready, and it is not a
        // reason to invent a uuid.
        const { deps } = bootDeps({
            observeVolume: async () => { throw new Error('mountinfo unreadable'); },
        });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true, volume: null });
    });
});

describe('producing the marker the rest of the boot reads', () => {
    /*
     * Nothing else writes it. Without this the first boot of every machine
     * reads an absent marker, concludes BYOS and does nothing — the runtime the
     * parent just created never becomes one, and no line anywhere says why.
     */
    it('writes it before the identity is read', async () => {
        const order: string[] = [];
        const { deps } = bootDeps({
            writeMarker: async () => { order.push('marker'); return { status: 'written' as const }; },
            resolveIdentity: (() => {
                order.push('identity');
                return identity();
            }) as never,
        });
        await runManagedRuntimeBoot(deps);
        expect(order).toEqual(['marker', 'identity']);
    });

    it('names the Machine the delivered credential was minted for, and the instance the platform reported', async () => {
        /*
         * The ordering has no way around it: the marker records which Machine
         * this is, and on a first boot there is nothing else on the disk that
         * knows. The credential does — it was minted for that Machine and no
         * other — so that one field is read before the marker exists, and
         * adoption still compares against the marker afterwards.
         */
        const seen: unknown[] = [];
        const { deps } = bootDeps({
            writeMarker: async (input: unknown) => { seen.push(input); return { status: 'written' as const }; },
            readDeliveredMachineId: () => ({ status: 'ok' as const, machineId: 'machine-1' }),
            providerInstance: () => ({ providerMachineId: 'fly_m9', providerInstanceId: 'inst_9' }),
        });
        await runManagedRuntimeBoot(deps);
        expect(seen).toEqual([{
            happyMachineId: 'machine-1',
            instance: { providerMachineId: 'fly_m9', providerInstanceId: 'inst_9' },
        }]);
    });

    it('writes no marker when the parent delivered nothing', async () => {
        // A machine with no credential file is either BYOS or a parent that has
        // not delivered yet. Inventing a Machine id to write a marker with
        // would make this runtime claim an identity nobody issued.
        const seen: unknown[] = [];
        const { deps } = bootDeps({
            writeMarker: async (input: unknown) => { seen.push(input); return { status: 'written' as const }; },
            readDeliveredMachineId: () => ({ status: 'absent' as const }),
        });
        await runManagedRuntimeBoot(deps);
        expect(seen).toEqual([]);
    });

    it('refuses the boot when the delivered file is there and unreadable', async () => {
        const { deps, log } = bootDeps({
            readDeliveredMachineId: () => ({ status: 'refused' as const }),
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'credential-unusable' });
        expect(log.some((entry) => entry.event === 'supervisor')).toBe(false);
    });

    it('refuses without a detail when the writer gave none', async () => {
        const { deps } = bootDeps({
            readDeliveredMachineId: () => ({ status: 'ok' as const, machineId: 'machine-1' }),
            writeMarker: async () => ({ status: 'refused' as const }),
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'marker-unwritable' });
    });

    it('refuses the boot when the marker cannot be written, with its own reason', async () => {
        /*
         * A marker that could not be produced is a runtime with no identity,
         * and continuing would mean starting a supervisor for nobody.
         *
         * Its own reason, not the one the identity check uses: "could not write
         * the marker" and "wrote it and then would not trust it" are different
         * machines to look at, and one word for both means the operator cannot
         * tell which happened — which is exactly what stalled the first real
         * boot.
         */
        const { deps, log } = bootDeps({
            readDeliveredMachineId: () => ({ status: 'ok' as const, machineId: 'machine-1' }),
            writeMarker: async () => ({ status: 'refused' as const, reason: 'instance-unidentified' }),
        });
        /*
         * The writer's own code travels. It has eleven of them — an untrusted
         * path, an absent boot input, a marker that could not be written, an
         * instance it could not identify — and folding all eleven into one word
         * sent a real boot's diagnosis down the wrong path twice. They are
         * fixed classifiers, like the identity's.
         */
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'marker-unwritable', detail: 'instance-unidentified' });
        expect(log.some((entry) => entry.event === 'supervisor')).toBe(false);
    });
});

describe('the identity handoff, in the boot stage', () => {
    /*
     * `run.ts` refuses to start managed without a credential on the volume, and
     * nothing inside a guest can mint one — both control-plane routes that
     * issue them require a signature no process here holds. So the boot stage
     * is where the parent's delivery becomes this runtime's own, and it happens
     * before a supervisor exists: a credential this runtime may not run as
     * should stop the boot while stopping is still cheap.
     */
    it('adopts before it starts anything', async () => {
        const order: string[] = [];
        const { deps } = bootDeps({
            adoptCredential: async () => {
                order.push('adopt');
                return { status: 'adopted' as const, machineId: 'machine-1', expiresAt: 1 };
            },
            startSupervisor: async () => {
                order.push('supervisor');
                return { token: TOKEN, publishAttestation: () => 'published' as const };
            },
        });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
        expect(order).toEqual(['adopt', 'supervisor']);
    });

    it('refuses the boot when the delivered identity is not one to run as', async () => {
        const { deps, log } = bootDeps({
            adoptCredential: async () => ({ status: 'refused' as const, reason: 'machine-conflict' as const }),
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'credential-unusable' });
        // Nothing started, nothing published: the refusal is inert.
        expect(log.some((entry) => entry.event === 'supervisor')).toBe(false);
    });

    it('treats an adoption that throws as a refusal, never as absence', async () => {
        const { deps } = bootDeps({
            adoptCredential: async () => { throw new Error('cannot read /etc/saycode'); },
        });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'credential-unusable' });
    });

    it('boots on when nothing was delivered', async () => {
        /*
         * A parent that has not wired the delivery yet, and a machine whose
         * credential is already on its volume, are the same thing here. What
         * happens next is the daemon's decision, made where the state directory
         * is actually read.
         */
        const { deps } = bootDeps({ adoptCredential: async () => ({ status: 'absent' as const }) });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });

    it('boots on when the credential already there is the better one', async () => {
        const { deps } = bootDeps({
            adoptCredential: async () => ({
                status: 'current' as const, machineId: 'machine-1', expiresAt: 2,
            }),
        });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: true });
    });

    it('is wired on the deps the CLI builds', () => {
        // The lesson from the staging guard: an optional hook is one the single
        // non-test caller forgets, and its absence is silent.
        expect(typeof defaultManagedRuntimeBootDeps().adoptCredential).toBe('function');
    });
});

describe('the staging check the real CLI actually runs', () => {
    /*
     * `main.ts` boots with `defaultManagedRuntimeBootDeps()` and nothing else.
     * The guard was optional and those deps did not supply one, so in the only
     * configuration that ships, the check never ran: a runtime with leftovers
     * from a crashed promotion booted and served work over them. These cases
     * are about **that** object, not an injected stand-in.
     */
    let staging: string;

    beforeEach(() => {
        staging = join(base, 'restore-staging');
    });

    const inspect = () =>
        defaultManagedRuntimeBootDeps(() => {}, staging).inspectRestoreStaging();

    it('is present on the deps the CLI builds', () => {
        expect(typeof defaultManagedRuntimeBootDeps().inspectRestoreStaging).toBe('function');
    });

    it('calls a staging area that was never created clear', async () => {
        // Nothing staged is the ordinary case, and it must not stop a boot.
        expect(await inspect()).toBe('clear');
    });

    it('calls an empty staging directory clear', async () => {
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        expect(await inspect()).toBe('clear');
    });

    it.each([
        ['a displaced tree', 'displaced-20260910-abcdef'],
        ['a promotion journal', 'journal.json'],
        ['a checkpoint work directory', '.managed-checkpoint-4f2a'],
        ['something this code has never heard of', 'whatever-this-is'],
    ])('refuses to boot over %s, and leaves it exactly where it is', async (_name, entry) => {
        /*
         * Not `displaced-*` only. A rule that recognises names answers "clear"
         * for precisely the leftovers nobody anticipated — which are the ones
         * worth stopping for.
         */
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        const path = join(staging, entry);
        writeFileSync(path, 'the only copy of something', { mode: 0o600 });
        expect(await inspect()).toBe('unresolved');
        // Never swept: this can be the only copy of a destination's previous
        // contents, and the rollback that would have restored it is the step
        // that did not finish.
        expect(readFileSync(path, 'utf8')).toBe('the only copy of something');
    });

    it('refuses a staging root that is a symlink rather than following it', async () => {
        // Following it would let whoever placed the link decide which directory
        // answers the question.
        const elsewhere = join(base, 'elsewhere');
        mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
        symlinkSync(elsewhere, staging);
        expect(await inspect()).toBe('unresolved');
    });

    it('refuses a staging root that is not a directory', async () => {
        writeFileSync(staging, 'not a directory', { mode: 0o600 });
        expect(await inspect()).toBe('unresolved');
    });

    it('refuses when it cannot read the staging root at all', async () => {
        // Being unable to look is not evidence that there is nothing there.
        if ((process.getuid?.() ?? 0) === 0) return; // root reads it regardless
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        writeFileSync(join(staging, 'displaced-1'), 'x', { mode: 0o600 });
        chmodSync(staging, 0o000);
        try {
            expect(await inspect()).toBe('unresolved');
        } finally {
            chmodSync(staging, 0o700);
        }
    });
});

describe('which Happy the runtime may talk to', () => {
    it('refuses to start when the stored credential names no origin', async () => {
        /*
         * 그 값을 못 읽었다는 것은 이 runtime 이 자기 bearer 를 어디에 내밀어도
         * 되는지 모른다는 뜻이다. 프로세스 기본값으로 떨어지면 승인되지 않은
         * 서버에 자격을 내밀게 된다 — 시작하지 않는 편이 낫다.
         */
        const { deps } = bootDeps({ readTrustedServerOrigin: () => null });
        expect(await runManagedRuntimeBoot(deps))
            .toEqual({ ok: false, reason: 'credential-unusable' });
    });

    it('hands the stored origin to the supervisor, which is what reaches the child', async () => {
        /*
         * 읽어 놓고 내려보내지 않으면 자식 환경은 여전히 프로세스 기본값을 본다.
         * 그 값이 `HAPPY_SERVER_URL` 로 매핑되는 자리(launcher)는 별도지만,
         * 여기서 넘기지 않으면 그 매핑이 받을 것이 없다.
         */
        const seen: (string | undefined)[] = [];
        const { deps } = bootDeps({
            readTrustedServerOrigin: () => 'https://happy.stored.test',
            startSupervisor: async (input) => {
                seen.push(input.serverOrigin);
                return { token: TOKEN, publishAttestation: () => 'published' as const };
            },
        });
        await runManagedRuntimeBoot(deps);
        expect(seen).toEqual(['https://happy.stored.test']);
    });

    it('reads the origin from the stored credential, not from the delivered envelope', async () => {
        /*
         * 봉투는 boot input 이 주장한 값이다. 그것으로 검사하면 검사가 자기
         * 자신을 비교하게 된다. 저장본은 adoption 이 받아들인 것이고 marker 의
         * machine id 와 대조된 뒤에만 그 자리에 있다.
         */
        const asked: { stateDir: string; expectedMachineId: string }[] = [];
        const { deps } = bootDeps({
            readTrustedServerOrigin: (input) => {
                asked.push({
                    stateDir: input.stateDir, expectedMachineId: input.expectedMachineId,
                });
                return 'https://happy.fixture.test';
            },
        });
        await runManagedRuntimeBoot(deps);
        expect(asked).toHaveLength(1);
        // marker 가 말한 machine 의, 그 runtime 의 state 디렉터리에서 읽는다.
        expect(asked[0].expectedMachineId).toBe('machine-1');
        expect(asked[0].stateDir).toBe(stateDir);
    });
});

describe('the boot publishes the supervisor attestation, last and with no arguments', () => {
    /*
     * The record is the supervisor's own statement that it is the instance
     * listening on this socket for this marker. It is written **after every
     * gate that can still fail**, because a record published by a boot that
     * then refuses would name a supervisor nobody is meant to reach.
     */
    it('shouldCallTheBoundPublisherWithNoArgumentsAfterEveryGate', async () => {
        const calls: unknown[][] = [];
        const { deps, log } = bootDeps({
            startSupervisor: async () => ({
                token: TOKEN,
                publishAttestation: (...args: unknown[]) => {
                    calls.push(args);
                    log.push({ event: 'attestation' });
                    return 'published' as const;
                },
            }),
        });
        const result = await runManagedRuntimeBoot(deps as never);
        expect(result).toMatchObject({ ok: true });
        expect(calls).toEqual([[]]);
        // Last: every observation the boot can refuse on has already happened.
        const events = log.map((entry) => entry.event);
        expect(events.at(-1)).toBe('attestation');
    });

    it('shouldCarryTheSameReadMarkerDigestToTheSupervisor', async () => {
        // The digest of the bytes the marker was parsed from, handed down
        // rather than re-derived: a second read could see different bytes.
        let seen: string | undefined;
        const { deps } = bootDeps({
            startSupervisor: async (input: { markerSha256: string }) => {
                seen = input.markerSha256;
                return { token: TOKEN, publishAttestation: () => 'published' as const };
            },
        });
        await runManagedRuntimeBoot(deps as never);
        expect(seen).toBe(MARKER_SHA256);
    });

    it.each([
        ['refused-not-current'],
        ['refused-no-scope'],
        ['refused-write:untrusted'],
        ['refused-write:schema'],
        ['refused-write:too-large'],
        ['refused-write:temporary-exists'],
        ['refused-write:staged'],
        ['refused-write:promote'],
        ['refused-write:durability-unknown'],
    ] as const)('shouldFailTheBootWhenPublicationAnswers %s', async (outcome) => {
        /*
         * Every refusal in the publisher's union, including the two that leave
         * something on disk: `promote` keeps the previous file and
         * `durability-unknown` has already made the new one visible. The boot
         * fails in both and **rolls nothing back** - pretending to undo a
         * rename whose bytes are already gone is worse than saying so.
         */
        const { deps } = bootDeps({
            startSupervisor: async () => ({
                token: TOKEN,
                publishAttestation: () => outcome,
            }),
        });
        expect(await runManagedRuntimeBoot(deps as never))
            .toEqual({ ok: false, reason: 'attestation-unpublishable' });
    });

    it('shouldNotPublishWhenAnEarlierGateAlreadyRefused', async () => {
        // Staging that is not clear refuses before the publisher is reached.
        let published = 0;
        const { deps } = bootDeps({
            inspectRestoreStaging: async () => 'dirty' as never,
            startSupervisor: async () => ({
                token: TOKEN,
                publishAttestation: () => { published += 1; return 'published' as const; },
            }),
        });
        expect(await runManagedRuntimeBoot(deps as never)).toMatchObject({ ok: false });
        expect(published).toBe(0);
    });
    it.each(['supervisor', 'restore', 'workspace', 'provider-home', 'staging'] as const)(
        'shouldNotInvokePublicationAfterThe%sGateRefuses', async (gate) => {
            let publications = 0;
            const over: Partial<Parameters<typeof runManagedRuntimeBoot>[0]> = {
                startSupervisor: async () => ({ token: TOKEN, publishAttestation: () => { publications += 1; return 'published'; } }),
            };
            if (gate === 'supervisor') over.startSupervisor = async () => null;
            if (gate === 'restore') over.restore = async () => { throw new Error('restore failed'); };
            if (gate === 'workspace') over.assignWorkspace = async () => { throw new Error('assignment failed'); };
            if (gate === 'provider-home') over.assignProviderHome = async () => { throw new Error('assignment failed'); };
            if (gate === 'staging') over.inspectRestoreStaging = async () => 'unresolved';
            const { deps } = bootDeps(over);
            expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: false });
            expect(publications).toBe(0);
        },
    );

    it('shouldNotPublishWhenTheStableBindingRefusesAnotherToken', async () => {
        expect(await runManagedRuntimeBoot(bootDeps().deps)).toMatchObject({ ok: true });
        let publications = 0;
        const { deps } = bootDeps({ startSupervisor: async () => ({
            token: 'different-token',
            publishAttestation: () => { publications += 1; return 'published'; },
        }) });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'binding-unpublishable' });
        expect(publications).toBe(0);
        expect(readManagedLauncherBinding({ stateDir, deps: provisioning() })).toMatchObject({ ok: true, binding: { token: TOKEN } });
    });

});


describe('boot owns credential adoption and transfers ownership once', () => {
    it('refuses a conflicting owner before adopting credentials', async () => {
        const adopt = vi.fn(async () => ({ status: 'absent' as const }));
        const { deps } = bootDeps({ acquireOwnership: async () => ({ ok: false, reason: 'already-held' }), adoptCredential: adopt });
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: false, reason: 'supervisor-unavailable' });
        expect(adopt).not.toHaveBeenCalled();
    });
    it('releases unconsumed ownership on a pre-start refusal and reports a failed release', async () => {
        const release = vi.fn(async () => { throw new Error('secret'); });
        const { deps } = bootDeps({
            acquireOwnership: async (scope) => ({ ok: true, ownership: { scope, address: supervisorLockAddress(scope), release } }),
            adoptCredential: async () => ({ status: 'refused', reason: 'unwritable' }),
        });
        expect(await runManagedRuntimeBoot(deps)).toEqual({ ok: false, reason: 'supervisor-unavailable', detail: 'ownership-release-failed' });
        expect(release).toHaveBeenCalledOnce();
    });
    it('requires registration, compares configured and physical scope, and refuses duplicate take', async () => {
        const release = vi.fn(async () => {}); const stop = vi.fn(async () => ({ stopped: true as const }));
        const { deps } = bootDeps({ acquireOwnership: async (scope) => ({ ok: true, ownership: { scope, address: supervisorLockAddress(scope), release } }) });
        const outcomes: unknown[] = [];
        deps.startSupervisor = async (input) => {
            const scope = { runtimeId: input.identity.runtimeId, manifestRoot: join(stateDir, 'manifest'), cgroupRoot: input.identity.isolation.cgroupRoot };
            outcomes.push(await input.ownership.take(scope));
            input.ownership.registerRuntime({ stop });
            outcomes.push(await input.ownership.take({ ...scope, runtimeId: 'different' }));
            outcomes.push(await input.ownership.take(scope));
            outcomes.push(await input.ownership.take(scope));
            throw new Error('after-take');
        };
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: false, reason: 'supervisor-unavailable' });
        expect(outcomes).toEqual([
            { ok: false, reason: 'ownership-runtime-unregistered' },
            { ok: false, reason: 'ownership-scope-mismatch' },
            { ok: true, release },
            { ok: false, reason: 'ownership-already-taken' },
        ]);
        expect(stop).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled();
    });
    it('refuses a changed physical address without taking or stopping an unowned runtime', async () => {
        const release = vi.fn(async () => {}); const stop = vi.fn(async () => ({ stopped: true as const }));
        const { deps } = bootDeps({ acquireOwnership: async (scope) => ({ ok: true, ownership: { scope, address: 'different-bound-address', release } }) });
        let takeOutcome: unknown;
        deps.startSupervisor = async (input) => {
            input.ownership.registerRuntime({ stop });
            takeOutcome = await input.ownership.take({ runtimeId: input.identity.runtimeId, manifestRoot: join(stateDir, 'manifest'), cgroupRoot: input.identity.isolation.cgroupRoot });
            return null;
        };
        expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: false });
        expect(takeOutcome).toEqual({ ok: false, reason: 'ownership-scope-mismatch' });
        expect(stop).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    });
    it.each(['true', 'false', 'throw', 'listen-failure'] as const)('actual checkpoint helper and production factory leave outer boot as the one cleanup owner (%s)', async (mode) => {
        // Materialize the fixture manifest before measuring its physical address (/tmp is a symlink on macOS).
        mkdirSync(join(stateDir, 'manifest'), { recursive: true });
        const release = vi.fn(async () => {});
        const { deps } = bootDeps({ acquireOwnership: async (scope) => ({ ok: true, ownership: { scope, address: supervisorLockAddress(scope), release } }) });
        const admitted = identity()();
        if (admitted.status !== 'active') throw new Error('fixture admission');
        admitted.identity.checkpoint = { drainBudgetMs: 1000 };
        admitted.identity.checkpointSchedule = { periodMs: 1000, onTurnBoundary: true };
        admitted.identity.tenant = 'company:fixture';
        deps.resolveIdentity = () => admitted;
        const realComposition = managedRunConfig.defaultManagedRunConfig;
        const compositionSpy = vi.spyOn(managedRunConfig, 'defaultManagedRunConfig').mockImplementation((input) => realComposition({
            ...input, checkpoint: { ...input.checkpoint, image: { imageVersion: 'fixture' }, workDir: join(base, 'checkpoint-work') },
        }));
        const create = launcherMain.createSupervisorRuntime;
        let originalStop: ReturnType<typeof launcherMain.createSupervisorRuntime>['stop'] | undefined;
        const stops = vi.fn(async () => {
            if (mode === 'throw') throw new Error('cleanup failed');
            if (mode === 'false') return { stopped: false as const, open: [], unreadable: 0 };
            return await originalStop!();
        });
        let startFailure: unknown;
        const gateReached = vi.fn();
        const runtimeSpy = vi.spyOn(launcherMain, 'createSupervisorRuntime').mockImplementation((options) => {
            // A directory cannot be unlinked as a stale socket: actual IPC listen must reject.
            if (mode === 'listen-failure') mkdirSync(options.socketPath);
            const runtime = create(options);
            originalStop = runtime.stop.bind(runtime);
            const originalStart = runtime.start.bind(runtime);
            vi.spyOn(runtime, 'start').mockImplementation(async () => {
                try { await originalStart(); } catch (error) { startFailure = error; throw error; }
            });
            vi.spyOn(runtime, 'providerQuiescence').mockImplementation(() => { gateReached(); throw new Error('prerequisite'); });
            vi.spyOn(runtime, 'stop').mockImplementation(stops);
            return runtime;
        });
        deps.startSupervisor = defaultManagedRuntimeBootDeps().startSupervisor;
        try {
            const outcome = await runManagedRuntimeBoot(deps);
            if (mode === 'listen-failure') {
                expect(startFailure).toMatchObject({ code: 'EADDRINUSE' });
                expect(gateReached).not.toHaveBeenCalled();
            } else {
                expect(startFailure).toBeUndefined();
                expect(gateReached).toHaveBeenCalledOnce();
            }
            expect(runtimeSpy).toHaveBeenCalledOnce();
            expect(stops).toHaveBeenCalledOnce();
            expect(outcome).toMatchObject({ ok: false, reason: 'supervisor-unavailable',
                ...(['true', 'listen-failure'].includes(mode) ? {} : { detail: 'supervisor-stop-unproven' }) });
            expect(release).toHaveBeenCalledTimes(['true', 'listen-failure'].includes(mode) ? 1 : 0);
        } finally {
            // Fixture cleanup after assertions; not counted as product stop evidence.
            if (originalStop) await originalStop();
            runtimeSpy.mockRestore(); compositionSpy.mockRestore();
        }
    });
});


describe('production boot captures its checkpoint loop for runtime stop', () => {
    it.each([false, true])('accounts for the actual loop or pre-arm failure (armed=%s)', async scheduled => {
        mkdirSync(join(stateDir, 'manifest'), { recursive: true });
        const release = vi.fn(async () => {});
        const { deps } = bootDeps({ acquireOwnership: async scope => ({ ok: true, ownership: { scope, address: supervisorLockAddress(scope), release } }) });
        const admitted = identity()();
        if (admitted.status !== 'active') throw new Error('fixture admission');
        admitted.identity.checkpoint = { drainBudgetMs: 1000 };
        admitted.identity.checkpointSchedule = { periodMs: 60_000, onTurnBoundary: true };
        admitted.identity.tenant = 'company:fixture';
        deps.resolveIdentity = () => admitted;
        deps.assignWorkspace = async () => { throw new Error('late boot refusal'); };
        const compose = managedRunConfig.defaultManagedRunConfig;
        const compositionSpy = vi.spyOn(managedRunConfig, 'defaultManagedRunConfig').mockImplementation(input => compose({
            ...input, checkpoint: { ...input.checkpoint, image: { imageVersion: 'fixture' }, workDir: join(base, 'checkpoint-work') },
        }));
        const makeCheckpointing = runtimeCheckpointing.createManagedRuntimeCheckpointing;
        const captured: { loop: ManagedCheckpointTickLoop | null } = { loop: null };
        let loopStop: ReturnType<typeof vi.spyOn> | undefined;
        const checkpointingSpy = vi.spyOn(runtimeCheckpointing, 'createManagedRuntimeCheckpointing').mockImplementation(config => {
            const checkpointing = makeCheckpointing(config);
            const start = checkpointing.startAfterSupervisor;
            checkpointing.startAfterSupervisor = async input => {
                captured.loop = await start(input); // Actual helper/loop, only observe the returned instance.
                if (captured.loop) loopStop = vi.spyOn(captured.loop, 'stop');
                return captured.loop;
            };
            return checkpointing;
        });
        const create = launcherMain.createSupervisorRuntime;
        let runtime: ReturnType<typeof create> | undefined;
        let suppliedStop: launcherMain.SupervisorRuntimeOptions['stopCheckpointWork'];
        const runtimeSpy = vi.spyOn(launcherMain, 'createSupervisorRuntime').mockImplementation(options => {
            suppliedStop = options.stopCheckpointWork;
            runtime = create(options);
            if (!scheduled) vi.spyOn(runtime, 'providerQuiescence').mockImplementation(() => { throw new Error('pre-arm prerequisite'); });
            return runtime;
        });
        deps.startSupervisor = defaultManagedRuntimeBootDeps().startSupervisor;
        try {
            expect(await runManagedRuntimeBoot(deps)).toMatchObject({ ok: false, reason: scheduled ? 'workspace-unassignable' : 'supervisor-unavailable' });
            expect(typeof suppliedStop).toBe('function');
            expect(release).toHaveBeenCalledOnce();
            if (scheduled) {
                expect(captured.loop).not.toBeNull();
                expect(loopStop).toHaveBeenCalledOnce();
                expect(await captured.loop!.tickNow('periodic')).toEqual({ ticked: false });
            } else {
                expect(captured.loop).toBeNull();
                expect(await suppliedStop!()).toEqual({ pendingPublication: false });
            }
        } finally {
            await captured.loop?.stop(); await runtime?.stop();
            runtimeSpy.mockRestore(); checkpointingSpy.mockRestore(); compositionSpy.mockRestore();
        }
    });
});

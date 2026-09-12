/**
 * What a managed runtime launches its generations with.
 *
 * The boot path calls this and passes the result to `createSupervisorRuntime`.
 * It lives here rather than there because every value in it is an isolation
 * decision — which helper, which program, which tools, which cgroup — and a
 * second place naming them is a second place they can drift. The boot side
 * supplies only what it actually knows: the marker's identity, the runtime's
 * configured execution policy, and where unproven termination is reported.
 *
 * ## The two helpers are not interchangeable
 *
 * `executorHelper` enters a per-call PID/mount/network namespace and runs one
 * tool as the executor uid. `execHelper` does not enter any namespace and runs
 * the provider generation as the provider uid. Handing either one the other's
 * job silently changes what the agent is isolated from, so they are separate
 * fields with separate paths.
 *
 * ## The grant cannot outlive the right to write
 *
 * `ttlMs` is the tool grant's lifetime, and it is clamped to what is left of
 * the lease. A grant that outlives the lease is a run whose tools still work
 * after it has lost permission to touch the volume — so the lease is the
 * authority and the configured value can only shorten it, never extend it.
 *
 * Nothing here invents a policy value. `toolTimeoutMs` and the unclamped
 * `ttlMs` are validated boot inputs; a runtime that was not given them does
 * not start rather than run on a number this file made up.
 */
import { closeSync, fchmodSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

import { applyManagedGatewayEnvironment } from '@/managed/managedStartup';
import {
    MANAGED_BOOTSTRAP_CHILD_FD,
    MANAGED_BOOTSTRAP_FD_ENV,
    type ManagedSpawnEnvelope,
} from '@/managed/managedSpawnBootstrap';
import {
    MANAGED_REPORT_CHILD_FD,
    MANAGED_REPORT_FD_ENV,
} from '@/daemon/launch/managedReportCredential';
import type { ManagedRuntimeIdentity } from '@/daemon/managedRuntimeIdentity';

import { generationCgroupPath } from './supervisor';
import { TRUSTED_PROVIDER_EXEC_PATH, TRUSTED_TOOL_WORKLOAD_PATH } from './managedProviderRun';
import { MANAGED_CODING_TOOLS, MANAGED_WRITE_TOOLS } from './managedToolCatalogue';
import {
    createManagedCheckpointSession,
    managedCheckpointAreas,
    type ManagedCheckpointSession,
} from '@/managed/checkpoint/managedCheckpointSession';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';
import type { ManagedCheckpointTargetSource } from '@/managed/checkpoint/managedCheckpointCoordinator';
import type { CheckpointSchedulePolicy } from '@/managed/checkpoint/managedCheckpointSchedule';
import type { CheckpointAreaSource } from '@/managed/checkpoint/managedCheckpointArchive';
import type { CheckpointFlushDeps } from '@/managed/checkpoint/managedCheckpointFlush';
import type { CheckpointFetch } from '@/managed/checkpoint/managedCheckpointObjectStore';
import type { ProviderQuiescenceGate } from '@/managed/checkpoint/managedProviderQuiescence';
import type { ManagedGenerationLaunchConfig } from './managedGenerationLaunch';

/**
 * The provider's own state directory, for codex.
 *
 * Beside the workspace, never inside it: the executor owns the workspace tree
 * and this is the provider's. The boot path already creates it with the
 * provider uid (`assignProviderHome`) and the checkpoint scope already knows
 * `.codex/auth.json` is a credential — so this is that same directory, not a
 * new one. It is named again rather than imported because `managedRuntimeBoot`
 * imports the launcher's own entry, and importing it back here is a cycle;
 * `managedCodexHomeAgrees` in the tests is what keeps them the same path.
 */
export const MANAGED_GENERATION_CODEX_HOME = '/workspace/.codex';

/** Where the image installs the two trusted helpers. */
/**
 * Where the image records the version it was built as.
 *
 * Named here rather than imported from `managedImagePackaging`, for the reason
 * that module's own consumers already carry: it belongs to the image's runtime
 * entry, which is bundled into **one** read-only CommonJS file. A module shared
 * with the launcher's graph makes the bundler emit a sibling chunk, and the
 * image installs one file — so the file it installs fails to load. That is not
 * hypothetical; it failed the image build's layout check, which is the third
 * time this package has paid for the shared import.
 *
 * `managedImagePathsAgree` in `managedRunConfig.test.ts` is what keeps the two
 * copies from drifting.
 */
export const MANAGED_IMAGE_VERSION_FILE = '/usr/local/lib/saycode/image-version';

export const MANAGED_TOOL_HELPER_PATH = '/usr/local/lib/saycode/executor-helper';
export const MANAGED_PROVIDER_HELPER_PATH = '/usr/local/lib/saycode/exec-helper';

/**
 * Execution controls a runtime must be configured with.
 *
 * Not defaulted. These bound how long a tool may run and how long its grant
 * lives, and a wrong guess here is either a run that cannot work or a grant
 * that outlives its reason to exist.
 */
export type ManagedRunPolicy = {
    /** Tool grant lifetime, before the lease clamp. */
    ttlMs: number;
    /** How long one tool call may run. */
    toolTimeoutMs: number;
};

export function assertManagedRunPolicy(policy: ManagedRunPolicy): void {
    if (!Number.isSafeInteger(policy.ttlMs) || policy.ttlMs <= 0) {
        throw new Error('managed run policy requires a positive ttlMs');
    }
    if (!Number.isSafeInteger(policy.toolTimeoutMs) || policy.toolTimeoutMs <= 0) {
        throw new Error('managed run policy requires a positive toolTimeoutMs');
    }
}

/**
 * The provider's environment for one run, built from its verified envelope.
 *
 * `applyManagedGatewayEnvironment` is the product's own mapping: it clears
 * every inherited provider credential first — an inherited key is not a
 * fallback, it is a way to run outside the approval — and then sets only the
 * gateway this run was approved and priced for.
 *
 * The confirmed-delivery flag rides here too. It is what makes the child treat
 * its initial prompt as delivered only once acknowledged, and the provider
 * plan is the only channel that reaches this generation's environment.
 */
export function managedProviderEnvironment(envelope: ManagedSpawnEnvelope): Record<string, string> {
    const env: NodeJS.ProcessEnv = {};
    applyManagedGatewayEnvironment(env, envelope);
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') resolved[key] = value;
    }
    // The daemon's ordinary spawn path sets this through
    // `applyConfirmedPromptDeliveryFlag`; a managed generation never goes
    // through that path, so without it here the child would deliver its first
    // turn unconfirmed.
    resolved.HAPPY_MANAGED_REQUIRE_PROMPT_ACK = '1';
    /*
     * The two descriptor numbers, and only the numbers.
     *
     * `readManagedStartup` turns managed mode on **by the presence of
     * `HAPPY_MANAGED_BOOTSTRAP_FD` and nothing else** — the descriptor is
     * inherited either way, but without the variable naming it the child never
     * looks, attaches to no session, and comes up as an ordinary unmanaged
     * spawn holding a managed run's volume.
     *
     * A number is not a secret; the documents behind them never travel this
     * way. `MANAGED_BOOTSTRAP_CHILD_FD` and `MANAGED_REPORT_CHILD_FD` are the
     * numbers the launcher actually binds, so these are bound to the constants
     * rather than written out.
     */
    resolved[MANAGED_BOOTSTRAP_FD_ENV] = String(MANAGED_BOOTSTRAP_CHILD_FD);
    resolved[MANAGED_REPORT_FD_ENV] = String(MANAGED_REPORT_CHILD_FD);
    /*
     * A home the provider uid actually owns.
     *
     * The environment is built from nothing on purpose — an inherited value is
     * a way to run outside the approval — but the child is the CLI, and the CLI
     * keeps state under `$HOME`. The provider uid has no passwd entry in the
     * image, so with no `HOME` the runtime resolves one it cannot write and the
     * generation dies before it reports anything: the daemon sees only a
     * session webhook that never arrives.
     *
     * This is the directory the runtime already creates and chowns to that uid
     * for the provider's own state — the one place it is known to be able to
     * write. It is not a new policy and not a path the caller can choose.
     */
    resolved.HOME = MANAGED_GENERATION_CODEX_HOME;
    return resolved;
}

/**
 * Runs a program without a shell, for the checkpoint's database flush.
 *
 * `stdout` is part of the answer rather than a convenience: `PRAGMA
 * wal_checkpoint` reports whether it actually ran in its result row and exits 0
 * either way, so a checkpoint that only looked at the exit code would archive a
 * database with a live WAL and call it flushed.
 */
export const defaultCheckpointFlushDeps: CheckpointFlushDeps = {
    run: (program, args) => new Promise((resolve) => {
        execFile(program, args, { encoding: 'utf8' }, (error, stdout) => {
            const code = (error as { code?: unknown } | null)?.code;
            resolve({ code: typeof code === 'number' ? code : (error ? 1 : 0), stdout: stdout ?? '' });
        });
    }),
};

/**
 * What this runtime needs before it can checkpoint at all.
 *
 * **Required, not optional.** A runtime that comes up without it would run,
 * accept work, and quietly never take a checkpoint — and nothing would say so
 * until the volume was needed and there was nothing to restore. So an
 * unconfigured runtime refuses to build its launch config instead.
 *
 * `policy: null` and a target source that answers `null` are different: those
 * are decisions this runtime was actually given ("take none", "the parent has
 * issued none right now"), and they are legible in `checkpointState()`. Absence
 * of the whole block is not a decision, it is a missing wire.
 */
export type ManagedCheckpointRuntimeConfig = {
    tenant: { tenantId: string; projectId: string };
    /**
     * Asked per attempt: the observer answers after boot, so a value captured
     * here would be the one from before it looked. `null` blocks the
     * checkpoint rather than filing an archive against an unconfirmed volume.
     */
    volume: () => { volumeId: string; deviceUuid: string } | null;
    /**
     * Optional: the image knows what it is.
     *
     * Read from the file the build wrote, so a checkpoint records the image
     * that is *running* rather than the one the parent asked for. Supplied only
     * by tests, which have no image to read.
     */
    image?: { imageVersion: string };
    /** The project tree and the provider state beside it. */
    /**
     * Optional: the project tree and the provider state beside it are fixed
     * image paths, not a parent policy. Supplied only by tests.
     */
    areas?: CheckpointAreaSource[];
    /** How long a checkpoint may wait for in-flight writes. */
    drainBudgetMs: number;
    /** Per-attempt publish targets from the parent. */
    targets: ManagedCheckpointTargetSource;
    /** Configured, never defaulted; `null` is an explicit "take none". */
    policy: CheckpointSchedulePolicy | null;
    flushDeps?: CheckpointFlushDeps;
    providerStateSessions?: readonly string[];
    /**
     * The object-store transport. Optional: production uses the global `fetch`
     * against the parent's presigned URLs. Supplied only by tests.
     */
    fetchImpl?: CheckpointFetch;
    /**
     * Where the sealed objects are staged. Optional: on a managed runtime this
     * is a fixed path on the run's own volume, not a parent policy. Supplied
     * only by tests, which have no `/workspace`.
     */
    workDir?: string;
    /**
     * The provider-quiescence gate, **read when a checkpoint is attempted**.
     *
     * A reference, because the gate is built from the supervisor and the
     * supervisor does not exist when this composition is made — the drain it
     * observes is created right here, so the ordering cannot be the other way
     * round.
     *
     * Its `null` means "not wired yet", which the coordinator refuses
     * (`gate-not-wired`). Omitting the field is the different statement that
     * this runtime has no gate at all — and that is still not permission to
     * archive provider state: the coordinator refuses `no-quiescence-gate`
     * whenever the runner archives `provider-state` with nothing to prove it.
     */
    providerQuiescence?: () => ProviderQuiescenceGate | null;
};

export type ManagedRunComposition = {
    managedRun: Omit<ManagedGenerationLaunchConfig, 'createProviderSupervisor'>;
    /** The runtime's one runner and coordinator. Tick the coordinator. */
    checkpoint: ManagedCheckpointSession;
};

export function defaultManagedRunConfig(input: {
    identity: ManagedRuntimeIdentity;
    policy: ManagedRunPolicy;
    onUnprovenTermination: (info: { tool: string; detail?: string }) => void;
    /**
     * The runtime's checkpoint wiring. Required — see the type's own note on
     * why an absent block is a missing wire rather than a decision.
     */
    checkpoint: ManagedCheckpointRuntimeConfig;
    /**
     * The runtime's own approved server, from the **stored** daemon credential.
     *
     * Not from the spawn envelope: the child compares the envelope's relay
     * origin against its configured server, and configuring it *from* the
     * envelope would make that check compare the envelope with itself. The
     * stored credential is the operator's side of that comparison — read back
     * through a root-owned path and matched against the marker's machine id by
     * `readManagedDaemonCredential`, so it is the origin this machine was
     * provisioned with rather than one a request asked for.
     *
     * Required, with no default: the boot refuses to start a runtime whose
     * stored credential it could not read, so there is no state in which this
     * is unknown. A default here would send the runtime's own credentials to
     * whatever the process happened to think the server was.
     */
    serverOrigin: string;
    monotonicNow?: () => number;
}): ManagedRunComposition {
    assertManagedRunPolicy(input.policy);
    assertManagedCheckpointRuntimeConfig(input.checkpoint);
    const cgroupRoot = input.identity.isolation.cgroupRoot;
    const areas = input.checkpoint.areas ?? managedCheckpointAreas({
        projectRoot: MANAGED_PROJECT_ROOT,
        providerStateRoot: MANAGED_GENERATION_CODEX_HOME,
    });
    const checkpoint = createManagedCheckpointSession({
        tenant: input.checkpoint.tenant,
        volume: input.checkpoint.volume,
        image: input.checkpoint.image ?? { imageVersion: readManagedImageVersion() },
        areas,
        // The grant's write tools are the volume's writers; one list, so the
        // drain and the broker cannot disagree about who changes the tree.
        writeTools: new Set(MANAGED_WRITE_TOOLS),
        drainBudgetMs: input.checkpoint.drainBudgetMs,
        flushDeps: input.checkpoint.flushDeps ?? defaultCheckpointFlushDeps,
        targets: input.checkpoint.targets,
        policy: input.checkpoint.policy,
        ...(input.checkpoint.workDir ? { workDir: input.checkpoint.workDir } : {}),
        ...(input.checkpoint.fetchImpl ? { fetchImpl: input.checkpoint.fetchImpl } : {}),
        ...(input.checkpoint.providerQuiescence
            ? { providerQuiescence: input.checkpoint.providerQuiescence }
            : {}),
        ...(input.checkpoint.providerStateSessions
            ? { providerStateSessions: input.checkpoint.providerStateSessions }
            : {}),
    });
    const managedRun: Omit<ManagedGenerationLaunchConfig, 'createProviderSupervisor'> = {
        /*
         * `startManagedProviderRun` wants the provider credentials at the top
         * level and the whole isolation block beside them. Composed here from
         * the marker rather than cast: a cast would let a marker missing an
         * axis through, and the axes are what the isolation is.
         */
        identity: {
            provider: input.identity.isolation.provider,
            isolation: input.identity.isolation,
        },
        toolHelperPath: MANAGED_TOOL_HELPER_PATH,
        providerHelperPath: MANAGED_PROVIDER_HELPER_PATH,
        execPath: TRUSTED_PROVIDER_EXEC_PATH,
        tools: MANAGED_CODING_TOOLS,
        // The grant's scope is the permitted list, never something a requester
        // asked for: a run cannot widen what it is allowed to do by asking.
        scope: MANAGED_CODING_TOOLS.map((tool) => tool.name),
        ttlMs: input.policy.ttlMs,
        toolTimeoutMs: input.policy.toolTimeoutMs,
        /*
         * The environment mapping is separate from the dependency by design:
         * the runtime knows an `serverOrigin`, and the child reads
         * `HAPPY_SERVER_URL`. Keeping the two names apart means a change to
         * either side is visible as a change, rather than one silently
         * standing in for the other.
         */
        /*
         * The same trusted origin the child is given, kept as a value as well
         * as a mapping: the launcher refuses an envelope naming another Happy
         * before it parks anything, and that decision needs the axis itself,
         * not an environment key built from it.
         */
        serverOrigin: input.serverOrigin,
        providerEnvironment: (envelope) => ({
            ...managedProviderEnvironment(envelope),
            HAPPY_SERVER_URL: input.serverOrigin,
        }),
        cgroupPathFor: (key) => generationCgroupPath(cgroupRoot, key),
        codexHome: MANAGED_GENERATION_CODEX_HOME,
        onUnprovenTermination: input.onUnprovenTermination,
        writeFile: (file) => {
            /*
             * `wx`: the per-run script's name is a digest of the generation, so
             * an existing file means either a reused generation or something
             * that got there first. Neither is a file to overwrite and exec.
             * The mode is set on the handle, not with `chmod` afterwards —
             * there is no window where it exists more permissively.
             */
            const handle = openSync(file.path, 'wx', file.mode);
            try {
                writeFileSync(handle, file.contents, { encoding: 'utf8' });
                fchmodSync(handle, file.mode);
            } finally {
                closeSync(handle);
            }
        },
        // The parked child's own environment, as the kernel has it — not what
        // the plan says it should be. Comparing the two is the point.
        readProcEnviron: (pid) => {
            const raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
            const environ: Record<string, string> = {};
            for (const entry of raw.split('\0')) {
                if (entry === '') continue;
                const split = entry.indexOf('=');
                if (split <= 0) continue;
                environ[entry.slice(0, split)] = entry.slice(split + 1);
            }
            return environ;
        },
        lstatPath: (path) => {
            const entry = lstatSync(path);
            return {
                uid: entry.uid,
                mode: entry.mode & 0o7777,
                isDirectory: entry.isDirectory(),
                isSymbolicLink: entry.isSymbolicLink(),
                isFile: entry.isFile(),
            };
        },
        // The runtime's one gate, from the runner that will archive behind it.
        checkpointDrain: checkpoint.checkpointDrain,
        ...(input.monotonicNow ? { monotonicNow: input.monotonicNow } : {}),
    };
    return { managedRun, checkpoint };
}

/**
 * The running image's version, from the file the build wrote.
 *
 * Not a build argument and not a parent field: both can be asserted from
 * outside, and a checkpoint labelled with an image this runtime is not would
 * tell a restore to assume a contract that never applied here.
 */
export function readManagedImageVersion(
    read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
    const version = read(MANAGED_IMAGE_VERSION_FILE).trim();
    if (version === '') throw new Error('managed image version file is empty');
    return version;
}

export function assertManagedCheckpointRuntimeConfig(config: ManagedCheckpointRuntimeConfig): void {
    if (!Number.isSafeInteger(config.drainBudgetMs) || config.drainBudgetMs <= 0) {
        throw new Error('managed checkpoint config requires a positive drainBudgetMs');
    }
    if (config.areas && config.areas.length === 0) {
        // No area is not "checkpoint nothing" — it is a checkpoint that
        // succeeds while capturing none of the run's work.
        throw new Error('managed checkpoint config requires at least one area');
    }
}

/**
 * The grant lifetime for one launch: the configured value, or what is left of
 * the lease, whichever is shorter.
 */
export function boundedGrantTtlMs(input: {
    policy: ManagedRunPolicy;
    leaseExpiresMonotonic: number;
    monotonicNow: number;
}): number {
    const remaining = input.leaseExpiresMonotonic - input.monotonicNow;
    return remaining <= 0 ? 0 : Math.min(input.policy.ttlMs, remaining);
}

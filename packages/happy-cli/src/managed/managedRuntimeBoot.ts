/**
 * specs/managed-cloud-byos §5.36 — the root boot stage of a managed runtime.
 *
 * This is what runs **before the daemon and before the agent uid is used for
 * anything**, as root, once per boot. It does the three things that can only
 * be done from there, and then gets out of the way:
 *
 *  1. **Makes the trusted directory** the supervisor's socket will live in —
 *     root-owned, `0700`, inside the canonical state directory the provisioning
 *     marker names. Not `/tmp`, not a path from the environment: the socket is
 *     the authority that proves generations are gone, and a socket anybody can
 *     replace is an authority anybody can impersonate.
 *  2. **Starts the supervisor and publishes where it is.** The record is
 *     written only after the socket is listening, so a daemon that finds a
 *     record finds something behind it.
 *  3. **Hands the workspace to the uid that will actually write in it.** The
 *     agent runs as a separate uid; a `root:root 0755` project root means every
 *     write the agent makes fails with `EACCES` — the tool boundary would be
 *     enforced correctly and the runtime would still be useless.
 *
 * ## What it refuses to do
 *
 * It never falls back. No marker, an untrusted marker, a state directory it
 * cannot make safe, a supervisor that will not start — each ends the boot. The
 * fallback in every one of those cases is "run the agent anyway, unfenced",
 * which is the exact state the whole design exists to prevent.
 *
 * It also never puts the boot token anywhere but the record. Not in the
 * environment it hands on, not in a log line, not in an error detail: the
 * provider process started later inherits an environment, and a token there is
 * a token the agent can read out of `/proc`.
 */
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MANAGED_AI_AUTH_HOME_ROOT } from '@/managed/managedAiAuth';
import {
    resolveManagedRuntimeIdentity,
    defaultProvisioningDeps,
    MANAGED_PROJECT_ROOT,
    type ManagedProvisioningDeps,
    type ManagedRuntimeIdentity,
} from '@/daemon/managedRuntimeIdentity';
import {
    readManagedLauncherBinding,
    writeManagedLauncherBinding,
} from '@/daemon/launch/managedLauncherBinding';
import { logger } from '@/ui/logger';
import { acquireSupervisorLock, supervisorLockAddress, type SupervisorLockScope } from '@/launcher/supervisor';
import { createSupervisorRuntime } from '@/launcher/main';
import { defaultManagedRunConfig } from '@/launcher/managedRunConfig';
import {
    authenticateManagedCheckpointTarget,
    createManagedCheckpointTargetInbox,
} from '@/managed/checkpoint/managedCheckpointTargetInbox';
import { createManagedRuntimeGrantSnapshot } from '@/managed/managedRuntimeGrantSnapshot';
import type { ManagedSupervisorPublishOutcome } from '@/launcher/main';
import { createManagedRuntimeCheckpointing } from '@/managed/checkpoint/managedRuntimeCheckpointing';
import type { ManagedCheckpointTickLoop } from '@/managed/checkpoint/managedCheckpointTickLoop';
import { observeManagedVolume } from '@/managed/managedRuntimeObserver';
import {
    inspectManagedDaemonStateLeaf,
    managedDaemonStateDir,
    type ManagedDaemonLeafStat,
} from '@/daemon/managedDaemonStateLayout';
import {
    managedDaemonAccountCollision,
    resolveManagedDaemonAccount,
} from '@/daemon/managedDaemonAccount';
import { resolveManagedVolumeBinding } from '@/managed/managedVolumeBinding';
import { readManagedDaemonCredential } from '@/daemon/managedDaemonCredential';
import {
    MANAGED_DAEMON_CREDENTIAL_INPUT_PATH,
    adoptManagedDaemonCredential,
    narrowDeliveredCredentialMode,
    readDeliveredMachineId,
    type ManagedCredentialAdoption,
} from '@/daemon/managedDaemonCredentialInput';

/** The socket lives here, under the state directory root already owns. */
export function managedLauncherDirectory(stateDir: string): string {
    return join(stateDir, 'launcher');
}

export function managedLauncherSocketPath(stateDir: string): string {
    return join(managedLauncherDirectory(stateDir), 'launcher.sock');
}

/**
 * Where codex keeps its own state. Beside the workspace, never inside it: the
 * executor owns the workspace tree, and codex's state is the provider's.
 */
export function managedCodexHome(): string {
    return '/workspace/.codex';
}

/**
 * Where a checkpoint restore stages its tree before promoting it.
 *
 * **On the volume**, beside the destinations, because promotion is a `rename`
 * and `rename` does not cross filesystems. Staged anywhere else — `/tmp`, the
 * state directory on the boot disk — every promotion fails with `EXDEV` and the
 * runtime comes up with the volume it was supposed to restore into untouched.
 */
export const MANAGED_RESTORE_STAGING_ROOT = '/workspace/.saycode-restore';

export type ManagedRuntimeBootRefusal =
    | 'not-managed'
    /**
     * The marker could not be produced. A runtime with no identity record,
     * before anything has judged one.
     *
     * Its own reason, apart from `identity-inactive`: "could not write it" and
     * "wrote it and then would not trust it" are different machines to look
     * at, and one word for both leaves the operator unable to tell which
     * happened.
     */
    | 'marker-unwritable'
    /**
     * The supervisor is up and every gate passed, but it could not record that
     * it is the instance on this socket.
     *
     * Its own reason rather than folded into `supervisor-unavailable`: the
     * supervisor **is** available, and what failed is the record. Nothing is
     * rolled back — two of the writer's stages leave bytes on disk.
     */
    | 'attestation-unpublishable'
    /**
     * There is a marker and this runtime may not run as it.
     *
     * The refusal carries the identity's own classifier in `detail` — every way
     * a marker can be untrustworthy otherwise arrives as one word, and the part
     * that says what to look at next is precisely the part that was dropped.
     */
    | 'identity-inactive'
    | 'trusted-directory-unavailable'
    | 'supervisor-unavailable'
    | 'binding-unpublishable'
    | 'workspace-unassignable'
    /**
     * An interrupted promotion left trees whose fate nobody has established.
     * The runtime does not start and nothing is deleted — the leftovers may be
     * the only copy of what a destination used to hold.
     */
    | 'restore-unresolved'
    /**
     * The identity the parent delivered is not one this runtime may run as, or
     * could not be made its own. Separate from `identity-inactive`, which is
     * about the marker: this machine knows what it is and cannot prove who it
     * is to the server.
     */
    | 'credential-unusable'
    /**
     * The image does not state which account the daemon runs as, or states it
     * ambiguously. The daemon's own leaf would otherwise be owned by a uid
     * nobody chose, which is the permission this slice exists to remove.
     */
    | 'daemon-account-unusable'
    /**
     * The daemon's leaf exists and is not what it must be — a different owner, a
     * different mode, a file, or a link. Refused rather than corrected: it may
     * hold a live store, and this boot does not hold the daemon's writer lock.
     */
    | 'daemon-state-leaf-unusable';

export type ManagedRuntimeBootOutcome =
    | {
        ok: true;
        socketPath: string;
        published: 'created' | 'existing';
        /**
         * What this boot observed about the volume it is running on, sealed.
         *
         * Carried out of the boot rather than guessed at later: the filesystem
         * UUID is a **real observation** of this machine's mounts, and the only
         * thing entitled to answer it is the kernel's own view — not the
         * marker, which is the parent's description of what it attached. A
         * checkpoint bound to a guessed uuid is a checkpoint bound to the wrong
         * volume.
         *
         * Null when the volume could not be observed or sealed; the caller
         * decides what that means for it, which is the same discipline the
         * daemon's own facts already follow.
         */
        volume: { providerVolumeId: string; deviceMajorMinor: string; fsUuid: string } | null;
        /**
         * The runtime's checkpoint consumer, so whoever owns this process's
         * lifetime can let a checkpoint in flight finish.
         *
         * `null` when this runtime takes no checkpoints — the marker carries no
         * schedule — or when the supervisor was started by something that does
         * not run one. A shutdown that ignored a running attempt could leave an
         * archive uploaded with its pointer unpublished: a checkpoint that
         * exists and that nothing can find.
         */
        checkpointTicks: ManagedCheckpointTickLoop | null;
    }
    | {
        ok: false;
        reason: ManagedRuntimeBootRefusal;
        /**
         * A fixed classifier from whoever refused, never a value.
         *
         * The identity's own reasons and the isolation probe's are closed code
         * lists; no path, token or credential reaches this field, so it is safe
         * where the refusal itself is safe.
         */
        detail?: string;
    };

type RuntimeStopHandle = { stop(): Promise<{ stopped: boolean }> };
type BootOwnershipTransfer = {
    registerRuntime(handle: RuntimeStopHandle): void;
    take(scope: SupervisorLockScope): Promise<
        { ok: true; release: () => Promise<void> }
        | { ok: false; reason: 'ownership-already-taken' | 'ownership-released'
            | 'ownership-scope-mismatch' | 'ownership-runtime-unregistered' }
    >;
};

export type ManagedRuntimeBootDeps = {
    acquireOwnership: (scope: SupervisorLockScope) => Promise<
        { ok: true; ownership: { scope: SupervisorLockScope; address: string; release: () => Promise<void> } }
        | { ok: false; reason: 'not-linux' | 'already-held' | 'bind-failed' }
    >;
    /**
     * Starts the supervisor. Injected rather than imported so this decision can
     * be exercised without a privileged process; production passes the real
     * `createSupervisorRuntime` runtime through `startSupervisor`.
     */
    startSupervisor: (input: {
        ownership: BootOwnershipTransfer;
        identity: ManagedRuntimeIdentity;
        /**
         * The digest of the bytes the marker was **parsed from** — the sibling
         * the active resolution carries, handed down rather than re-derived.
         *
         * Required, not optional: an optional field with a quiet fallback is
         * how a runtime ends up attesting to a digest nobody read.
         */
        markerSha256: string;
        socketPath: string;
        /**
         * The token a previous boot already published, when there is one.
         *
         * Given, the supervisor uses it; absent, it mints its own. This is what
         * makes a restart possible at all: the launcher record is write-once,
         * so a second boot that minted a new token would publish a token the
         * record refuses, and the runtime would never start again.
         */
        token?: string;
        /**
         * What this boot observed about its volume, **asked later**.
         *
         * A function because the supervisor starts before the observation
         * happens — it has to, since observing the volume is not what makes a
         * runtime ready. A value read at start would be the one from before
         * anybody looked, and a checkpoint bound to it would be bound to a
         * volume nothing confirmed. `null` while it is still unknown, which
         * the checkpoint path treats as "not yet" rather than guessing.
         */
        observedVolume: () => { volumeId: string; deviceUuid: string } | null;
        /**
         * The Happy this runtime is credentialed for, from the credential on
         * disk. The boot refuses before this point when it cannot be read, so
         * it is always the stored axis — never a process-wide default.
         */
        serverOrigin: string;
    }) => Promise<{
        token: string;
        /**
         * The checkpoint consumer this supervisor started, when it started one.
         *
         * Returned rather than kept, because the thing that has to wait for a
         * checkpoint on the way down is whoever owns the process, and that is
         * not this function.
         */
        checkpointTicks?: ManagedCheckpointTickLoop | null;
        /**
         * The supervisor's own publication, already bound to it.
         *
         * Required on the return, and taking **no arguments**: the boot decides
         * *when* a record is written, and the supervisor decides *what* is in
         * it. A composition that forgot to wire this would otherwise never
         * publish and nothing would say so.
         */
        publishAttestation: () => ManagedSupervisorPublishOutcome;
    } | null>;
    /** Creates a directory with an exact mode, owned by root. */
    makeTrustedDirectory: (path: string, mode: number) => Promise<void>;
    /**
     * The project root, made before the identity is resolved.
     *
     * The isolation probe runs inside the identity check, through the real
     * executor helper, and that helper `chdir`s into the project root before it
     * executes anything. On a fresh volume nothing has made that directory
     * yet — `assignWorkspace` only runs after the identity is known — so the
     * probe could never launch and the first boot always refused. Root makes
     * it here; the workspace assignment later hands it to the executor.
     */
    ensureProjectRoot: (path: string) => Promise<void>;
    /**
     * The account the image created for the daemon, or `null` when the image does
     * not state one. Read as root, from the image's own databases.
     */
    resolveDaemonAccount: () => { uid: number; gid: number } | null;
    /**
     * **Creates** the daemon's leaf, or verifies the one already there.
     *
     * Never corrects what it finds: a later boot can meet a leaf that already
     * holds a live store, and nothing here holds the daemon's writer lock, so a
     * `chmod`/`chown` would mutate state this boot did not write while the daemon
     * may be writing it. Measured on Linux: "fixing" an existing leaf moved its
     * owner `2001 → 2003` and its mode `0750 → 0700`.
     *
     * Not recursive either — the contents are never walked.
     */
    provisionDaemonStateLeaf: (input: {
        path: string; uid: number; gid: number; mode: number;
    }) => Promise<{ ok: true; created: boolean } | { ok: false; detail: string }>;
    /** Gives the workspace to the uid that will write in it. */
    assignWorkspace: (input: { path: string; uid: number; gid: number }) => Promise<void>;
    /** Creates the provider's own state directory, owned by the provider uid. */
    assignProviderHome: (
        input: { path: string; uid: number; gid: number; mode: number },
    ) => Promise<void>;
    /**
     * Creates the root that personal AI logins live under (R23).
     *
     * root-owned and `0711`: traversable, so the provider uid can reach its own
     * connection directory, and unlistable, so nothing on this machine can
     * enumerate who has logged in. Deliberately **not** the recursive
     * assignment the two above use — what is inside belongs to the provider
     * uid, and re-owning the tree on every boot would take every existing
     * login away from the process that has to read it.
     */
    assignAuthHomeRoot: (input: { path: string; mode: number }) => Promise<void>;
    /**
     * Lays a checkpoint down, if this runtime has one to restore.
     *
     * Runs **before** ownership is applied. A restore promotes by renaming a
     * tree root built as root, so whatever it promotes arrives root-owned; if
     * ownership were settled first, every file the restore brought back would
     * be unwritable by the executor and the runtime would look ready while no
     * tool could touch its own project. Absent here means there is nothing to
     * restore (T13 supplies the archive side), not that restoring is optional.
     */
    restore?: () => Promise<'restored' | 'nothing-to-restore'>;
    /**
     * Asks what a crashed promotion left behind, and whether it may go.
     *
     * **It is not swept.** An interrupted multi-area promotion can leave the
     * *only* copy of a destination's previous contents in `displaced-*` — the
     * rollback that would have put it back is exactly the step that did not
     * finish. Deleting those trees because "the restore is over" destroys
     * customer data, and it destroys it silently, because the destination that
     * is missing them still looks like a directory.
     *
     * So this reports, and only what a recovery has **proven** reclaimable may
     * be reported as `clear`. Anything else is `unresolved`: the leftovers stay
     * exactly where they are and the boot stops, because a runtime whose areas
     * may be half-promoted cannot be allowed to serve work over them.
     */
    /**
     * **Required.** It was optional, and that is precisely how it came to be
     * missing where it matters: `defaultManagedRuntimeBootDeps` did not
     * provide one, so the real CLI booted with the guard absent and the
     * `if (deps.inspectRestoreStaging)` around it silently held. A runtime with
     * half-promoted areas started and served work. A required field cannot be
     * forgotten by the one caller that is not a test.
     */
    inspectRestoreStaging: () => Promise<'clear' | 'unresolved'>;
    /**
     * Takes the credential the parent delivered and makes it this runtime's
     * own. **Required**, for the reason above it: an optional handoff is a
     * handoff the one non-test caller forgets, and a runtime that boots without
     * one authenticates as nothing.
     */
    /**
     * Writes the provisioning marker from the parent's boot input.
     *
     * Required, and part of this stage rather than of the image's entry
     * script: the marker is the trust anchor every later decision reads, and it
     * has to be produced by something that can refuse — an untrusted path, a
     * boot input that is not managed, an identity that would differ from the
     * one already recorded.
     */
    /**
     * Which Machine the parent's delivered credential names.
     *
     * Its own dependency because it is read **before** any identity exists —
     * the marker is written from it — and because a boot that could not be
     * exercised without touching the real `/etc` is a boot nobody exercises.
     */
    /**
     * Seals and reports the volume this runtime is on.
     *
     * Injected for the same reason everything else here is: the real one reads
     * `/proc/self/mountinfo` and writes a seal, and a boot that could only be
     * exercised on a machine with those is a boot nobody exercises.
     */
    observeVolume: (input: {
        stateDir: string;
        providerVolumeId: string;
        deps: ManagedProvisioningDeps;
    }) => Promise<
        | { ok: true; binding: { providerVolumeId: string; deviceMajorMinor: string; fsUuid: string } }
        | { ok: false }
    >;
    /**
     * Takes the group and other bits off the delivered credential.
     *
     * Its own step, run once and first: every later read of that file is judged
     * by a gate that refuses anything another uid can read, so a file the
     * platform wrote `0644` must be narrowed before the first of those reads
     * rather than before the last.
     */
    narrowDeliveredCredential: () => 'ok' | 'absent' | 'refused';
    readDeliveredMachineId: (input: { deps: ManagedProvisioningDeps }) =>
        { status: 'ok'; machineId: string } | { status: 'absent' } | { status: 'refused' };
    writeMarker: (input: {
        instance: { providerMachineId: string | null; providerInstanceId: string | null };
        happyMachineId: string | null;
    }) => Promise<{
        status: 'written' | 'adopted' | 'not-managed' | 'refused';
        /**
         * The writer's own classifier, when it refused.
         *
         * Carried rather than folded: the writer distinguishes eleven ways this
         * can fail — an untrusted path, an absent or unreadable boot input, an
         * instance it could not identify, a marker it could not write — and one
         * word for all of them is a diagnosis that has to be guessed. Fixed
         * codes only; no path, value or credential rides here.
         */
        reason?: string;
    }>;
    /**
     * Which provider instance this process is running on.
     *
     * Read from the guest's own environment, not from a provider API: asking
     * the API would mean putting a credential that can create and destroy
     * machines inside the machine, to learn something the platform already told
     * it.
     */
    providerInstance: () => { providerMachineId: string | null; providerInstanceId: string | null };
    adoptCredential: (input: {
        stateDir: string;
        expectedMachineId: string;
        now: number;
        deps: ManagedProvisioningDeps;
    }) => Promise<ManagedCredentialAdoption>;
    provisioning?: ManagedProvisioningDeps;
    resolveIdentity?: typeof resolveManagedRuntimeIdentity;
    /**
     * Which Happy this runtime is credentialed for, read from the stored
     * credential. Injected only so a test can stand in for the file; the
     * default is the read, and a `null` from either refuses the boot.
     */
    readTrustedServerOrigin?: typeof readTrustedManagedServerOrigin;
};

/**
 * The server origin this runtime is credentialed for, or `null`.
 *
 * `null` covers every way the answer is not knowable — no stored credential, an
 * unreadable one, one issued for a different machine — because each of them has
 * the same consequence: there is no origin this runtime may present its bearer
 * to, and inventing one is worse than refusing to start.
 */
export function readTrustedManagedServerOrigin(input: {
    stateDir: string;
    expectedMachineId: string;
    now: number;
    deps: ManagedProvisioningDeps;
}): string | null {
    const stored = readManagedDaemonCredential(input);
    if (!stored.ok) return null;
    const origin = stored.credential.serverOrigin.trim();
    return origin === '' ? null : origin;
}

export async function runManagedRuntimeBoot(
    deps: ManagedRuntimeBootDeps,
): Promise<ManagedRuntimeBootOutcome> {
    const provisioning = deps.provisioning ?? defaultProvisioningDeps;

    /*
     * The marker is **produced here**, before it is read.
     *
     * Nothing else writes it. Without this the first boot of every machine
     * reads an absent marker, concludes BYOS, and does nothing — the runtime
     * the parent just created never becomes one, and no line anywhere says why.
     *
     * The ordering is forced rather than chosen. The marker records which
     * Machine this is, and on a first boot the only thing on the disk that
     * knows is the credential the parent delivered — it was minted for that
     * Machine and for no other. So: read that one field, write the marker,
     * *then* resolve identity from the marker as every later boot does.
     *
     * A marker that already exists is not rewritten. It is write-once by
     * design, and the writer adopts an identical one and refuses a different
     * one, so a second delivery naming another Machine cannot move an identity
     * this runtime has already recorded.
     */
    /*
     * Narrowed **before the first read of it**, not before adoption.
     *
     * The provider writes this file and chooses its mode. The gate that judges
     * it refuses anything another uid can read — correctly — so a file
     * delivered `0644` has to be narrowed first or every read of it fails. It
     * used to be narrowed inside adoption, which was late: the machine id is
     * read out of the same file earlier, to write the marker, and that read hit
     * the strict gate first and turned a perfectly ordinary delivery into
     * `credential-unusable` before a marker ever existed.
     *
     * The narrowing is on the descriptor it opened, with `O_NOFOLLOW`, so a
     * symlink swapped in between is refused rather than having its target's
     * mode rewritten.
     */
    const narrowed = deps.narrowDeliveredCredential();
    if (narrowed === 'refused') {
        return { ok: false, reason: 'credential-unusable', detail: 'delivered-file-mode' };
    }

    const delivered = deps.readDeliveredMachineId({ deps: provisioning });
    if (delivered.status === 'refused') {
        return { ok: false, reason: 'credential-unusable', detail: 'delivered-file-unreadable' };
    }
    if (delivered.status === 'ok') {
        const written = await deps.writeMarker({
            instance: deps.providerInstance(),
            happyMachineId: delivered.machineId,
        });
        // `not-managed` here means the boot input says this is not a managed
        // machine, which is BYOS and not a failure. Anything else refused.
        if (written.status === 'refused') {
            return {
                ok: false,
                reason: 'marker-unwritable',
                ...(written.reason ? { detail: written.reason } : {}),
            };
        }
    }

    try {
        await deps.ensureProjectRoot(MANAGED_PROJECT_ROOT);
    } catch {
        return { ok: false, reason: 'trusted-directory-unavailable' };
    }
    const identity = (deps.resolveIdentity ?? resolveManagedRuntimeIdentity)();
    // Absence is a BYOS machine and nothing to do here. A marker that exists
    // and cannot be trusted is not the same thing, and it does not become one
    // by being ignored.
    if (identity.status === 'absent') return { ok: false, reason: 'not-managed' };
    if (identity.status !== 'active') {
        /*
         * The identity's own words, joined and passed through.
         *
         * `reason` says which rule refused (`isolation-unverified`,
         * `not-root-owned`, `malformed`…) and `detail` says which part of it —
         * the isolation probe's codes live there. Both are fixed classifiers.
         */
        const refusal = identity as { reason: string; detail?: string };
        return {
            ok: false,
            reason: 'identity-inactive',
            detail: refusal.detail ? `${refusal.reason}: ${refusal.detail}` : refusal.reason,
        };
    }

    const stateDir = identity.identity.stateDir;
    const socketPath = managedLauncherSocketPath(stateDir);

    const scope = { runtimeId: identity.identity.runtimeId, manifestRoot: join(stateDir, 'manifest'),
        cgroupRoot: identity.identity.isolation.cgroupRoot };
    let acquired: Awaited<ReturnType<ManagedRuntimeBootDeps['acquireOwnership']>>;
    try { acquired = await deps.acquireOwnership(scope); }
    catch { return { ok: false, reason: 'supervisor-unavailable' }; }
    if (!acquired.ok) return { ok: false, reason: 'supervisor-unavailable' };
    const held = acquired.ownership;
    const capturedScope = { ...held.scope };
    const capturedAddress = held.address;
    const release = held.release;
    const owner: { state: 'boot-owned' | 'taken' | 'released'; runtime: RuntimeStopHandle | null } = {
        state: 'boot-owned', runtime: null,
    };
    const ownership: BootOwnershipTransfer = {
        registerRuntime(handle) {
            if (owner.runtime !== null || owner.state !== 'boot-owned') throw new Error('ownership-runtime-already-registered');
            owner.runtime = handle;
        },
        async take(requested) {
            if (owner.state === 'taken') return { ok: false, reason: 'ownership-already-taken' };
            if (owner.state === 'released') return { ok: false, reason: 'ownership-released' };
            if (!owner.runtime) return { ok: false, reason: 'ownership-runtime-unregistered' };
            try {
                if (requested.runtimeId !== capturedScope.runtimeId || requested.manifestRoot !== capturedScope.manifestRoot
                    || requested.cgroupRoot !== capturedScope.cgroupRoot || supervisorLockAddress(requested) !== capturedAddress) {
                    return { ok: false, reason: 'ownership-scope-mismatch' };
                }
            } catch { return { ok: false, reason: 'ownership-scope-mismatch' }; }
            owner.state = 'taken';
            return { ok: true, release };
        },
    };

    const runOwnedBootBody = async (): Promise<ManagedRuntimeBootOutcome> => {
        /*
         * The identity this runtime authenticates as, before anything is started.
         *
         * It arrives from the parent — nothing in a guest can mint it, by design —
         * and `run.ts` refuses to start managed without it, so it has to be on the
         * volume by the time this returns. Done first because it is the cheapest
         * refusal: a credential this runtime may not run as should stop the boot
         * before a supervisor exists and before anything is published.
         *
         * Absence is **not** a refusal. A parent that has not wired the delivery
         * yet, and a machine whose credential is already on its volume, both land
         * here with nothing delivered; what happens next is decided by the daemon
         * when it reads the state directory, which is where that decision belongs.
         */
        let adoption: ManagedCredentialAdoption;
        try {
            adoption = await deps.adoptCredential({
                stateDir,
                expectedMachineId: identity.identity.happyMachineId,
                now: Date.now(),
                deps: provisioning,
            });
        } catch {
            // Never the error: it can carry the delivered file's contents.
            return { ok: false, reason: 'credential-unusable', detail: 'adoption-threw' };
        }
        if (adoption.status === 'refused') {
            // A closed code, never the file: it names which rule refused.
            return { ok: false, reason: 'credential-unusable', detail: `adoption-${adoption.reason}` };
        }

        /*
         * **Which Happy this runtime talks to, from the credential that is on disk.**
         *
         * Not from the delivered envelope: that value is what a boot input claimed,
         * and checking a claim against itself proves nothing. The stored record is
         * what the adoption accepted — root-owned, compared against the marker's
         * machine id on the way in — so it is the one that can be trusted here.
         *
         * Fail closed. A runtime that cannot read the origin it was issued for must
         * not fall back to a process-wide default: that default is how a scoped
         * bearer ends up presented to a server nobody approved.
         */
        const readOrigin = deps.readTrustedServerOrigin ?? readTrustedManagedServerOrigin;
        const trustedServerOrigin = readOrigin({
            stateDir,
            expectedMachineId: identity.identity.happyMachineId,
            now: Date.now(),
            deps: provisioning,
        });
        if (trustedServerOrigin === null) {
            return { ok: false, reason: 'credential-unusable', detail: 'stored-origin-unreadable' };
        }

        try {
            await deps.makeTrustedDirectory(managedLauncherDirectory(stateDir), 0o700);
        } catch {
            return { ok: false, reason: 'trusted-directory-unavailable' };
        }

        /*
         * The daemon's own leaf, created by the only process that can: root, before
         * the daemon exists.
         *
         * The state directory stays `root`-owned and holds root's records — the
         * launcher binding, the volume seal, the adopted credential. The daemon's
         * receipt store cannot live beside them and also be writable by a non-root
         * daemon, so it gets a directory of its own.
         *
         * Nothing existing is moved, rewritten or re-owned here: the leaf is created
         * and **that directory alone** is given to the account. A runtime whose state
         * is still in the old place is refused by the daemon at startup, under the
         * writer lock, rather than migrated behind its back.
         */
        const daemonAccount = deps.resolveDaemonAccount();
        if (!daemonAccount) return { ok: false, reason: 'daemon-account-unusable' };
        /*
         * The account may not be one of the agent accounts.
         *
         * The shared resolver separates the **running** uid from the provider and
         * executor uids; it says nothing about the *configured* daemon account. A
         * marker whose `provider.uid` equals this account's uid would pass every
         * existing check, and the leaf below would then hand the provider the receipt
         * store and `lease.json` — the record that decides whether its own generation
         * may still run.
         */
        const collision = managedDaemonAccountCollision(daemonAccount, identity.identity.isolation);
        if (collision) {
            logger.debug(`[managed] daemon account collides with ${collision}`);
            return { ok: false, reason: 'daemon-account-unusable' };
        }
        try {
            const provisioned = await deps.provisionDaemonStateLeaf({
                path: managedDaemonStateDir(stateDir),
                uid: daemonAccount.uid,
                gid: daemonAccount.gid,
                mode: 0o700,
            });
            if (provisioned.ok !== true) {
                // 이미 있는 leaf 를 고치지 않는다 — 그 안에 살아 있는 store 가 있을 수
                // 있고, 이 부팅은 daemon 의 writer lock 을 들고 있지 않다.
                logger.debug(`[managed] daemon state leaf refused: ${provisioned.detail}`);
                return { ok: false, reason: 'daemon-state-leaf-unusable' };
            }
        } catch {
            return { ok: false, reason: 'trusted-directory-unavailable' };
        }

        /*
         * What a previous boot published, if anything. Read before the supervisor
         * starts, because it decides which token the supervisor must present.
         *
         * An unreadable record is **not** treated as absent: minting a new token
         * over one that exists and cannot be read is how a runtime ends up with a
         * daemon holding one token and a supervisor answering another.
         */
        const alreadyPublished = readManagedLauncherBinding({ stateDir, deps: provisioning });
        if (!alreadyPublished.ok && alreadyPublished.reason !== 'absent') {
            return { ok: false, reason: 'binding-unpublishable' };
        }

        /*
         * Filled by the observation further down, read through the closure below.
         *
         * Declared here because the supervisor is configured before it happens and
         * must be able to ask afterwards.
         */
        let volume: { providerVolumeId: string; deviceMajorMinor: string; fsUuid: string } | null = null;

        let started: Awaited<ReturnType<ManagedRuntimeBootDeps['startSupervisor']>>;
        try {
            started = await deps.startSupervisor({
                ownership,
                identity: identity.identity,
                markerSha256: identity.markerSha256,
                socketPath,
                ...(alreadyPublished.ok ? { token: alreadyPublished.binding.token } : {}),
                serverOrigin: trustedServerOrigin,
                observedVolume: () => (volume === null
                    ? null
                    : { volumeId: volume.providerVolumeId, deviceUuid: volume.fsUuid }),
            });
        } catch {
            // The reason is the supervisor's, and it carries paths and credentials.
            // What matters here is that there is nothing to publish.
            started = null;
        }
        if (!started) return { ok: false, reason: 'supervisor-unavailable' };

        /*
         * Published only now, with the socket already listening. Written before
         * starting, a record would name an address nothing answers on, and the
         * daemon would read it and report a wired backend that cannot prove
         * anything.
         */
        const published = await writeManagedLauncherBinding({
            stateDir,
            socketPath,
            token: started.token,
            deps: provisioning,
        });
        if (!published.ok) return { ok: false, reason: 'binding-unpublishable' };

        /*
         * Two directories, two owners, and they are not interchangeable.
         *
         *  - The **workspace** goes to the *executor* uid. That is the uid tool
         *    calls run under, and it is the one that writes files there; left as
         *    `root:root 0755` every `write_file` fails with `EACCES` while the tool
         *    boundary is enforced perfectly.
         *  - **CODEX_HOME** goes to the *provider* uid at `0700`. The provider
         *    writes its own state there, and it must not be a directory the
         *    executor can read: what lands in it belongs to the session, not to the
         *    code the model chose to run.
         *
         * The state directory goes to neither. It holds the receipts, the volume
         * seal and the launcher record — anything that could write there could tell
         * the parent whatever it liked about this runtime's readiness.
         */
        const isolation = identity.identity.isolation;
        try {
            /*
             * Ordering, not politeness: ownership is applied to what is actually
             * there, and after a restore that is a tree the promotion just moved in.
             *
             * A restore reports **two different successes**, and they must not be
             * collapsed. `nothing-to-restore` is a volume this operation created
             * with no checkpoint behind it — the empty-initialized path, and a
             * normal start for a new project. A *failure* is something else
             * entirely, and it throws: read as "nothing to restore" it would clear
             * a volume holding real work.
             */
            if (deps.restore) await deps.restore();
            await deps.assignWorkspace({
                path: MANAGED_PROJECT_ROOT,
                uid: isolation.executor.uid,
                gid: isolation.executor.gid,
            });
            await deps.assignProviderHome({
                path: managedCodexHome(),
                uid: isolation.provider.uid,
                gid: isolation.provider.gid,
                mode: 0o700,
            });
            /*
             * Made here, as root, because nothing later can: the daemon runs
             * after this and the provider uid cannot create a directory in
             * `/workspace` it does not own. Idempotent — a runtime restarted
             * over an existing volume keeps the logins already in it.
             */
            await deps.assignAuthHomeRoot({ path: MANAGED_AI_AUTH_HOME_ROOT, mode: 0o711 });
        } catch {
            return { ok: false, reason: 'workspace-unassignable' };
        }

        /*
         * Leftovers from an interrupted promotion are checked **last and
         * separately**, because the answer is not "tidy up" but "may this runtime
         * serve work at all".
         *
         * A crash between two areas leaves a state nobody can name from the
         * filesystem alone: the project tree may be the new one while the provider
         * state is still the old, and the previous contents of whichever area was
         * promoted first exist only under `displaced-*`. Without a recovery that
         * proves what happened, a boot that continued would run an agent against a
         * mixed tree, and a boot that swept would delete the only copy.
         */
        let staging: 'clear' | 'unresolved';
        try {
            staging = await deps.inspectRestoreStaging();
        } catch {
            staging = 'unresolved';
        }
        if (staging !== 'clear') return { ok: false, reason: 'restore-unresolved' };

        /*
         * Observed once, here, while this process is still the trusted one.
         *
         * The daemon reads the same binding later for its own facts; what this run
         * adds is that whoever configures the supervisor gets the *observed* uuid
         * rather than a value copied from the parent's description.
         */
        try {
            const sealed = await deps.observeVolume({
                stateDir,
                providerVolumeId: identity.identity.providerVolumeId,
                deps: provisioning,
            });
            volume = sealed.ok ? sealed.binding : null;
        } catch {
            // An observation that failed is an absent observation, never a guess.
            volume = null;
        }

        /*
         * Last, and only here.
         *
         * Every observation that can still refuse this boot — restore, the two
         * assignments, the staging check, the volume — has already happened. A
         * record published earlier would name a supervisor this boot then declined
         * to make ready.
         *
         * No arguments: the boot chooses the moment, not the contents. The
         * refusal is a boot failure and **nothing is rolled back** — `promote`
         * leaves the previous file and `durability-unknown` has already made the
         * new one visible, and pretending to undo either would be a lie about the
         * bytes on disk.
         */
        const attested = started.publishAttestation();
        switch (attested) {
            case 'published':
                break;
            case 'refused-not-current':
            case 'refused-no-scope':
            case 'refused-write:untrusted':
            case 'refused-write:schema':
            case 'refused-write:too-large':
            case 'refused-write:temporary-exists':
            case 'refused-write:staged':
            case 'refused-write:promote':
            case 'refused-write:durability-unknown':
                logger.debug(`[managed] supervisor attestation refused (${attested})`);
                return { ok: false, reason: 'attestation-unpublishable' };
        }
        // A new writer stage must be handled above before this boot can compile.
        attested satisfies 'published';

        return {
            ok: true,
            socketPath,
            published: published.wrote,
            volume,
            checkpointTicks: started.checkpointTicks ?? null,
        };
    };
    let outcome: ManagedRuntimeBootOutcome;
    try { outcome = await runOwnedBootBody(); }
    catch { outcome = { ok: false, reason: 'supervisor-unavailable', detail: 'boot-threw' }; }
    if (outcome.ok && owner.state !== 'taken') {
        outcome = { ok: false, reason: 'supervisor-unavailable', detail: 'ownership-not-taken' };
    }
    if (!outcome.ok && owner.state === 'taken') {
        let stopped = false;
        try { stopped = owner.runtime !== null && (await owner.runtime.stop()).stopped === true; }
        catch { /* A thrown cleanup is unproven, never a release instruction. */ }
        if (!stopped) outcome = { ...outcome, detail: 'supervisor-stop-unproven' };
    }
    if (owner.state === 'boot-owned') {
        owner.state = 'released';
        try { await release(); }
        catch { outcome = { ok: false, reason: 'supervisor-unavailable', detail: 'ownership-release-failed' }; }
    }
    return outcome;
}

/** Where the image installs the trusted executables. Not configurable. */
const HELPER_PATH = '/usr/local/lib/saycode/exec-helper';
const WORKLOAD_PATH = '/usr/local/lib/saycode/node';

/** The lease watchdog's tick, and how long a prepared launch may sit unclaimed. */
const WATCHDOG_INTERVAL_MS = 1_000;
const RELEASE_DEADLINE_MS = 30_000;

/**
 * How long a shutdown may wait for a checkpoint already in flight.
 *
 * An operational bound of this runtime, the same kind as the two above — not a
 * policy the parent sets, and deliberately not read from the marker: the marker
 * says how often to checkpoint, not how patient this process is while being
 * stopped. An upload mid-flight is worth waiting for, because the alternative is
 * an archive on the store with no pointer at it; waiting without a bound would
 * mean a hung upload holds the machine's stop open.
 */
const CHECKPOINT_SHUTDOWN_WAIT_MS = 30_000;

/**
 * How long the quiescence gate gives one generation to end its input and leave.
 *
 * The same class of runtime-local bound as the two above, and deliberately not
 * read from the marker: `checkpoint.drainBudgetMs` is how long a checkpoint
 * waits for **tool** writes to finish, which is a different wait on a different
 * writer, and reusing it would make one number mean two things. Exceeding this
 * is not a failure — the gate answers `eof-unverified` and the next tick asks
 * again.
 */
const PROVIDER_END_INPUT_BUDGET_MS = 30_000;

/**
 * Makes a directory root-owned at an exact mode, and refuses anything it did
 * not make safe.
 *
 * `mkdir`'s mode argument is masked by the process umask, so it is set again
 * explicitly — a `0700` that silently became `0755` is a socket directory the
 * agent can list, and later replace entries in. An existing path that is a
 * symlink is refused rather than followed: following it would apply root
 * ownership and a permissive-looking mode to whatever it points at.
 */
function makeTrustedDirectorySync(path: string, mode: number): void {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) throw new Error('trusted directory path is a symlink');
    mkdirSync(path, { recursive: true, mode });
    chmodSync(path, mode);
    chownSync(path, 0, 0);
}

/**
 * Hands a tree to the uid that will write in it.
 *
 * Recursive, and deliberately: a restored volume has directories under the
 * project root, and an agent that owns only the top level cannot write inside
 * them. Symlinks are changed with `lchown` semantics — never followed — so a
 * link planted in a restored tree cannot be used to give the agent something
 * outside the workspace.
 */
export function assignTreeSync(
    path: string,
    uid: number,
    gid: number,
    /** Injected so a test can see which paths the walk reaches. */
    chown: (target: string, uid: number, gid: number) => void = chownSync,
): void {
    const stat = lstatSync(path);
    // `chownSync` follows symlinks; `lchownSync` does not, and a link's own
    // ownership is not what governs its target anyway.
    if (stat.isSymbolicLink()) return;
    chown(path, uid, gid);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) assignTreeSync(join(path, entry), uid, gid, chown);
}

/**
 * The real boot: a **separate root supervisor process's** runtime, started
 * here and left running. The token comes from the IPC server it creates —
 * nothing in this file chooses it, so nothing in this file can weaken it.
 */
export function defaultManagedRuntimeBootDeps(
    /** Injected so a test can observe which paths ownership actually reaches. */
    chown: (target: string, uid: number, gid: number) => void = chownSync,
    /** Injected so a test can point the staging check at a real directory. */
    stagingRoot: string = MANAGED_RESTORE_STAGING_ROOT,
): ManagedRuntimeBootDeps {
    return {
        acquireOwnership: async (scope) => {
            const captured = { ...scope };
            const lock = await acquireSupervisorLock(captured);
            return lock.ok ? { ok: true, ownership: { scope: captured, address: lock.address, release: lock.release } } : lock;
        },
        inspectRestoreStaging: async () => inspectRestoreStagingSync(stagingRoot),
        /*
         * The provider writes these into the guest's environment. They are
         * identifiers, not credentials: knowing them lets nothing be done.
         */
        narrowDeliveredCredential: () =>
            narrowDeliveredCredentialMode(MANAGED_DAEMON_CREDENTIAL_INPUT_PATH),
        readDeliveredMachineId: (input) => readDeliveredMachineId(input),
        observeVolume: async (input) => {
            const outcome = await resolveManagedVolumeBinding({
                stateDir: input.stateDir,
                providerVolumeId: input.providerVolumeId,
                observe: () => observeManagedVolume({ projectRoot: MANAGED_PROJECT_ROOT }),
                deps: input.deps,
            });
            return outcome.ok ? { ok: true, binding: outcome.binding } : { ok: false };
        },
        providerInstance: () => ({
            providerMachineId: process.env.FLY_MACHINE_ID?.trim() || null,
            // The machine's version — what the Machines API calls `instance_id`
            // and what the parent recorded at creation. FLY_ALLOC_ID is the
            // machine id again, not the instance.
            providerInstanceId: process.env.FLY_MACHINE_VERSION?.trim() || null,
        }),
        writeMarker: async (input) => {
            const { writeManagedMarker } = await import('@/managed/managedMarkerWriter');
            const outcome = await writeManagedMarker(input);
            if (outcome.status === 'not-managed') return { status: 'not-managed' };
            if (outcome.status === 'refused') {
                // 코드만 옮긴다. `detail` 은 경로를 담을 수 있어 여기서 멈춘다.
                return { status: 'refused', reason: outcome.reason };
            }
            return { status: outcome.status };
        },
        // Narrowing happens once, at the top of the boot; the reader here stays
        // strict, so a narrowing that did not happen is still a refusal rather
        // than an assumption.
        adoptCredential: (input) => adoptManagedDaemonCredential(input),
        makeTrustedDirectory: async (path, mode) => { makeTrustedDirectorySync(path, mode); },
        ensureProjectRoot: async (path) => { makeTrustedDirectorySync(path, 0o755); },
        /*
         * Read from the image's own databases, as root. Not a marker field: a
         * required marker axis needs the parent's composer, every fixture on both
         * sides and an answer for machines already provisioned without it.
         */
        resolveDaemonAccount: () => {
            const read = (path: string): string | null => {
                try {
                    return readFileSync(path, 'utf8');
                } catch {
                    return null;
                }
            };
            const outcome = resolveManagedDaemonAccount({
                readPasswd: () => read('/etc/passwd'),
                readGroup: () => read('/etc/group'),
            });
            if (!outcome.ok) {
                // 분류자만. 데이터베이스 내용은 로그에 싣지 않는다.
                logger.debug(`[managed] daemon account unusable: ${outcome.detail}`);
                return null;
            }
            return outcome.account;
        },
        provisionDaemonStateLeaf: async ({ path, uid, gid, mode }) => {
            /*
             * 만들거나, 이미 있는 것을 **확인**한다. 고치지 않는다.
             */
            let stat: ManagedDaemonLeafStat;
            try {
                const found = lstatSync(path);
                if (found.isSymbolicLink()) stat = { kind: 'symlink' };
                else if (!found.isDirectory()) stat = { kind: 'file' };
                else stat = { kind: 'dir', uid: found.uid, gid: found.gid, mode: found.mode };
            } catch (error) {
                stat = (error as NodeJS.ErrnoException).code === 'ENOENT'
                    ? { kind: 'absent' }
                    : { kind: 'unreadable' };
            }
            const decision = inspectManagedDaemonStateLeaf(stat, { uid, gid }, mode);
            if (!decision.ok) return decision;
            if (!decision.create) return { ok: true, created: false };
            /*
             * 새로 만들 때만 소유자를 정한다. `recursive` 는 쓰지 않는다 — 부모는
             * 이미 root 가 만든 것이고, 없는 부모를 여기서 만들면 그 부모의 소유권을
             * 아무도 확인하지 않은 채 갖게 된다.
             */
            mkdirSync(path, { mode });
            chmodSync(path, mode);
            chownSync(path, uid, gid);
            return { ok: true, created: true };
        },
        assignWorkspace: async ({ path, uid, gid }) => { assignTreeSync(path, uid, gid, chown); },
        assignAuthHomeRoot: async ({ path, mode }) => {
            const existing = lstatSync(path, { throwIfNoEntry: false });
            if (existing?.isSymbolicLink()) throw new Error('auth home root path is a symlink');
            if (existing && !existing.isDirectory()) throw new Error('auth home root path is not a directory');
            // `mkdir`'s mode is masked by the umask, so it is set again: a
            // `0711` that silently became `0755` is a directory the agent can
            // list, and what it would list is who has logged in here.
            mkdirSync(path, { recursive: true, mode });
            chmodSync(path, mode);
            // The root only — never the tree. What is inside belongs to the
            // provider uid, and re-owning it would take every login already
            // there away from the process that has to read it.
            chown(path, 0, 0);
        },
        assignProviderHome: async ({ path, uid, gid, mode }) => {
            const existing = lstatSync(path, { throwIfNoEntry: false });
            if (existing?.isSymbolicLink()) throw new Error('provider home path is a symlink');
            mkdirSync(path, { recursive: true, mode });
            chmodSync(path, mode);
            /*
             * The **tree**, not just the directory.
             *
             * A restore promotes this area as root, so what lands inside it —
             * `sessions/`, the provider's native state database — arrives
             * root-owned. Owning only the top level lets the provider create new
             * files and read none of the ones it is being given back, which is
             * the failure that looks like "the session is empty" rather than
             * like a permissions bug.
             */
            assignTreeSync(path, uid, gid, chown);
        },
        startSupervisor: async ({
            identity, markerSha256, socketPath, token, observedVolume, serverOrigin, ownership,
        }) => {
            /*
             * Where parent-issued checkpoint targets wait.
             *
             * Created here, in the process that hosts the supervisor, because
             * that is where the checkpoint session lives — the drain it shares
             * with the tool session is the same object. The daemon receives the
             * `managed:checkpoint` RPC in **another process**, so reaching this
             * inbox from there needs a launcher verb; until that exists the
             * runtime accepts no pushed targets and `next()` answers null,
             * which the coordinator treats as an ordinary skip.
             */
            const checkpointTargets = createManagedCheckpointTargetInbox({
                now: Date.now,
                onExpired: ({ checkpointId }) => {
                    // Neither a failure nor an idle project: a target arrived,
                    // nobody used it, and it is gone. Said once, as a code.
                    logger.debug(`[managed] checkpoint target expired unused (${checkpointId})`);
                },
            });
            /*
             * 순서를 아는 한 곳. 게이트 참조가 합성보다 **먼저** 있어야 하므로
             * 여기서 만든다 — 합성이 만드는 drain 을 게이트가 관측하기 때문에
             * 반대 순서는 성립하지 않는다.
             */
            const checkpointing = createManagedRuntimeCheckpointing({
                shutdownWaitMs: CHECKPOINT_SHUTDOWN_WAIT_MS,
                endInputBudgetMs: PROVIDER_END_INPUT_BUDGET_MS,
                onTick: ({ trigger, kind, reason, detail }) => {
                    /*
                     * 고정 분류자만. `reason` 과 `detail` 둘 다 닫힌 집합을 통과한
                     * 값이고, 알 수 없는 실패 코드는 `unclassified` 로 바뀌어
                     * 도착한다 — 그래서 여기서 다시 걸러내지 않는다.
                     *
                     * 이유를 실어야 하는 까닭: `provider-state-unproven` 도
                     * `failed` 도 그 값 없이는 행동할 수 없다. 첫 실측이 정확히
                     * 그 두 줄에서 막혔다.
                     */
                    const because = [reason, detail].filter((part) => part !== undefined).join('/');
                    logger.debug(`[managed] checkpoint tick ${trigger}: ${kind}${because ? ` (${because})` : ''}`);
                },
                /*
                 * 시작도 남긴다. 이것이 없으면 "무장 안 됨", "걸림", "거절됨" 이
                 * 전부 같은 침묵이다 — 실제로 그 세 상태를 구분할 수 없었다.
                 */
                onTickStart: ({ trigger }) => {
                    logger.debug(`[managed] checkpoint tick ${trigger}: started`);
                },
                /*
                 * 무장 여부를 한 줄로 남긴다. tick 로그는 tick 이 **일어날 때만**
                 * 나오므로, 그것이 하나도 없을 때 "아직 안 돌았다" 와 "소비자가
                 * 없다" 를 구분할 수 있는 것은 이 줄뿐이다. 주기는 marker 의 값이고
                 * 비밀이 아니다.
                 *
                 * 콜백으로 넘긴다 — 직접 부르면 이 줄의 실패가 부팅을 되돌린다.
                 */
                onArmed: ({ intervalMs }) => {
                    logger.debug(intervalMs === null
                        ? '[managed] checkpoint consumer not armed: no schedule in the marker'
                        : `[managed] checkpoint consumer armed at ${intervalMs}ms`);
                },
            });
            const composition = defaultManagedRunConfig({
                identity,
                /*
                 * 저장된 credential 이 말하는 서버. 위에서 못 읽었으면 이미
                 * 부팅을 거절했으므로, 여기 오는 값은 항상 그 축이다 —
                 * 프로세스 기본값이 자식 환경으로 내려가는 길은 없다.
                 */
                serverOrigin,
                // 두 상한 다 marker 에서 온다. 여기서 만들지 않는다.
                policy: {
                    ttlMs: identity.toolPolicy.grantTtlMs,
                    toolTimeoutMs: identity.toolPolicy.callTimeoutMs,
                },
                onUnprovenTermination: ({ tool, detail }) => {
                    // 고정 분류자만. 도구 이름과 코드는 값이 아니다.
                    logger.debug(`[managed] unproven termination from ${tool}${detail ? ` (${detail})` : ''}`);
                },
                checkpoint: {
                    // 봉인 재료. marker 가 나르고 runtime 이 지어내지 않는다.
                    tenant: { tenantId: identity.tenant, projectId: identity.projectId },
                    volume: observedVolume,
                    drainBudgetMs: identity.checkpoint.drainBudgetMs,
                    targets: checkpointTargets,
                    policy: identity.checkpointSchedule,
                    providerQuiescence: checkpointing.gate,
                },
            });
            /*
             * 부모가 서명한 runtime lease 진술을 기록하는 자리.
             *
             * **권한이 아니다.** 집행 완료도, commit 도, 현재 권위도 아니다 —
             * 부모가 그때 그렇게 서명했다는 사실뿐이고, 뒤따르는 fan-out 이나
             * writeLease 는 여전히 실패할 수 있다. 현재 epoch 을 지어내지 않으며
             * 비교 대상은 자기 자신의 이전 스냅샷이다.
             */
            const runtimeGrants = createManagedRuntimeGrantSnapshot({
                authority: {
                    verifier: identity.verifier,
                    runtimeId: identity.runtimeId,
                    workspaceId: identity.workspaceId,
                    projectId: identity.projectId,
                    keyId: identity.keyId,
                    provisioningOperationId: identity.provisioningOperationId,
                },
                now: Date.now,
                monotonicNow: () => Number(process.hrtime.bigint() / 1_000_000n),
            });
            // The outer boot is this runtime's only production stop caller and awaits
            // this factory. It cannot stop during the helper's arm-to-capture interval.
            // A pre-arm failure leaves null; later boot refusal sees the actual loop.
            let checkpointTicks: ManagedCheckpointTickLoop | null = null;
            const runtime = createSupervisorRuntime({
                acquireLock: ownership.take,
                stopCheckpointWork: () => checkpointTicks?.stop() ?? Promise.resolve({ pendingPublication: false }),
                managedRun: composition.managedRun,
                /*
                 * daemon 이 socket 으로 건네는 target 이 도착하는 자리.
                 *
                 * **`composition` 이 읽는 것과 같은 객체**다 — 바로 위에서
                 * 만들어 두 자리에 함께 넘긴다. 둘이 다른 객체이면 부모는 자격이
                 * 자리 잡았다고 믿고 runtime 은 영원히 빈 손이며, 그 차이는 이
                 * 함수 안에서만 보이므로 한 곳에서 만들어 함께 넘긴다.
                 */
                /*
                 * 이 supervisor 가 **이 소켓의 그 인스턴스**임을 스스로 기록하는
                 * 데 필요한 축. digest 는 marker 를 읽은 그 바이트의 것이고,
                 * 여기서 다시 구하지 않는다. 조상 신뢰 판정은 발행 시점에
                 * writer 가 실제 관측으로 한다.
                 */
                attestation: {
                    stateDir: identity.stateDir,
                    provisioningOperationId: identity.provisioningOperationId,
                    markerSha256,
                },
                acceptCheckpointTarget: (target, receipt) => checkpointTargets.accept(target, receipt),
                /*
                 * 부모가 이 문서를 발급했는지를 **이 프로세스의 marker 로** 세운다.
                 *
                 * daemon 의 검증은 그 hop 에서 끝난다. 여기는 다른 프로세스이고,
                 * root 소유 marker 와 검증키를 쥐고 있으므로 서명을 직접 본다 —
                 * 그것이 없으면 relay 된 문서는 출처 없는 업로드 목적지 묶음이다.
                 *
                 * 세대 원장은 실행 의도이지 권한이 아니므로 현재 epoch 으로 쓰지
                 * 않는다. 토큰의 epoch 은 **부모가 서명한 사실**로 receipt 에
                 * 기록될 뿐, 어떤 검증기에도 되먹이지 않는다.
                 */
                admitRuntimeGrant: (request) => runtimeGrants.admit(request),
                clearRuntimeGrant: () => runtimeGrants.clear(),
                authenticateCheckpointTarget: (request) => {
                    const result = authenticateManagedCheckpointTarget({
                        ...request,
                        authority: {
                            verifier: identity.verifier,
                            runtimeId: identity.runtimeId,
                            workspaceId: identity.workspaceId,
                            projectId: identity.projectId,
                            keyId: identity.keyId,
                            provisioningOperationId: identity.provisioningOperationId,
                        },
                        now: Date.now(),
                    });
                    if (!result.ok) {
                        // 닫힌 분류 하나만 남긴다 — 어느 축에서 틀렸는지는 토큰을
                        // 쥔 쪽이 알아낼 정보이고, 목적지와 키는 어디에도 남기지
                        // 않는다.
                        logger.debug('[managed] checkpoint target not authenticated');
                        return { ok: false, reason: 'unauthenticated' };
                    }
                    return { ok: true, receipt: result.receipt };
                },
                config: {
                    cgroupRoot: identity.isolation.cgroupRoot,
                    helperPath: HELPER_PATH,
                    workloadPath: WORKLOAD_PATH,
                    // One uid for every generation on this runtime: the marker
                    // names it, and reuse discipline is the provisioner's.
                    // The generation is the **provider**: this is the process
                    // the supervisor launches and fences. The executor's uid is
                    // applied by the tool session, per call, and never here.
                    resolveGenerationCredentials: () => ({
                        uid: identity.isolation.provider.uid,
                        gid: identity.isolation.provider.gid,
                    }),
                },
                manifestRoot: join(identity.stateDir, 'manifest'),
                stagingRoot: join(identity.stateDir, 'staging'),
                socketPath,
                watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
                releaseDeadlineMs: RELEASE_DEADLINE_MS,
                runtimeId: identity.runtimeId,
                // The token a previous boot published, when there is one. The
                // supervisor mints its own only on a first boot; a restart that
                // minted again would publish a token the write-once record
                // refuses, and the runtime would never come back.
                ...(token ? { token } : {}),
            });
            /*
             * `start()` → `reconcile()` → 게이트 → tick 이 한 함수 안에 있다.
             * 이 자리는 root 권한과 실제 cgroup 이 있어야 도는 코드라 여기서는
             * 시험할 수 없고, 그래서 그 순서를 시험할 수 있는 곳으로 옮겼다
             * (`managedRuntimeCheckpointing.test.ts`).
             *
             * `composition.checkpoint` 의 inbox 는 위에서 `acceptCheckpointTarget`
             * 에 넘긴 **그** 객체이고, 게이트가 관측하는 drain 은 그 합성이 만든
             * 바로 그 drain 이다.
             */
            ownership.registerRuntime({ stop: () => runtime.stop() });
            checkpointTicks = await checkpointing.startAfterSupervisor({
                runtime,
                checkpoint: composition.checkpoint,
                schedule: identity.checkpointSchedule,
            });
            return {
                token: runtime.token,
                checkpointTicks,
                // Bound to this runtime, taking nothing: the boot picks the
                // moment, the supervisor owns the contents.
                publishAttestation: () => runtime.publishAttestation(),
            };
        },
    };
}

/**
 * Whether anything is left under the restore staging root.
 *
 * Deliberately blunt: **any** entry means `unresolved`. Not `displaced-*` only
 * — a journal, a partially written manifest, a lock, a name this code has never
 * heard of, all of them say the same thing, which is that a promotion did not
 * finish and nothing here can prove what state the areas are in. Matching a
 * naming convention would answer "clear" for exactly the leftovers nobody
 * anticipated, which are the ones worth stopping for.
 *
 * Nothing is deleted, moved or repaired. An interrupted promotion can leave the
 * only copy of a destination's previous contents in here, so a sweep is data
 * loss and a silent one. The recovery that can prove what happened is a
 * separate, deliberate act; this only decides whether the runtime may serve
 * work in the meantime.
 *
 * Every failure to look is `unresolved`. A staging root that cannot be read, is
 * a symlink, or is not a directory is not evidence of absence.
 */
export function inspectRestoreStagingSync(root: string): 'clear' | 'unresolved' {
    let stat;
    try {
        stat = lstatSync(root, { throwIfNoEntry: false });
    } catch {
        return 'unresolved';
    }
    // Never staged, or already cleared by a recovery that finished.
    if (!stat) return 'clear';
    // A symlink here is somebody redirecting the check away from the real
    // staging area; a plain file is a state this code cannot account for.
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unresolved';
    try {
        return readdirSync(root).length === 0 ? 'clear' : 'unresolved';
    } catch {
        return 'unresolved';
    }
}

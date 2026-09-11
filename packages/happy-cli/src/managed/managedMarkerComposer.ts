/**
 * Turning the parent's boot input into the marker this runtime is judged by.
 *
 * The marker is the trust anchor: `resolveManagedRuntimeIdentity` reads it and
 * every readiness answer, receipt and fencing decision downstream is made in
 * the terms it sets. So the question this module answers is narrow and
 * important — **which of those terms may this machine supply for itself?**
 *
 * The answer is: none of the ones that identify it.
 *
 *  - The workspace, project, runtime, operation, config digest, state and
 *    workspace directories, the two uids, the cgroup root, the volume id and
 *    the verifier's public key all come from the **boot input file the parent
 *    placed into the machine at creation** (`config.files[]`: a known guest
 *    path with a base64 `raw_value`). A machine that filled any of them in
 *    would be answering a question about itself with its own claim.
 *
 *    A file, not a metadata lookup, and deliberately. Reading machine metadata
 *    from inside the guest means holding a provider API credential — one that
 *    can create, stop and inspect every machine in the app — in order to learn
 *    what the parent already knew when it created this one. The file carries
 *    exactly this machine's input and needs no credential at all. The same
 *    values also go out as machine metadata from the same producer, but that
 *    copy exists for the parent's ownership checks on the provider side.
 *  - The provider machine and instance ids come from what the machine can
 *    observe about itself, and they are the only axes where that is correct:
 *    they say *which instance is running*, which nothing else can know.
 *  - The Happy machine id comes from the bootstrap grant, because it is an
 *    address that only the server can issue.
 *
 * Nothing here has a default. A missing axis is a refusal, not a blank to fill:
 * the marker with an invented state directory is a marker that puts the receipt
 * store somewhere the agent can write, and the marker with an invented uid is
 * one that hands the workspace to the provider.
 *
 * This module composes and validates. Writing it down — once, root-owned,
 * never overwritten — is `writeManagedMarker`'s job in the boot stage.
 */
export type ManagedMarkerRecord = {
    runtimeId: string;
    workspaceId: string;
    projectId: string;
    keyId: string;
    happyMachineId: string;
    provisioningOperationId: string;
    configDigest: string;
    providerMachineId: string;
    providerInstanceId: string;
    providerVolumeId: string;
    stateDir: string;
    workspaceDir: string;
    verifierPublicKey: string;
    isolation: {
        backend: string;
        provider: { uid: number; gid: number };
        executor: { uid: number; gid: number };
        cgroupRoot: string;
    };
    /**
     * The ceilings the parent approved for this runtime's tool use.
     *
     * `grantTtlMs` bounds a broker grant — the window in which this run may use
     * tools at all — and is tightened again at launch to what is left of the
     * write lease, because a grant may not outlive the right to write.
     * `callTimeoutMs` bounds one invocation.
     */
    toolPolicy: { grantTtlMs: number; callTimeoutMs: number };
    /**
     * How long a checkpoint waits for writes already in flight before it seals.
     *
     * Execution control, like the two ceilings above, and for the same reason
     * it is not an image constant: it varies by workspace and plan. A
     * checkpoint that sealed after a budget nobody approved would either cut
     * writes that were still landing or hold the runtime for a window nobody
     * chose.
     */
    checkpoint: { drainBudgetMs: number };
    /**
     * The tenant this runtime's work belongs to (`company:<id>` / `user:<id>`).
     *
     * Not a label. The checkpoint archive binds it into the AEAD's additional
     * data alongside the project and the area, so an archive sealed under one
     * tenant does not open under another — which is also why it cannot be
     * derived here from anything the runtime knows, and why a runtime without
     * it does not activate.
     */
    tenant: string;
    /**
     * How often this runtime checkpoints, and whether the end of a turn is
     * itself a reason.
     *
     * A policy, so it arrives rather than being invented: a period nobody
     * approved seals the volume on a cadence nobody chose, and quietly taking
     * none at all leaves the user believing their work is being saved while
     * nothing is. `failureBackoffMs` is optional because the scheduler has a
     * documented behaviour without one — absent means that behaviour, not a
     * number made up here.
     */
    checkpointSchedule: { periodMs: number; onTurnBoundary: boolean; failureBackoffMs?: number };
};

export type ManagedMarkerRefusal =
    /** The provider recorded no managed metadata: this is not a managed machine. */
    | 'not-managed'
    | 'metadata-incomplete'
    | 'uid-not-separated'
    | 'instance-unidentified'
    | 'happy-address-missing';

export type ManagedMarkerOutcome =
    | { ok: true; record: ManagedMarkerRecord }
    | { ok: false; reason: ManagedMarkerRefusal };

/** The keys the parent writes into the boot input (and into metadata). */
const KEYS = {
    workspace: 'saycode_workspace',
    project: 'saycode_project',
    runtime: 'saycode_runtime',
    operation: 'saycode_operation',
    configDigest: 'saycode_config_digest',
    backend: 'saycode_isolation_backend',
    providerUid: 'saycode_provider_uid',
    providerGid: 'saycode_provider_gid',
    executorUid: 'saycode_executor_uid',
    executorGid: 'saycode_executor_gid',
    cgroupRoot: 'saycode_cgroup_root',
    verifierKeyId: 'saycode_verifier_key',
    verifierPublicKey: 'saycode_verifier_public_key',
    stateDir: 'saycode_state_dir',
    workspaceDir: 'saycode_workspace_dir',
    volume: 'saycode_volume',
    /**
     * How long one broker grant may live, and how long one tool call may run.
     *
     * Two different ceilings, and the names say which: a *grant* is the window
     * this run may use tools at all, a *call* is a single invocation. The
     * parent decides both — they vary by workspace and plan, and re-baking an
     * image to change a timeout is not a deployment story.
     */
    toolGrantTtlMs: 'saycode_tool_grant_ttl_ms',
    toolCallTimeoutMs: 'saycode_tool_call_timeout_ms',
    /** How long a checkpoint waits for writes in flight before it seals. */
    checkpointDrainBudgetMs: 'saycode_checkpoint_drain_budget_ms',
    /** `company:<id>` or `user:<id>`. Sealing material, not a label. */
    tenant: 'saycode_tenant',
    /** How often a running runtime checkpoints, and whether a turn ends one. */
    checkpointPeriodMs: 'saycode_checkpoint_period_ms',
    checkpointOnTurnBoundary: 'saycode_checkpoint_on_turn_boundary',
} as const;

/**
 * The one optional axis, named apart from `KEYS`.
 *
 * `KEYS` is the "all of these or this is not a managed machine" set, and the
 * `not-managed` check reads it — putting an optional key in there would make a
 * machine that omits it look unmanaged rather than managed-without-a-backoff.
 */
const OPTIONAL_KEYS = {
    checkpointFailureBackoffMs: 'saycode_checkpoint_failure_backoff_ms',
} as const;

function text(metadata: Record<string, string | undefined>, key: string): string | null {
    const value = metadata[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A uid or gid as the parent wrote it: a decimal, unprivileged, whole. */
function id(metadata: Record<string, string | undefined>, key: string): number | null {
    const raw = text(metadata, key);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function composeManagedMarker(input: {
    /**
     * The parsed boot input the parent placed at the known guest path. Reading
     * that path safely is the boot stage's job; what the values may be is here.
     */
    metadata: Record<string, string | undefined>;
    /** What the machine can observe about which instance it is. */
    instance: { providerMachineId: string | null; providerInstanceId: string | null };
    /** The address the bootstrap grant issued. Only the server can mint it. */
    happyMachineId: string | null;
}): ManagedMarkerOutcome {
    const { metadata } = input;
    // No managed metadata at all is an ordinary machine, not a broken one.
    if (Object.keys(KEYS).every((name) => text(metadata, KEYS[name as keyof typeof KEYS]) === null)) {
        return { ok: false, reason: 'not-managed' };
    }

    const strings = {
        workspaceId: text(metadata, KEYS.workspace),
        projectId: text(metadata, KEYS.project),
        runtimeId: text(metadata, KEYS.runtime),
        provisioningOperationId: text(metadata, KEYS.operation),
        configDigest: text(metadata, KEYS.configDigest),
        backend: text(metadata, KEYS.backend),
        cgroupRoot: text(metadata, KEYS.cgroupRoot),
        keyId: text(metadata, KEYS.verifierKeyId),
        verifierPublicKey: text(metadata, KEYS.verifierPublicKey),
        stateDir: text(metadata, KEYS.stateDir),
        workspaceDir: text(metadata, KEYS.workspaceDir),
        providerVolumeId: text(metadata, KEYS.volume),
        tenant: text(metadata, KEYS.tenant),
    };
    const numbers = {
        providerUid: id(metadata, KEYS.providerUid),
        providerGid: id(metadata, KEYS.providerGid),
        executorUid: id(metadata, KEYS.executorUid),
        executorGid: id(metadata, KEYS.executorGid),
        // Positive integers, and no default. A runtime that booted with an
        // invented tool ceiling would be running under a policy nobody
        // approved; refusing is the honest answer, and the parent can see it.
        toolGrantTtlMs: id(metadata, KEYS.toolGrantTtlMs),
        toolCallTimeoutMs: id(metadata, KEYS.toolCallTimeoutMs),
        checkpointDrainBudgetMs: id(metadata, KEYS.checkpointDrainBudgetMs),
        checkpointPeriodMs: id(metadata, KEYS.checkpointPeriodMs),
    };
    /*
     * `'true'` / `'false'` and nothing else.
     *
     * Not "anything truthy": a value the parent did not mean — `'yes'`, `'1'`,
     * an empty string — would be read as a decision nobody made, and this one
     * decides whether every turn ends in an archive.
     */
    const onTurnBoundaryRaw = text(metadata, KEYS.checkpointOnTurnBoundary);
    const onTurnBoundary = onTurnBoundaryRaw === 'true'
        ? true
        : onTurnBoundaryRaw === 'false' ? false : null;
    // Optional, but not lax: present and unreadable is a refusal, because the
    // parent meant *something* and this runtime cannot tell what.
    const backoffRaw = text(metadata, OPTIONAL_KEYS.checkpointFailureBackoffMs);
    const failureBackoffMs = backoffRaw === null
        ? undefined
        : id(metadata, OPTIONAL_KEYS.checkpointFailureBackoffMs);
    if (onTurnBoundary === null || failureBackoffMs === null) {
        return { ok: false, reason: 'metadata-incomplete' };
    }
    if (Object.values(strings).some((value) => value === null)
        || Object.values(numbers).some((value) => value === null)) {
        return { ok: false, reason: 'metadata-incomplete' };
    }
    // The same rule the marker reader applies, applied before the file exists:
    // one uid for both roles lets the executor read the provider's environment
    // and descriptors, and a marker written that way would never activate.
    if (numbers.providerUid === numbers.executorUid) {
        return { ok: false, reason: 'uid-not-separated' };
    }

    const providerMachineId = input.instance.providerMachineId?.trim() ?? '';
    const providerInstanceId = input.instance.providerInstanceId?.trim() ?? '';
    if (providerMachineId === '' || providerInstanceId === '') {
        return { ok: false, reason: 'instance-unidentified' };
    }
    const happyMachineId = input.happyMachineId?.trim() ?? '';
    if (happyMachineId === '') return { ok: false, reason: 'happy-address-missing' };

    return {
        ok: true,
        record: {
            runtimeId: strings.runtimeId!,
            workspaceId: strings.workspaceId!,
            projectId: strings.projectId!,
            keyId: strings.keyId!,
            happyMachineId,
            provisioningOperationId: strings.provisioningOperationId!,
            configDigest: strings.configDigest!,
            providerMachineId,
            providerInstanceId,
            providerVolumeId: strings.providerVolumeId!,
            stateDir: strings.stateDir!,
            workspaceDir: strings.workspaceDir!,
            verifierPublicKey: strings.verifierPublicKey!,
            toolPolicy: {
                grantTtlMs: numbers.toolGrantTtlMs!,
                callTimeoutMs: numbers.toolCallTimeoutMs!,
            },
            checkpoint: { drainBudgetMs: numbers.checkpointDrainBudgetMs! },
            tenant: strings.tenant!,
            checkpointSchedule: {
                periodMs: numbers.checkpointPeriodMs!,
                onTurnBoundary,
                ...(failureBackoffMs === undefined ? {} : { failureBackoffMs }),
            },
            isolation: {
                backend: strings.backend!,
                provider: { uid: numbers.providerUid!, gid: numbers.providerGid! },
                executor: { uid: numbers.executorUid!, gid: numbers.executorGid! },
                cgroupRoot: strings.cgroupRoot!,
            },
        },
    };
}

import {
    CheckpointExclusionGuard,
    resolveCheckpointProtectionCapability,
    type CheckpointExclusionPolicy,
    type CheckpointProvider,
} from './checkpointExclusionPolicy';
import {
    CheckpointLedger,
    type CheckpointLedgerMutationRequest,
    type CheckpointLedgerRecord,
} from './checkpointLedger';
import {
    CheckpointStore,
    type CheckpointSnapshotResult,
    type CheckpointStoreBinding,
} from './checkpointStore';

export type CheckpointRuntimeBinding = Omit<CheckpointStoreBinding, 'checkpointRoot'>;

export type CheckpointRuntimeProtection = Omit<CheckpointExclusionPolicy, 'projectPath'>;

export type CheckpointRuntimeInput = {
    provider: CheckpointProvider;
    platform: NodeJS.Platform;
    projectPath: string;
    checkpointRoot: string;
    binding: CheckpointRuntimeBinding;
    protection: CheckpointRuntimeProtection | undefined;
};

type RuntimeMutation = Pick<
    CheckpointLedgerMutationRequest,
    'operationId' | 'mutationId' | 'path' | 'action'
>;

export type CheckpointRuntime =
    | { status: 'disabled' }
    | {
        status: 'unavailable';
        reason: 'unsupported-platform' | 'unsupported-provider';
    }
    | {
        status: 'protected';
        denyWritePaths: string[];
        excludedPaths: string[];
        excludedPatterns: string[];
        readOnlyPassthroughPaths: string[];
        excludedReason(path: string): 'secret' | 'ignored' | 'too-large' | 'file-limit' | 'total-size-limit' | null;
        beforeTurn(operationId: string): Promise<CheckpointSnapshotResult>;
        recordMutation(mutation: RuntimeMutation): Promise<CheckpointLedgerRecord>;
    };

export async function createCheckpointRuntime(
    input: CheckpointRuntimeInput,
): Promise<CheckpointRuntime> {
    if (!input.protection) return { status: 'disabled' };

    const capability = resolveCheckpointProtectionCapability(input);
    if (!capability.supported) {
        return { status: 'unavailable', reason: capability.reason };
    }

    const guard = await CheckpointExclusionGuard.create({
        projectPath: input.projectPath,
        ...input.protection,
    });
    const store = new CheckpointStore(input.checkpointRoot);
    const ledger = new CheckpointLedger(input.checkpointRoot);
    const binding = {
        ...input.binding,
        projectPath: input.projectPath,
    };

    return {
        status: 'protected',
        denyWritePaths: guard.manifest.denyWritePaths,
        excludedPaths: guard.manifest.excluded.map((entry) => entry.path),
        excludedPatterns: guard.secretPatterns,
        readOnlyPassthroughPaths: guard.manifest.readOnlyPassthroughPaths,
        excludedReason: (path) => guard.excludedReason(path),
        beforeTurn: (operationId) => guard.dispatchAfterPolicyCheck(() => store.snapshotTurn({
            ...binding,
            operationId,
            excludedPaths: guard.manifest.excluded
                .filter((entry) => entry.reason !== 'ignored')
                .map((entry) => entry.path),
            excludedPatterns: guard.secretPatterns,
        })),
        recordMutation: (mutation) => ledger.recordMutation({
            ...binding,
            ...mutation,
        }),
    };
}

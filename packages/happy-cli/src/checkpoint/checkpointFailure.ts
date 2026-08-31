import { CheckpointPolicyDriftError } from './checkpointExclusionPolicy';

export function describeCheckpointFailure(error: unknown): string | null {
    if (!(error instanceof CheckpointPolicyDriftError)) return null;
    return 'Checkpoint protection policy changed. Restart the sandbox or disable protection before retrying.';
}

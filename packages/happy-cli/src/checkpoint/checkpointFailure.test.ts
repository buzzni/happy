import { describe, expect, it } from 'vitest';
import { CheckpointPolicyDriftError } from './checkpointExclusionPolicy';
import { describeCheckpointFailure } from './checkpointFailure';

describe('describeCheckpointFailure', () => {
    it('requires sandbox restart or protection disable after policy drift', () => {
        expect(describeCheckpointFailure(new CheckpointPolicyDriftError())).toBe(
            'Checkpoint protection policy changed. Restart the sandbox or disable protection before retrying.',
        );
    });

    it('does not relabel unrelated provider failures', () => {
        expect(describeCheckpointFailure(new Error('provider crashed'))).toBeNull();
    });
});

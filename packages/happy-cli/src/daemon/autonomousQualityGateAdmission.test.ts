import { describe, expect, it, vi } from 'vitest';
import { AutonomousQualityGateAdmission } from './autonomousQualityGateAdmission';

describe('AutonomousQualityGateAdmission', () => {
    it('admits automation only while the session is idle', async () => {
        const admission = new AutonomousQualityGateAdmission();
        const send = vi.fn(async () => {});

        admission.setSessionIdle(false);
        await expect(admission.admitRepair(0, send)).resolves.toBe(false);
        admission.setSessionIdle(true);
        await expect(admission.admitRepair(0, send)).resolves.toBe(true);
        expect(send).toHaveBeenCalledOnce();
    });

    it('gives user input priority by invalidating admission and aborting active gate work', async () => {
        const admission = new AutonomousQualityGateAdmission();
        admission.setSessionIdle(true);
        const operation = admission.beginGateOperation();
        const send = vi.fn(async () => {});

        admission.noteUserInput();

        expect(operation.signal.aborted).toBe(true);
        expect(admission.inputEpoch).toBe(1);
        await expect(admission.admitRepair(operation.inputEpoch, send)).resolves.toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    it('rechecks the epoch after an asynchronous send before committing admission', async () => {
        const admission = new AutonomousQualityGateAdmission();
        admission.setSessionIdle(true);

        await expect(admission.admitRepair(0, async () => {
            admission.noteUserInput();
        })).resolves.toBe(false);
    });
});

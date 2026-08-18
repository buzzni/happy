import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRPC = vi.hoisted(() => vi.fn());

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions: vi.fn() },
}));

import { machineRecoverSession, machineResumeSession } from './ops';

describe('session recovery RPC transport', () => {
    beforeEach(() => {
        machineRPC.mockReset();
    });

    it('marks resume transport failures and applies a finite timeout', async () => {
        machineRPC.mockRejectedValue(new Error('operation has timed out'));

        await expect(machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'session-1',
        })).resolves.toEqual({
            type: 'error',
            code: 'RPC_TRANSPORT_ERROR',
            errorMessage: 'operation has timed out',
        });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'resume-happy-session',
            { sessionId: 'session-1', model: undefined, permissionMode: undefined },
            { timeoutMs: 15_000 },
        );
    });

    it('marks recover transport failures so the pending message can be queued', async () => {
        machineRPC.mockRejectedValue(new Error('Socket not connected'));

        await expect(machineRecoverSession({
            machineId: 'machine-1',
            sessionId: 'session-1',
            initialPrompt: 'keep this message',
        })).resolves.toEqual({
            type: 'error',
            code: 'RPC_TRANSPORT_ERROR',
            errorMessage: 'Socket not connected',
        });
    });
});

import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { deliverAutomationConversationMessage } from './automationConversationDelivery';

it('withholds both replay data and new writes for protected conversation targets', async () => {
    const session = { id: 'protected', accountId: 'owner', piiProtection: true };
    const lookup = vi.fn(async ({ where }) =>
        where.id === session.id && where.accountId === session.accountId
        && (where.piiProtection === undefined || where.piiProtection === session.piiProtection) ? session : null);
    const replay = vi.fn(async () => ({ id: 'private-message', content: 'private-ciphertext' }));
    const tx = {
        automationRun: { findFirst: vi.fn(async () => ({
            id: 'run', sessionId: 'protected', automation: { payloadVersion: 4 },
        })) },
        session: { findFirst: lookup },
        sessionMessage: { findUnique: replay, create: vi.fn() },
    };
    const result = await deliverAutomationConversationMessage(tx as never, 'owner', 'pc', {
        runId: 'run', claimToken: 'synthetic', sessionId: 'protected',
        expectedSeq: 0, contentCiphertext: 'synthetic',
    } as never);
    expect(result).toEqual({ ok: false, error: 'target-mismatch' });
    expect(replay).not.toHaveBeenCalled();
    expect(tx.sessionMessage.create).not.toHaveBeenCalled();
    expect(tx.automationRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'run', machineAccountId: 'owner', machineId: 'pc',
            claimTokenHash: new Uint8Array(createHash('sha256').update('synthetic').digest()) },
    }));
});

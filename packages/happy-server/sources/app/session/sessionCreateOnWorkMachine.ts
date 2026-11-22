import { Prisma, type Session } from '@prisma/client';
import { inTx, afterTx } from '@/storage/inTx';
import { eventRouter, buildNewSessionUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { lockWorkMachineExecution, type WorkMachineDeviceGrant } from '@/app/machine/workMachineExecution';

export interface WorkMachineSessionCreateBody {
    tag: string;
    metadata: string;
    agentState?: string | null;
    dataEncryptionKey?: string | null;
}

/**
 * A new conversation a protected machine's daemon creates with its device
 * credential. The row is attached to the machine's work-machine execution
 * from the start, so the conversation is governed by the same generation as
 * every other conversation on the machine and its session credential can be
 * issued at once.
 *
 * The live generation is locked in the same transaction as the insert:
 * creation is new work, so it is refused while the generation drains or is
 * frozen, and a handoff cannot slip between the check and the row. Repeating
 * the request returns the conversation it created; a tag held by any other
 * conversation is a conflict rather than an adoption.
 */
export async function sessionCreateOnWorkMachine(
    grant: WorkMachineDeviceGrant,
    body: WorkMachineSessionCreateBody,
): Promise<{ session: Session } | 'denied' | 'conflict'> {
    const { accountId, machineId } = grant;
    for (let attempt = 0; ; attempt++) {
        try {
            return await inTx(async tx => {
                if (!await lockWorkMachineExecution(tx, grant, { newWork: true })) return 'denied' as const;
                const existing = await tx.session.findUnique({ where: { accountId_tag: { accountId, tag: body.tag } } });
                if (existing) return existing.workMachineId === machineId ? { session: existing } : 'conflict' as const;
                const session = await tx.session.create({ data: {
                    accountId, tag: body.tag, metadata: body.metadata, agentState: body.agentState, workMachineId: machineId,
                    dataEncryptionKey: body.dataEncryptionKey ? new Uint8Array(Buffer.from(body.dataEncryptionKey, 'base64')) : undefined,
                } });
                const account = await tx.account.update({ where: { id: accountId }, data: { seq: { increment: 1 } }, select: { seq: true } });
                afterTx(tx, () => eventRouter.emitUpdate({
                    userId: accountId,
                    payload: buildNewSessionUpdate(session, account.seq, randomKeyNaked(12)),
                    recipientFilter: { type: 'user-scoped-only' },
                    sessionProtection: session.piiProtection,
                }));
                return { session };
            });
        } catch (error) {
            // A concurrent identical create lost the tag; the retry finds its row.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && attempt < 2) continue;
            throw error;
        }
    }
}

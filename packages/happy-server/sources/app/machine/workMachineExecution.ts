import type { Prisma, PrismaClient } from '@prisma/client';

type ExecutionDb = Pick<Prisma.TransactionClient, 'workMachineExecution' | '$queryRaw'>;

/** Identity from a verified device grant. Never construct it from a request body. */
export interface WorkMachineDeviceGrant {
    accountId: string;
    machineId: string;
    deviceId: string;
    generation: number;
}

class WorkMachineEnrollmentConflict extends Error {}
class DuplicateWorkMachineMcpCall extends Error {}

export async function enrollWorkMachineExecution(
    db: Pick<PrismaClient, '$transaction'>,
    input: Omit<WorkMachineDeviceGrant, 'generation'> & { ownerUserId: string; sessionIds: string[] },
): Promise<WorkMachineDeviceGrant | null> {
    const { accountId, machineId, deviceId, ownerUserId, sessionIds } = input;
    try {
        return await db.$transaction(async tx => {
            const [machine] = await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "Machine"
                WHERE "id" = ${machineId} AND "accountId" = ${accountId} AND "dataEncryptionKey" IS NOT NULL
                FOR UPDATE
            `;
            if (!machine) return null;
            if (await tx.sessionExecutionBinding.findFirst({
                where: { machineId, machineOwnerAccountId: accountId, sessionRowId: { not: null } },
                select: { sessionId: true },
            })) return null;
            const active = await tx.workMachineExecution.findUnique({
                where: { machineId },
                select: { generation: true, deviceId: true, frozenAt: true },
            });
            const bindings = await tx.sessionOwnershipBinding.findMany({
                where: { machineId, machineAccountId: accountId, sessionRowId: { not: null } },
                take: sessionIds.length + 1,
                select: {
                    ownerUserId: true, sessionAccountId: true, confirmedAt: true,
                    session: { select: {
                        id: true, accountId: true, active: true, dataEncryptionKey: true, workMachineId: true, piiProtection: true,
                        executionBinding: { select: { sessionId: true } },
                    } },
                },
            });
            const inventory = new Set(sessionIds);
            if (inventory.size !== sessionIds.length || inventory.size !== bindings.length
                || bindings.some(binding => binding.ownerUserId !== ownerUserId || binding.sessionAccountId !== accountId
                    || !binding.confirmedAt || !binding.session || binding.session.accountId !== accountId
                    || !inventory.has(binding.session.id))) return null;
            const sessions = bindings.map(binding => binding.session!);
            const grant = { accountId, machineId, deviceId, generation: 1 };
            if (active) {
                return active.generation === grant.generation && active.deviceId === deviceId && !active.frozenAt
                    && sessions.every(session => session.workMachineId === machineId) ? grant : null;
            }
            if (sessions.some(session =>
                session.active || !session.dataEncryptionKey || session.workMachineId || session.piiProtection || session.executionBinding,
            )) return null;
            // Serializable legacy worker transactions may have started before
            // the row lock was acquired. Change its row version so they retry
            // instead of observing the old absence of the authority.
            await tx.$executeRaw`
                UPDATE "Machine" SET "metadataVersion" = "metadataVersion" WHERE "id" = ${machineId}
            `;
            await tx.workMachineExecution.create({ data: grant });
            const attached = await tx.session.updateMany({
                where: { accountId, id: { in: sessionIds }, workMachineId: null, active: false },
                data: { workMachineId: machineId },
            });
            if (attached.count !== sessionIds.length) throw new WorkMachineEnrollmentConflict();
            return grant;
        });
    } catch (error) {
        if (error instanceof WorkMachineEnrollmentConflict) return null;
        throw error;
    }
}

/** Serialize legacy runtime actions against creation of the work-machine authority. */
export async function lockLegacyWorkMachineExecution(
    tx: ExecutionDb,
    accountId: string,
    machineId: string,
): Promise<boolean> {
    await tx.$queryRaw`
        SELECT "id" FROM "Machine" WHERE "id" = ${machineId} AND "accountId" = ${accountId} FOR SHARE
    `;
    return !await tx.workMachineExecution.findFirst({
        where: { accountId, machineId }, select: { machineId: true },
    });
}

function matchGrant({ accountId, machineId, deviceId, generation }: WorkMachineDeviceGrant) {
    return { accountId, machineId, deviceId, generation };
}

export async function authorizeWorkMachineExecution(
    db: ExecutionDb,
    grant: WorkMachineDeviceGrant,
): Promise<boolean> {
    const authority = await db.workMachineExecution.findFirst({
        where: { ...matchGrant(grant), frozenAt: null },
        select: { machineId: true },
    });
    return authority !== null;
}

export async function authorizeWorkMachineSession(
    db: Pick<ExecutionDb, 'workMachineExecution'> & Pick<Prisma.TransactionClient, 'session'>,
    grant: WorkMachineDeviceGrant & { sessionId: string },
): Promise<boolean> {
    const session = await db.session.findFirst({
        where: {
            id: grant.sessionId,
            accountId: grant.accountId,
            workMachineExecution: { is: { ...matchGrant(grant), frozenAt: null } },
        },
        select: { id: true },
    });
    return session !== null;
}

/** Keep a verified write in the old generation from crossing a concurrent transition. */
export async function lockWorkMachineExecution(db: Pick<ExecutionDb, '$queryRaw'>, grant: WorkMachineDeviceGrant): Promise<boolean> {
    const current = await db.$queryRaw<{ machineId: string }[]>`
        SELECT "machineId" FROM "WorkMachineExecution"
        WHERE "machineId" = ${grant.machineId} AND "accountId" = ${grant.accountId}
          AND "deviceId" = ${grant.deviceId} AND "generation" = ${grant.generation}
          AND "frozenAt" IS NULL
        FOR SHARE
    `;
    return current.length === 1;
}

export async function redeemWorkMachineRenewal(
    db: Pick<PrismaClient, '$transaction'>,
    device: WorkMachineDeviceGrant & { sessionId?: string },
    proof: { nonce: string; expiresAt: Date },
): Promise<boolean> {
    return db.$transaction(async tx => {
        const current = await tx.$queryRaw<{ machineId: string }[]>`
            SELECT "machineId" FROM "WorkMachineExecution"
            WHERE "machineId" = ${device.machineId} AND "accountId" = ${device.accountId}
              AND "deviceId" = ${device.deviceId} AND "generation" = ${device.generation}
              AND "frozenAt" IS NULL
            FOR UPDATE
        `;
        if (current.length !== 1) return false;
        if (device.sessionId && !await tx.session.findFirst({
            where: { id: device.sessionId, accountId: device.accountId, workMachineId: device.machineId },
            select: { id: true },
        })) return false;
        await tx.$executeRaw`
            DELETE FROM "WorkMachineRenewalProof"
            WHERE "machineId" = ${device.machineId} AND "expiresAt" <= clock_timestamp()
        `;
        const redeemed = await tx.$executeRaw`
            INSERT INTO "WorkMachineRenewalProof" ("machineId", "nonce", "expiresAt")
            SELECT ${device.machineId}, ${proof.nonce}, ${proof.expiresAt}
            WHERE ${proof.expiresAt} > clock_timestamp()
            ON CONFLICT DO NOTHING
        `;
        return redeemed === 1;
    });
}

export async function freezeWorkMachineExecution(
    db: ExecutionDb,
    original: WorkMachineDeviceGrant,
): Promise<boolean> {
    const changed = await db.workMachineExecution.updateMany({
        where: { ...matchGrant(original), frozenAt: null },
        data: { frozenAt: new Date() },
    });
    return changed.count === 1;
}

/** The caller commits key and device changes in the same authority transaction. */
export async function replaceWorkMachineExecution(
    db: ExecutionDb,
    original: WorkMachineDeviceGrant,
    replacementDeviceId: string,
): Promise<boolean> {
    const changed = await db.workMachineExecution.updateMany({
        where: { ...matchGrant(original), frozenAt: { not: null }, mcpCalls: { none: { completedAt: null } } },
        data: {
            deviceId: replacementDeviceId,
            generation: { increment: 1 },
            frozenAt: null,
            firstExecutionAt: null,
        },
    });
    return changed.count === 1;
}

/** Preserve the first permit timestamp on retries without releasing the generation predicate. */
export async function permitWorkMachineExecution(
    db: ExecutionDb,
    grant: WorkMachineDeviceGrant,
    permittedAt: Date,
    allowDraining = false,
): Promise<boolean> {
    const existing = await db.$queryRaw<{ machineId: string }[]>`
        SELECT "machineId" FROM "WorkMachineExecution"
        WHERE "machineId" = ${grant.machineId} AND "accountId" = ${grant.accountId}
          AND "deviceId" = ${grant.deviceId} AND "generation" = ${grant.generation}
          AND "frozenAt" IS NULL AND (${allowDraining} OR "drainingAt" IS NULL) AND "firstExecutionAt" IS NOT NULL
        FOR SHARE
    `;
    if (existing.length === 1) return true;
    const changed = await db.$queryRaw<{ machineId: string }[]>`
        UPDATE "WorkMachineExecution"
        SET "firstExecutionAt" = COALESCE("firstExecutionAt", ${permittedAt})
        WHERE "machineId" = ${grant.machineId} AND "accountId" = ${grant.accountId}
          AND "deviceId" = ${grant.deviceId} AND "generation" = ${grant.generation}
          AND "frozenAt" IS NULL AND (${allowDraining} OR "drainingAt" IS NULL)
        RETURNING "machineId"
    `;
    return changed.length === 1;
}

/** Commit before contacting the connector. An unknown outcome deliberately leaves the call open. */
export async function admitWorkMachineMcpCall(
    db: Pick<PrismaClient, '$transaction'>,
    device: WorkMachineDeviceGrant,
    requestId: string,
): Promise<boolean> {
    try {
        return await db.$transaction(async tx => {
            if (!await permitWorkMachineExecution(tx, device, new Date(), true)) return false;
            const inserted = await tx.workMachineMcpCall.createMany({
                data: { ...matchGrant(device), requestId },
                skipDuplicates: true,
            });
            if (inserted.count !== 1) throw new DuplicateWorkMachineMcpCall();
            return true;
        });
    } catch (error) {
        if (error instanceof DuplicateWorkMachineMcpCall) return false;
        throw error;
    }
}

export async function finishWorkMachineMcpCall(
    db: Pick<Prisma.TransactionClient, 'workMachineMcpCall'>,
    device: WorkMachineDeviceGrant,
    requestId: string,
): Promise<void> {
    await db.workMachineMcpCall.updateMany({
        where: { ...matchGrant(device), requestId, completedAt: null },
        data: { completedAt: new Date() },
    });
}

export async function restoreWorkMachineExecution(
    db: ExecutionDb,
    replacement: WorkMachineDeviceGrant,
    originalDeviceId: string,
): Promise<boolean> {
    const changed = await db.workMachineExecution.updateMany({
        where: { ...matchGrant(replacement), firstExecutionAt: null, frozenAt: null },
        data: { deviceId: originalDeviceId, generation: { increment: 1 } },
    });
    return changed.count === 1;
}

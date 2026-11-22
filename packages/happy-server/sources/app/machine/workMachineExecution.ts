import type { Prisma, PrismaClient } from '@prisma/client';
import { machineDataKeyEnvelopesEqual } from '@/app/machine/machineDataKeyEnvelope';

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
            drainingAt: null,
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
        data: { deviceId: originalDeviceId, generation: { increment: 1 }, drainingAt: null },
    });
    return changed.count === 1;
}

const transitionSelect = { deviceId: true, generation: true, drainingAt: true, frozenAt: true } as const;

/** The generation's place in the drain → freeze sequence, as the operator routes report it. */
export interface WorkMachineTransitionState {
    deviceId: string;
    generation: number;
    draining: boolean;
    frozen: boolean;
}

async function readTransitionState(
    db: ExecutionDb,
    where: Prisma.WorkMachineExecutionWhereInput,
): Promise<WorkMachineTransitionState | null> {
    const row = await db.workMachineExecution.findFirst({ where, select: transitionSelect });
    return row && {
        deviceId: row.deviceId, generation: row.generation,
        draining: row.drainingAt !== null, frozen: row.frozenAt !== null,
    };
}

/**
 * Stops new work in the current generation: turn permits, write RPCs and
 * state-changing preview requests are refused while in-turn writes continue.
 * Repeating it, also after the freeze, reports the drained state again. Null
 * when the row is no longer at this device and generation.
 */
export async function drainWorkMachineExecution(db: ExecutionDb, grant: WorkMachineDeviceGrant) {
    await db.workMachineExecution.updateMany({
        where: { ...matchGrant(grant), drainingAt: null, frozenAt: null },
        data: { drainingAt: new Date() },
    });
    return readTransitionState(db, { ...matchGrant(grant), drainingAt: { not: null } });
}

/** Freezes a drained generation, which stops every write. Null unless it was drained first. */
export async function freezeDrainedWorkMachineExecution(db: ExecutionDb, grant: WorkMachineDeviceGrant) {
    await db.workMachineExecution.updateMany({
        where: { ...matchGrant(grant), drainingAt: { not: null }, frozenAt: null },
        data: { frozenAt: new Date() },
    });
    return readTransitionState(db, { ...matchGrant(grant), drainingAt: { not: null }, frozenAt: { not: null } });
}

/** Cancels a handoff before it happens: the same device and generation run again. */
export async function resumeWorkMachineExecution(db: ExecutionDb, grant: WorkMachineDeviceGrant) {
    await db.workMachineExecution.updateMany({
        where: { ...matchGrant(grant), OR: [{ drainingAt: { not: null } }, { frozenAt: { not: null } }] },
        data: { drainingAt: null, frozenAt: null },
    });
    return readTransitionState(db, { ...matchGrant(grant), drainingAt: null, frozenAt: null });
}

export type WorkMachineHandoff = 'replace' | 'restore';

/**
 * Moves the authority to the next device in the next generation and installs
 * the machine data key that device created, in the caller's transaction.
 * Replace needs a frozen generation without an open connector call; restore
 * needs a replacement that has not received its first execution permit. The
 * authority row is locked before the machine row, the order the daemon's
 * machine writes use. As in a key rotation, the server envelopes and the
 * attestation of the old key are cleared and both row versions move, so a
 * write prepared against the old key cannot land. A retry after a lost
 * response finds the device, generation and key in place and writes nothing.
 */
export async function handoffWorkMachineExecution(
    tx: Prisma.TransactionClient,
    kind: WorkMachineHandoff,
    current: WorkMachineDeviceGrant,
    nextDeviceId: string,
    dataEncryptionKey: Uint8Array,
) {
    const { accountId, machineId } = current;
    const moved = kind === 'replace'
        ? await replaceWorkMachineExecution(tx, current, nextDeviceId)
        : await restoreWorkMachineExecution(tx, current, nextDeviceId);
    if (!moved) {
        const applied = await tx.workMachineExecution.findFirst({
            where: { accountId, machineId, deviceId: nextDeviceId, generation: current.generation + 1 },
            select: { machine: { select: { dataEncryptionKey: true } } },
        });
        const key = applied?.machine.dataEncryptionKey;
        return key && machineDataKeyEnvelopesEqual(key, dataEncryptionKey) ? { changed: false as const } : null;
    }
    const machine = await tx.machine.update({
        where: { id: machineId, accountId },
        data: {
            dataEncryptionKey: new Uint8Array(dataEncryptionKey),
            serverDataEncryptionKey: null,
            serverRpcKeyEnvelope: null,
            dataKeyAttestation: null,
            metadataVersion: { increment: 1 },
            daemonStateVersion: { increment: 1 },
        },
        select: { metadata: true, metadataVersion: true, daemonState: true, daemonStateVersion: true },
    });
    return { changed: true as const, machine };
}

/**
 * The operator's verdict on a connector call whose outcome nobody can
 * confirm. Only a frozen generation's call can be closed this way; it records
 * `reconciledAt` and closes the call so the handoff can go ahead. A call that
 * already finished normally stays as it was and reports no reconciliation.
 */
export async function reconcileWorkMachineMcpCall(
    tx: Prisma.TransactionClient,
    grant: WorkMachineDeviceGrant,
    requestId: string,
): Promise<'not-frozen' | 'not-found' | { reconciledAt: Date | null }> {
    const frozen = await tx.$queryRaw<{ machineId: string }[]>`
        SELECT "machineId" FROM "WorkMachineExecution"
        WHERE "machineId" = ${grant.machineId} AND "accountId" = ${grant.accountId}
          AND "deviceId" = ${grant.deviceId} AND "generation" = ${grant.generation}
          AND "frozenAt" IS NOT NULL
        FOR SHARE
    `;
    if (frozen.length !== 1) return 'not-frozen';
    const now = new Date();
    await tx.workMachineMcpCall.updateMany({
        where: { ...matchGrant(grant), requestId, completedAt: null },
        data: { completedAt: now, reconciledAt: now },
    });
    const call = await tx.workMachineMcpCall.findFirst({
        where: { ...matchGrant(grant), requestId }, select: { reconciledAt: true },
    });
    return call ?? 'not-found';
}

import type { Prisma, PrismaClient } from '@prisma/client';
import { machineDataKeyEnvelopesEqual } from '@/app/machine/machineDataKeyEnvelope';
import { SCRIPT_CLAIM_LEASE_MS } from '@/app/automation/scriptInvocationService';
import { SESSION_FOLLOWUP_CLAIM_MS } from '@/app/automation/sessionFollowupExecutionService';

type ExecutionDb = Pick<Prisma.TransactionClient, 'workMachineExecution' | '$queryRaw'>;
type AutomationClaimDb = Pick<Prisma.TransactionClient, 'automationRun' | 'scriptInvocation' | 'sessionFollowup'>;

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

/**
 * Keep a verified write in the old generation from crossing a concurrent
 * transition. Work already under way continues while draining; `newWork`
 * (a new conversation, an automation claim) also needs the generation to be
 * outside drain.
 */
export async function lockWorkMachineExecution(
    db: Pick<ExecutionDb, '$queryRaw'>,
    grant: WorkMachineDeviceGrant,
    { newWork = false }: { newWork?: boolean } = {},
): Promise<boolean> {
    const current = await db.$queryRaw<{ machineId: string }[]>`
        SELECT "machineId" FROM "WorkMachineExecution"
        WHERE "machineId" = ${grant.machineId} AND "accountId" = ${grant.accountId}
          AND "deviceId" = ${grant.deviceId} AND "generation" = ${grant.generation}
          AND "frozenAt" IS NULL AND (${!newWork} OR "drainingAt" IS NULL)
        FOR SHARE
    `;
    return current.length === 1;
}

/**
 * Locks the generation for a daemon worker call on a machine. A machine under
 * work-machine authority is served only through the live credential of its
 * current device; any other machine only without one, as before.
 */
export async function lockWorkMachineWorker(
    tx: ExecutionDb,
    worker: { accountId: string; machineId: string },
    device: (WorkMachineDeviceGrant & { expiresAt: number }) | null | undefined,
    { newWork = false }: { newWork?: boolean } = {},
): Promise<boolean> {
    if (!device) return lockLegacyWorkMachineExecution(tx, worker.accountId, worker.machineId);
    return device.accountId === worker.accountId && device.machineId === worker.machineId
        && device.expiresAt > Date.now() && lockWorkMachineExecution(tx, device, { newWork });
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

export interface OpenWorkMachineAutomationRun {
    kind: 'automation-run' | 'script-invocation' | 'session-followup';
    id: string;
    claimedAt: Date;
}

/**
 * Scheduled runs, script runs and session follow-ups this machine claimed
 * whose claim or run lease is still live, oldest claim first. A lapsed lease
 * counts as ended, as it does for every other claim check, so a daemon that
 * died mid-run cannot hold a handoff forever. Script and follow-up rows keep
 * no claim time: it is derived from the fixed claim lifetime, and a started
 * script reports its start.
 */
export async function listOpenWorkMachineAutomationRuns(
    db: AutomationClaimDb,
    { accountId, machineId }: Pick<WorkMachineDeviceGrant, 'accountId' | 'machineId'>,
    now: Date,
    limit = 50,
): Promise<OpenWorkMachineAutomationRun[]> {
    // One query after another: this also runs on an interactive transaction client.
    const runs = await db.automationRun.findMany({
        where: { machineAccountId: accountId, machineId, OR: [
            { status: 'CLAIMED', claimExpiresAt: { gte: now } },
            { status: 'RUNNING', runLeaseExpiresAt: { gte: now } },
        ] },
        orderBy: { claimedAt: 'asc' }, take: limit, select: { id: true, claimedAt: true },
    });
    const scripts = await db.scriptInvocation.findMany({
        where: {
            status: { in: ['CLAIMED', 'RUNNING'] }, leaseExpiresAt: { gt: now.getTime() },
            AND: [
                { snapshot: { path: ['machineAccountId'], equals: accountId } },
                { snapshot: { path: ['machineId'], equals: machineId } },
            ],
        },
        orderBy: { createdAt: 'asc' }, take: limit, select: { id: true, status: true, startedAt: true, leaseExpiresAt: true },
    });
    const followups = await db.sessionFollowup.findMany({
        where: {
            machineAccountId: accountId, machineId, deletedAt: null, status: { in: ['WAITING', 'DELIVERY_PENDING'] },
            claimTokenHash: { not: null }, claimExpiresAt: { gte: now },
        },
        orderBy: { claimExpiresAt: 'asc' }, take: limit, select: { id: true, claimExpiresAt: true },
    });
    return [
        ...runs.map(run => ({ kind: 'automation-run' as const, id: run.id, claimedAt: run.claimedAt })),
        ...scripts.map(script => ({
            kind: 'script-invocation' as const, id: script.id,
            claimedAt: new Date(script.status === 'RUNNING' && script.startedAt !== null
                ? script.startedAt : script.leaseExpiresAt! - SCRIPT_CLAIM_LEASE_MS),
        })),
        ...followups.map(followup => ({
            kind: 'session-followup' as const, id: followup.id,
            claimedAt: new Date(followup.claimExpiresAt!.getTime() - SESSION_FOLLOWUP_CLAIM_MS),
        })),
    ].sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime()).slice(0, limit);
}

/** Why a handoff did not move the authority, as the operator routes report it. */
export type WorkMachineHandoffRefusal =
    | 'generation-mismatch' | 'not-frozen' | 'frozen' | 'open-mcp-calls' | 'open-automation-runs'
    | 'first-execution-recorded' | 'previous-device-mismatch' | 'key-mismatch';

/** Locks the authority row of exactly this device and generation for a handoff. */
async function lockHandoffAuthority(db: Pick<ExecutionDb, '$queryRaw'>, grant: WorkMachineDeviceGrant) {
    const [row] = await db.$queryRaw<{ frozenAt: Date | null; firstExecutionAt: Date | null; previousDeviceId: string | null }[]>`
        SELECT "frozenAt", "firstExecutionAt", "previousDeviceId" FROM "WorkMachineExecution"
        WHERE "machineId" = ${grant.machineId} AND "accountId" = ${grant.accountId}
          AND "deviceId" = ${grant.deviceId} AND "generation" = ${grant.generation}
        FOR UPDATE
    `;
    return row ?? null;
}

async function hasOpenAutomationRun(db: AutomationClaimDb, grant: WorkMachineDeviceGrant) {
    return (await listOpenWorkMachineAutomationRuns(db, grant, new Date(), 1)).length > 0;
}

/**
 * The caller commits key and device changes in the same authority transaction.
 * The frozen authority row is locked first: claims, heartbeats and connector
 * admissions lock it too and stop at the freeze, so no claim of this
 * generation can start or extend its lease while the open work is checked.
 */
export async function replaceWorkMachineExecution(
    db: ExecutionDb & AutomationClaimDb,
    original: WorkMachineDeviceGrant,
    replacementDeviceId: string,
): Promise<true | WorkMachineHandoffRefusal> {
    const row = await lockHandoffAuthority(db, original);
    if (!row) return 'generation-mismatch';
    if (!row.frozenAt) return 'not-frozen';
    const { accountId, machineId } = original;
    if (await db.workMachineExecution.count({ where: { accountId, machineId, mcpCalls: { some: { completedAt: null } } } })) {
        return 'open-mcp-calls';
    }
    if (await hasOpenAutomationRun(db, original)) return 'open-automation-runs';
    // The predicates repeat the checks for a caller outside a transaction,
    // where the row lock ends with the statement; a row that changed is
    // checked again and refused for its new reason.
    const changed = await db.workMachineExecution.updateMany({
        where: { ...matchGrant(original), frozenAt: { not: null }, mcpCalls: { none: { completedAt: null } } },
        data: {
            deviceId: replacementDeviceId,
            previousDeviceId: original.deviceId,
            generation: { increment: 1 },
            drainingAt: null,
            frozenAt: null,
            firstExecutionAt: null,
        },
    });
    return changed.count === 1 || replaceWorkMachineExecution(db, original, replacementDeviceId);
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

/**
 * Returns the authority to the device the replace moved it away from, before
 * the replacement ran anything. The replacement's row is locked first, as in a
 * replace: claims and first execution permits lock it too, so none can start
 * while it is checked. The restored generation has no previous device, so a
 * restore does not chain back.
 */
export async function restoreWorkMachineExecution(
    db: ExecutionDb & AutomationClaimDb,
    replacement: WorkMachineDeviceGrant,
    originalDeviceId: string,
): Promise<true | WorkMachineHandoffRefusal> {
    const row = await lockHandoffAuthority(db, replacement);
    if (!row) return 'generation-mismatch';
    if (row.firstExecutionAt) return 'first-execution-recorded';
    if (row.frozenAt) return 'frozen';
    if (row.previousDeviceId !== originalDeviceId) return 'previous-device-mismatch';
    if (await hasOpenAutomationRun(db, replacement)) return 'open-automation-runs';
    // As in a replace, the predicates repeat the checks for a caller outside a transaction.
    const changed = await db.workMachineExecution.updateMany({
        where: { ...matchGrant(replacement), firstExecutionAt: null, frozenAt: null, previousDeviceId: originalDeviceId },
        data: { deviceId: originalDeviceId, previousDeviceId: null, generation: { increment: 1 }, drainingAt: null },
    });
    return changed.count === 1 || restoreWorkMachineExecution(db, replacement, originalDeviceId);
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

/** Why a transition did not reach its state, as the operator routes report it. */
export type WorkMachineTransitionRefusal = 'generation-mismatch' | 'not-draining' | 'frozen';

/** The state the transition reached, or why this device and generation could not reach it. */
async function transitionResult(
    db: ExecutionDb,
    grant: WorkMachineDeviceGrant,
    reached: Prisma.WorkMachineExecutionWhereInput,
    refusal: WorkMachineTransitionRefusal,
): Promise<WorkMachineTransitionState | WorkMachineTransitionRefusal> {
    return await readTransitionState(db, { ...matchGrant(grant), ...reached })
        ?? (await readTransitionState(db, matchGrant(grant)) ? refusal : 'generation-mismatch');
}

/**
 * Stops new work in the current generation: turn permits, write RPCs and
 * state-changing preview requests are refused while in-turn writes continue.
 * Repeating it, also after the freeze, reports the drained state again.
 * Refused when the row is no longer at this device and generation.
 */
export async function drainWorkMachineExecution(db: ExecutionDb, grant: WorkMachineDeviceGrant) {
    await db.workMachineExecution.updateMany({
        where: { ...matchGrant(grant), drainingAt: null, frozenAt: null },
        data: { drainingAt: new Date() },
    });
    return transitionResult(db, grant, { drainingAt: { not: null } }, 'frozen');
}

/** Freezes a drained generation, which stops every write. Refused unless it was drained first. */
export async function freezeDrainedWorkMachineExecution(db: ExecutionDb, grant: WorkMachineDeviceGrant) {
    await db.workMachineExecution.updateMany({
        where: { ...matchGrant(grant), drainingAt: { not: null }, frozenAt: null },
        data: { frozenAt: new Date() },
    });
    return transitionResult(db, grant, { drainingAt: { not: null }, frozenAt: { not: null } }, 'not-draining');
}

/** Cancels a handoff before it happens: the same device and generation run again. */
export async function resumeWorkMachineExecution(db: ExecutionDb, grant: WorkMachineDeviceGrant) {
    await db.workMachineExecution.updateMany({
        where: { ...matchGrant(grant), OR: [{ drainingAt: { not: null } }, { frozenAt: { not: null } }] },
        data: { drainingAt: null, frozenAt: null },
    });
    return transitionResult(db, grant, { drainingAt: null, frozenAt: null }, 'generation-mismatch');
}

export type WorkMachineHandoff = 'replace' | 'restore';

/**
 * Moves the authority to the next device in the next generation and installs
 * the machine data key that device created, in the caller's transaction.
 * Replace needs a frozen generation without open connector calls or automation
 * claims; restore needs a replacement that has run nothing and the device it
 * was replaced from. A refusal says why. The authority row is locked before
 * the machine row, the order the daemon's machine writes use. As in a key rotation, the server envelopes and the
 * attestation of the old key are cleared and both row versions move, so a
 * write prepared against the old key cannot land. A retry after a lost
 * response finds the device, generation and key in place and writes nothing;
 * the same retry with another key is a `key-mismatch`.
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
    if (moved !== true) {
        const applied = await tx.workMachineExecution.findFirst({
            where: { accountId, machineId, deviceId: nextDeviceId, generation: current.generation + 1 },
            select: { machine: { select: { dataEncryptionKey: true } } },
        });
        if (!applied) return { refused: moved };
        const key = applied.machine.dataEncryptionKey;
        return key && machineDataKeyEnvelopesEqual(key, dataEncryptionKey)
            ? { changed: false as const }
            : { refused: 'key-mismatch' as const };
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

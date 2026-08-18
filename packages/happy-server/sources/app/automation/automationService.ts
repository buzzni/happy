import type { Automation, AutomationRun, Prisma } from '@prisma/client';
import { AUTOMATION_RUN_NOW_PROTOCOL_VERSION } from '@slopus/happy-wire';

type Tx = Prisma.TransactionClient;

export type AutomationServiceError =
    | 'not-found'
    | 'forbidden'
    | 'automation-target-unavailable'
    | 'viewer-key-unavailable'
    | 'viewer-key-in-use'
    | 'viewer-key-version-conflict'
    | 'machine-key-version-conflict'
    | 'legacy-adoption-conflict'
    | 'legacy-target-mismatch'
    | 'migration-pending'
    | 'migration-not-applied'
    | 'automation-paused'
    | 'automation-run-unsupported'
    | 'invalid-payload-update'
    | 'revision-conflict';

export type AutomationServiceResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: AutomationServiceError; latest?: Automation };

type Binary = Uint8Array<ArrayBuffer>;

interface AutomationPayloadInput {
    payloadVersion: number;
    payloadCiphertext: Binary;
    viewerKeyId: string;
    viewerKeyVersion: number;
    viewerKeyEnvelope: Binary;
    machineKeyVersion: number;
    machineKeyEnvelope: Binary;
}

export interface AutomationCreateInput extends AutomationPayloadInput {
    paused: boolean;
}

export interface AutomationAdoptInput extends AutomationPayloadInput {
    legacyMachineId: string;
    legacyAutomationId: string;
    ownershipConfirmed: true;
    desiredPaused: boolean;
}

export interface AutomationUpdateInput {
    expectedRevision: number;
    paused?: boolean;
    payloadVersion?: number;
    payloadCiphertext?: Binary;
    viewerKeyId?: string;
    viewerKeyVersion?: number;
    viewerKeyEnvelope?: Binary;
    machineKeyVersion?: number;
    machineKeyEnvelope?: Binary;
}

interface ProjectAccess {
    project: {
        id: string;
        accountId: string;
        config: unknown;
        automationViewerPublicKey: Binary | null;
        automationViewerKeyVersion: number;
    };
    canEdit: boolean;
    canManageKeys: boolean;
}

interface AutomationTarget {
    machineAccountId: string;
    machineId: string;
    machinePublicKey: Binary;
    machineKeyVersion: number;
    automationProtocolVersion: number;
}

async function projectAccess(tx: Tx, actorId: string, projectId: string): Promise<ProjectAccess | null> {
    const project = await tx.project.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            accountId: true,
            config: true,
            automationViewerPublicKey: true,
            automationViewerKeyVersion: true,
        },
    });
    if (!project) return null;
    if (project.accountId === actorId) return { project, canEdit: true, canManageKeys: true };

    const member = await tx.projectMember.findUnique({
        where: { projectId_accountId: { projectId, accountId: actorId } },
        select: { role: true, status: true },
    });
    if (!member || member.status !== 'accepted') return null;
    return {
        project,
        canEdit: member.role === 'owner' || member.role === 'editor',
        canManageKeys: member.role === 'owner',
    };
}

async function targetForProject(tx: Tx, project: ProjectAccess['project']): Promise<AutomationTarget | null> {
    const machineId = typeof project.config === 'object' && project.config !== null
        && typeof (project.config as { machineId?: unknown }).machineId === 'string'
        ? (project.config as { machineId: string }).machineId
        : null;
    if (!machineId) return null;

    const machine = await tx.machine.findUnique({
        where: { accountId_id: { accountId: project.accountId, id: machineId } },
        select: {
            id: true,
            accountId: true,
            automationPublicKey: true,
            automationKeyVersion: true,
            automationProtocolVersion: true,
        },
    });
    if (!machine?.automationPublicKey || machine.automationKeyVersion < 1) return null;
    return {
        machineAccountId: machine.accountId,
        machineId: machine.id,
        machinePublicKey: machine.automationPublicKey,
        machineKeyVersion: machine.automationKeyVersion,
        automationProtocolVersion: machine.automationProtocolVersion,
    };
}

export interface AutomationTargetView {
    machineAccountId: string;
    machineId: string;
    machinePublicKey: Binary;
    machineKeyVersion: number;
    viewerPublicKey: Binary | null;
    viewerKeyVersion: number;
    automationProtocolVersion: number;
}

export async function getAutomationTarget(
    tx: Tx,
    actorId: string,
    projectId: string,
): Promise<AutomationServiceResult<AutomationTargetView>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    const target = await targetForProject(tx, access.project);
    if (!target) return { ok: false, error: 'automation-target-unavailable' };
    return {
        ok: true,
        value: {
            machineAccountId: target.machineAccountId,
            machineId: target.machineId,
            machinePublicKey: target.machinePublicKey,
            machineKeyVersion: target.machineKeyVersion,
            viewerPublicKey: access.project.automationViewerPublicKey,
            viewerKeyVersion: access.project.automationViewerKeyVersion,
            automationProtocolVersion: target.automationProtocolVersion,
        },
    };
}

export async function setAutomationViewerKey(
    tx: Tx,
    actorId: string,
    projectId: string,
    input: { expectedKeyVersion: number; publicKey: Binary },
): Promise<AutomationServiceResult<{ keyVersion: number }>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    if (!access.canManageKeys) return { ok: false, error: 'forbidden' };
    const changed = await tx.project.updateMany({
        where: { id: projectId, automationViewerKeyVersion: input.expectedKeyVersion },
        data: {
            automationViewerPublicKey: input.publicKey,
            automationViewerKeyVersion: { increment: 1 },
        },
    });
    if (changed.count === 0) return { ok: false, error: 'viewer-key-version-conflict' };
    return { ok: true, value: { keyVersion: input.expectedKeyVersion + 1 } };
}

export async function replaceAutomationViewerKeyIfUnused(
    tx: Tx,
    actorId: string,
    projectId: string,
    input: { expectedKeyVersion: number; publicKey: Binary },
): Promise<AutomationServiceResult<{ keyVersion: number }>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    if (!access.canManageKeys) return { ok: false, error: 'forbidden' };
    const activeAutomationCount = await tx.automation.count({
        where: { projectId, deletedAt: null },
    });
    if (activeAutomationCount > 0) return { ok: false, error: 'viewer-key-in-use' };
    return setAutomationViewerKey(tx, actorId, projectId, input);
}

function validateKeyVersions(
    project: ProjectAccess['project'],
    target: AutomationTarget,
    input: Pick<AutomationPayloadInput, 'viewerKeyVersion' | 'machineKeyVersion'>,
): AutomationServiceError | null {
    if (!project.automationViewerPublicKey || project.automationViewerKeyVersion < 1) {
        return 'viewer-key-unavailable';
    }
    if (input.viewerKeyVersion !== project.automationViewerKeyVersion) {
        return 'viewer-key-version-conflict';
    }
    if (input.machineKeyVersion !== target.machineKeyVersion) {
        return 'machine-key-version-conflict';
    }
    return null;
}

async function appendChange(
    tx: Tx,
    automation: Pick<Automation, 'id' | 'revision' | 'generation'>,
    target: { machineAccountId: string; machineId: string },
    kind: 'UPSERT' | 'TOMBSTONE',
): Promise<void> {
    await tx.automationChange.create({
        data: {
            automationId: automation.id,
            machineAccountId: target.machineAccountId,
            machineId: target.machineId,
            revision: automation.revision,
            generation: automation.generation,
            kind,
        },
    });
}

export async function listAutomations(
    tx: Tx,
    actorId: string,
    projectId: string,
): Promise<AutomationServiceResult<Automation[]>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    const rows = await tx.automation.findMany({
        where: { projectId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
    });
    return { ok: true, value: rows };
}

export async function listAutomationRuns(
    tx: Tx,
    actorId: string,
    projectId: string,
    input: { automationId?: string; limit: number },
): Promise<AutomationServiceResult<AutomationRun[]>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    const rows = await tx.automationRun.findMany({
        where: {
            automation: { projectId },
            ...(input.automationId ? { automationId: input.automationId } : {}),
        },
        orderBy: [{ claimedAt: 'desc' }, { scheduledFor: 'desc' }],
        take: input.limit,
    });
    return { ok: true, value: rows };
}

export async function requestAutomationRun(
    tx: Tx,
    actorId: string,
    projectId: string,
    automationId: string,
    expectedRevision: number,
    now: Date = new Date(),
): Promise<AutomationServiceResult<Automation>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    if (!access.canEdit) return { ok: false, error: 'forbidden' };
    const current = await tx.automation.findFirst({
        where: { id: automationId, projectId, deletedAt: null },
        include: {
            targetMachine: {
                select: { automationProtocolVersion: true, automationKeyVersion: true },
            },
        },
    });
    if (!current) return { ok: false, error: 'not-found' };
    if (current.revision !== expectedRevision) {
        return { ok: false, error: 'revision-conflict', latest: current };
    }
    if (current.paused) return { ok: false, error: 'automation-paused' };
    if (current.legacyMigrationPending) return { ok: false, error: 'migration-pending' };
    if (!current.machineAccountId || !current.machineId) return { ok: false, error: 'automation-target-unavailable' };
    if ((current.targetMachine?.automationProtocolVersion ?? 1) < AUTOMATION_RUN_NOW_PROTOCOL_VERSION) {
        return { ok: false, error: 'automation-run-unsupported' };
    }
    if (current.machineKeyVersion !== current.targetMachine?.automationKeyVersion) {
        return { ok: false, error: 'machine-key-version-conflict' };
    }
    if (current.viewerKeyVersion !== access.project.automationViewerKeyVersion) {
        return { ok: false, error: 'viewer-key-version-conflict' };
    }
    const requestedAt = new Date(Math.max(
        now.getTime(),
        (current.runRequestedAt?.getTime() ?? -1) + 1,
    ));

    const changed = await tx.automation.updateMany({
        where: {
            id: automationId,
            projectId,
            revision: expectedRevision,
            paused: false,
            legacyMigrationPending: false,
            deletedAt: null,
        },
        data: { revision: { increment: 1 }, runRequestedAt: requestedAt },
    });
    if (changed.count === 0) {
        const latest = await tx.automation.findFirst({ where: { id: automationId, projectId, deletedAt: null } });
        return latest
            ? { ok: false, error: 'revision-conflict', latest }
            : { ok: false, error: 'not-found' };
    }
    const updated = await tx.automation.findUnique({ where: { id: automationId } });
    if (!updated) return { ok: false, error: 'not-found' };
    await appendChange(tx, updated, {
        machineAccountId: current.machineAccountId,
        machineId: current.machineId,
    }, 'UPSERT');
    return { ok: true, value: updated };
}

export async function createAutomation(
    tx: Tx,
    actorId: string,
    projectId: string,
    input: AutomationCreateInput,
): Promise<AutomationServiceResult<Automation>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    if (!access.canEdit) return { ok: false, error: 'forbidden' };
    const target = await targetForProject(tx, access.project);
    if (!target) return { ok: false, error: 'automation-target-unavailable' };
    const keyError = validateKeyVersions(access.project, target, input);
    if (keyError) return { ok: false, error: keyError };

    const data: Prisma.AutomationUncheckedCreateInput = {
        projectId,
        ownerAccountId: actorId,
        machineAccountId: target.machineAccountId,
        machineId: target.machineId,
        ...input,
    };
    const row = await tx.automation.create({ data });
    await appendChange(tx, row, target, 'UPSERT');
    return { ok: true, value: row };
}

export async function adoptAutomation(
    tx: Tx,
    actorId: string,
    projectId: string,
    input: AutomationAdoptInput,
): Promise<AutomationServiceResult<Automation>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    if (!access.canEdit || access.project.accountId !== actorId) return { ok: false, error: 'forbidden' };
    const target = await targetForProject(tx, access.project);
    if (!target) return { ok: false, error: 'automation-target-unavailable' };
    if (input.legacyMachineId !== target.machineId) return { ok: false, error: 'legacy-target-mismatch' };
    const keyError = validateKeyVersions(access.project, target, input);
    if (keyError) return { ok: false, error: keyError };

    const data: Prisma.AutomationCreateManyInput = {
        projectId,
        ownerAccountId: actorId,
        machineAccountId: target.machineAccountId,
        machineId: target.machineId,
        payloadVersion: input.payloadVersion,
        payloadCiphertext: input.payloadCiphertext,
        viewerKeyId: input.viewerKeyId,
        viewerKeyVersion: input.viewerKeyVersion,
        viewerKeyEnvelope: input.viewerKeyEnvelope,
        machineKeyVersion: input.machineKeyVersion,
        machineKeyEnvelope: input.machineKeyEnvelope,
        paused: true,
        legacyMachineId: input.legacyMachineId,
        legacyAutomationId: input.legacyAutomationId,
        legacyMigrationPending: true,
        legacyDesiredPaused: input.desiredPaused,
    };
    const created = await tx.automation.createMany({ data: [data], skipDuplicates: true });
    const row = await tx.automation.findUnique({
        where: {
            legacyMachineId_legacyAutomationId: {
                legacyMachineId: input.legacyMachineId,
                legacyAutomationId: input.legacyAutomationId,
            },
        },
    });
    if (!row || row.projectId !== projectId || row.ownerAccountId !== actorId
        || row.machineAccountId !== target.machineAccountId || row.machineId !== target.machineId
        || row.deletedAt !== null || row.legacyDesiredPaused !== input.desiredPaused) {
        return { ok: false, error: 'legacy-adoption-conflict' };
    }
    if (created.count === 1) await appendChange(tx, row, target, 'UPSERT');
    return { ok: true, value: row };
}

export async function activateAutomationAdoption(
    tx: Tx,
    actorId: string,
    projectId: string,
    automationId: string,
    expectedRevision: number,
    now: Date = new Date(),
): Promise<AutomationServiceResult<Automation>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    if (!access.canEdit || access.project.accountId !== actorId) return { ok: false, error: 'forbidden' };
    const current = await tx.automation.findFirst({ where: { id: automationId, projectId, deletedAt: null } });
    if (!current || current.ownerAccountId !== actorId || !current.legacyMachineId) {
        return { ok: false, error: 'not-found' };
    }
    if (!current.legacyMigrationPending) return { ok: true, value: current };
    if (current.legacyDesiredPaused === null) return { ok: false, error: 'legacy-adoption-conflict' };
    if (current.appliedRevision < current.revision) return { ok: false, error: 'migration-not-applied' };
    const changed = await tx.automation.updateMany({
        where: { id: automationId, projectId, revision: expectedRevision, legacyMigrationPending: true, deletedAt: null },
        data: {
            revision: { increment: 1 },
            generation: { increment: 1 },
            paused: current.legacyDesiredPaused,
            enabledAt: now,
            legacyMigrationPending: false,
        },
    });
    if (changed.count === 0) {
        const latest = await tx.automation.findFirst({ where: { id: automationId, projectId, deletedAt: null } });
        return latest && !latest.legacyMigrationPending
            ? { ok: true, value: latest }
            : latest
                ? { ok: false, error: 'revision-conflict', latest }
                : { ok: false, error: 'not-found' };
    }
    const updated = await tx.automation.findUnique({ where: { id: automationId } });
    if (!updated?.machineAccountId || !updated.machineId) return { ok: false, error: 'not-found' };
    await appendChange(tx, updated, {
        machineAccountId: updated.machineAccountId,
        machineId: updated.machineId,
    }, 'UPSERT');
    return { ok: true, value: updated };
}

function hasPayloadUpdate(input: AutomationUpdateInput): boolean {
    return input.payloadVersion !== undefined
        || input.payloadCiphertext !== undefined
        || input.viewerKeyId !== undefined
        || input.viewerKeyVersion !== undefined
        || input.viewerKeyEnvelope !== undefined
        || input.machineKeyVersion !== undefined
        || input.machineKeyEnvelope !== undefined;
}

function completePayloadUpdate(input: AutomationUpdateInput): input is AutomationUpdateInput & AutomationPayloadInput {
    return input.payloadVersion !== undefined
        && input.payloadCiphertext !== undefined
        && input.viewerKeyId !== undefined
        && input.viewerKeyVersion !== undefined
        && input.viewerKeyEnvelope !== undefined
        && input.machineKeyVersion !== undefined
        && input.machineKeyEnvelope !== undefined;
}

export async function updateAutomation(
    tx: Tx,
    actorId: string,
    projectId: string,
    automationId: string,
    input: AutomationUpdateInput,
): Promise<AutomationServiceResult<Automation>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    if (!access.canEdit) return { ok: false, error: 'forbidden' };
    const current = await tx.automation.findFirst({ where: { id: automationId, projectId, deletedAt: null } });
    if (!current) return { ok: false, error: 'not-found' };
    if (current.legacyMigrationPending) return { ok: false, error: 'migration-pending' };

    const payloadUpdate = hasPayloadUpdate(input);
    if (!payloadUpdate && input.paused === undefined) {
        return { ok: false, error: 'invalid-payload-update' };
    }
    let target: AutomationTarget | null = null;
    if (payloadUpdate) {
        if (!completePayloadUpdate(input)) return { ok: false, error: 'invalid-payload-update' };
        target = await targetForProject(tx, access.project);
        if (!target) return { ok: false, error: 'automation-target-unavailable' };
        const keyError = validateKeyVersions(access.project, target, input);
        if (keyError) return { ok: false, error: keyError };
    }

    const data: Prisma.AutomationUncheckedUpdateManyInput = {
        revision: { increment: 1 },
        generation: { increment: 1 },
        runRequestedAt: null,
        ...(input.paused !== undefined ? { paused: input.paused } : {}),
        ...(target && completePayloadUpdate(input) ? {
            machineAccountId: target.machineAccountId,
            machineId: target.machineId,
            payloadVersion: input.payloadVersion,
            payloadCiphertext: input.payloadCiphertext,
            viewerKeyId: input.viewerKeyId,
            viewerKeyVersion: input.viewerKeyVersion,
            viewerKeyEnvelope: input.viewerKeyEnvelope,
            machineKeyVersion: input.machineKeyVersion,
            machineKeyEnvelope: input.machineKeyEnvelope,
        } : {}),
    };
    const updatedCount = await tx.automation.updateMany({
        where: { id: automationId, projectId, revision: input.expectedRevision, deletedAt: null },
        data,
    });
    if (updatedCount.count === 0) {
        const latest = await tx.automation.findFirst({ where: { id: automationId, projectId, deletedAt: null } });
        return latest
            ? { ok: false, error: 'revision-conflict', latest }
            : { ok: false, error: 'not-found' };
    }

    const updated = await tx.automation.findUnique({ where: { id: automationId } });
    if (!updated) return { ok: false, error: 'not-found' };
    const previousTarget = current.machineAccountId && current.machineId
        ? { machineAccountId: current.machineAccountId, machineId: current.machineId }
        : null;
    const nextTarget = updated.machineAccountId && updated.machineId
        ? { machineAccountId: updated.machineAccountId, machineId: updated.machineId }
        : null;
    if (previousTarget && nextTarget
        && (previousTarget.machineAccountId !== nextTarget.machineAccountId || previousTarget.machineId !== nextTarget.machineId)) {
        await appendChange(tx, updated, previousTarget, 'TOMBSTONE');
    }
    if (nextTarget) await appendChange(tx, updated, nextTarget, 'UPSERT');
    return { ok: true, value: updated };
}

export async function deleteAutomation(
    tx: Tx,
    actorId: string,
    projectId: string,
    automationId: string,
    expectedRevision: number,
): Promise<AutomationServiceResult<Automation>> {
    const access = await projectAccess(tx, actorId, projectId);
    if (!access) return { ok: false, error: 'not-found' };
    if (!access.canEdit) return { ok: false, error: 'forbidden' };
    const current = await tx.automation.findFirst({ where: { id: automationId, projectId, deletedAt: null } });
    if (!current) return { ok: false, error: 'not-found' };

    const changed = await tx.automation.updateMany({
        where: { id: automationId, projectId, revision: expectedRevision, deletedAt: null },
        data: {
            revision: { increment: 1 },
            generation: { increment: 1 },
            deletedAt: new Date(),
        },
    });
    if (changed.count === 0) {
        const latest = await tx.automation.findFirst({ where: { id: automationId, projectId, deletedAt: null } });
        return latest
            ? { ok: false, error: 'revision-conflict', latest }
            : { ok: false, error: 'not-found' };
    }

    const updated = await tx.automation.findUnique({ where: { id: automationId } });
    if (!updated) return { ok: false, error: 'not-found' };
    if (current.machineAccountId && current.machineId) {
        await appendChange(tx, updated, {
            machineAccountId: current.machineAccountId,
            machineId: current.machineId,
        }, 'TOMBSTONE');
    }
    return { ok: true, value: updated };
}

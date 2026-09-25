import { randomUUID } from 'node:crypto'
import type { AgentGrant, ApprovalId, BatchId, BatchStep, BrowserInstanceId, PendingApprovalSummary, SnapshotId, TaskId } from './contracts'
import { approvalBinding, payloadHash, redact, type FormValue } from './policy'
import type { ApprovalRecord } from './taskStore'

export function createApproval(input: {
    grant: AgentGrant
    taskId: TaskId
    batchId: BatchId
    step: BatchStep
    nextStep: number
    origin: string
    leaseEpoch: number
    browserInstanceId: BrowserInstanceId
    documentGeneration: number
    snapshotId: SnapshotId
    frameOrigin: string
    currentPageUrl: string
    expiresAtMs: number
    elementName?: string
    /** Driver element identity (non-secret), used to re-bind the element after a Runtime-only restart */
    elementIdentity?: string
    formValues?: FormValue[]
}): { summary: PendingApprovalSummary; record: ApprovalRecord } {
    const approvalId = `approval-${randomUUID()}` as ApprovalId
    const formValuesByName = Object.fromEntries((input.formValues ?? []).map(({ name, value }) => [name, value]))
    const stepHash = payloadHash({ step: input.step, formValues: formValuesByName,
        frameOrigin: input.frameOrigin, currentPageUrl: input.currentPageUrl })
    const formSummary = (input.formValues ?? [])
        .map(({ name, value }) => `${name}=${redact(value)}`)
        .join(', ')
    const targetName = input.elementName ? ` "${redact(input.elementName)}"` : ` ${input.step.kind}`
    const bindingHash = approvalBinding({
        principalId: input.grant.principalId,
        workspaceId: input.grant.workspaceId,
        taskId: input.taskId,
        actionId: input.step.actionId,
        origin: input.origin,
        payloadHash: stepHash,
        leaseEpoch: input.leaseEpoch,
        browserInstanceId: input.browserInstanceId,
        documentGeneration: input.documentGeneration,
        expiresAtMs: input.expiresAtMs,
        frameOrigin: input.frameOrigin,
    })
    const summary: PendingApprovalSummary = {
        approvalId,
        actionId: input.step.actionId,
        origin: input.origin,
        description: `Confirm${targetName}${formSummary ? ` (${formSummary})` : ''}`,
        bindingHash,
        expiresAtMs: input.expiresAtMs,
    }
    return {
        summary,
        record: {
            ...summary,
            state: 'pending',
            grantId: input.grant.grantId,
            batchId: input.batchId,
            nextStep: input.nextStep,
            payloadHash: stepHash,
            documentGeneration: input.documentGeneration,
            leaseEpoch: input.leaseEpoch,
            browserInstanceId: input.browserInstanceId,
            snapshotId: input.snapshotId,
            frameOrigin: input.frameOrigin,
            ...(input.elementIdentity ? { elementIdentity: input.elementIdentity } : {}),
            formValues: Object.fromEntries(Object.entries(formValuesByName).map(([name, value]) => [name, payloadHash(value)])),
        },
    }
}

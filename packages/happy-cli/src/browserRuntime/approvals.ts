import { randomUUID } from 'node:crypto'
import type { AgentGrant, ApprovalId, BatchId, BatchStep, BrowserInstanceId, PendingApprovalSummary, TaskId } from './contracts'
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
    expiresAtMs: number
    elementName?: string
    formValues?: FormValue[]
}): { summary: PendingApprovalSummary; record: ApprovalRecord } {
    const approvalId = `approval-${randomUUID()}` as ApprovalId
    const stepHash = payloadHash({ step: input.step, formValues: input.formValues ?? [] })
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
            batchId: input.batchId,
            nextStep: input.nextStep,
            payloadHash: stepHash,
            documentGeneration: input.documentGeneration,
            leaseEpoch: input.leaseEpoch,
            browserInstanceId: input.browserInstanceId,
        },
    }
}

/**
 * What ties a conversation to an organization LLM endpoint beyond one daemon's local record (aplus specs/org-llm-endpoints r3).
 *
 * The daemon writes a non-secret marker into the session's metadata when it starts an endpoint session, so the
 * conversation is recognizable wherever its metadata is read — the web client, a recovery on a machine whose record is
 * gone. And it refuses to carry such a conversation into a new session under any other source: continuing it elsewhere
 * would send what was said on the internal endpoint to another model backend.
 */
import type { PersistedSession } from '@/persistence'
import { ORG_ENDPOINT_BINDING_ENV } from '@/utils/childEnv'
import { parseOrgEndpointBinding, type AiAuthSelection } from './sessionEnv'

/** `Metadata.orgLlmEndpoint`: only ids, never an address, a target or a token. */
export type OrgEndpointSessionMarker = { version: 1; bindingId: string; endpointId: string }

/** The marker for a session started with this binding env value, or undefined when there is none. */
export function orgEndpointMarker(bindingEnv: string | undefined): OrgEndpointSessionMarker | undefined {
    const binding = parseOrgEndpointBinding(bindingEnv ?? '')
    return binding ? { version: 1, bindingId: binding.bindingId, endpointId: binding.endpointId } : undefined
}

/** Whether session metadata carries the marker. Presence is enough: a shape this build cannot read still binds. */
export function isOrgEndpointBoundMetadata(metadata: { orgLlmEndpoint?: unknown } | undefined): boolean {
    return metadata?.orgLlmEndpoint !== undefined && metadata.orgLlmEndpoint !== null
}

type Evidence = { endpointId: string | undefined }

/** `endpointId` is undefined when the record proves a binding but not which endpoint (corrupt record, unreadable marker). */
function evidenceOf(record: PersistedSession): Evidence | undefined {
    const bindingEnv = record.agentEnvironment?.[ORG_ENDPOINT_BINDING_ENV]
    if (bindingEnv !== undefined) return { endpointId: parseOrgEndpointBinding(bindingEnv)?.endpointId }
    const marked = (record.metadata as { orgLlmEndpoint?: unknown }).orgLlmEndpoint
    if (marked === undefined || marked === null) return undefined
    const endpointId = typeof marked === 'object' ? (marked as { endpointId?: unknown }).endpointId : undefined
    return { endpointId: typeof endpointId === 'string' ? endpointId : undefined }
}

/**
 * The refusal for a spawn that continues a conversation (`parentSessionId`, or a native `resumeClaudeSessionId` that
 * some recorded session ran) when that conversation ran on an endpoint — unless the spawn is itself a selection of the
 * same endpoint, which prepares and verifies its own binding. Only this machine's records are visible here: a parent
 * on another machine is the requester's check, through the metadata marker.
 */
export function orgEndpointParentRefusal(input: {
    parentSessionId?: string
    resumeClaudeSessionId?: string
    records: Record<string, PersistedSession>
    selection?: AiAuthSelection
}): string | undefined {
    const evidence: Evidence[] = []
    const parent = input.parentSessionId ? input.records[input.parentSessionId] : undefined
    if (parent) { const found = evidenceOf(parent); if (found) evidence.push(found) }
    if (input.resumeClaudeSessionId) {
        for (const record of Object.values(input.records)) {
            if ((record.metadata as { claudeSessionId?: unknown }).claudeSessionId !== input.resumeClaudeSessionId) continue
            const found = evidenceOf(record)
            if (found) evidence.push(found)
        }
    }
    if (evidence.length === 0) return undefined
    const selection = input.selection
    const sameEndpoint = selection?.kind === 'org-endpoint'
        && evidence.every((found) => found.endpointId !== undefined && found.endpointId === selection.endpointId)
    if (sameEndpoint) return undefined
    return 'ORG_LLM_ENDPOINT_PARENT_BOUND: this conversation ran on an organization LLM endpoint and cannot be continued in a new session '
        + 'under another model source; continue it on the same endpoint.'
}

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
import { isOrgEndpointConversationAnywhere } from '@/claude/utils/orgEndpointConversation'
import { parseOrgEndpointBinding } from './sessionEnv'

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

/** Whether the record proves an endpoint binding, even a corrupt one (which endpoint it was is no longer relevant). */
export function isOrgEndpointBoundRecord(record: PersistedSession): boolean {
    if (record.agentEnvironment?.[ORG_ENDPOINT_BINDING_ENV] !== undefined) return true
    const marked = (record.metadata as { orgLlmEndpoint?: unknown }).orgLlmEndpoint
    return marked !== undefined && marked !== null
}

/**
 * The refusal for a spawn that continues a conversation (`parentSessionId`, or a native `resumeClaudeSessionId` that
 * some recorded session ran) when that conversation ran on an endpoint. No selection excuses it, not even one of the same
 * endpoint: a new binding would carry the conversation to another URL or generation. Continuing the same session goes
 * through the resume path, whose resume-check pins both. Only this machine is visible here: a parent on another
 * machine is the requester's check, through the metadata marker. A native id is known by the conversation's mark
 * beside its transcript (orgEndpointConversation) — the record learns no Claude id until a resume, and a fork has a new one.
 */
export function orgEndpointParentRefusal(input: {
    parentSessionId?: string
    resumeClaudeSessionId?: string
    records: Record<string, PersistedSession>
    /** The spawn directory's Claude project directory, where a resumed transcript is looked for. */
    projectDir: string
}): string | undefined {
    const parent = input.parentSessionId ? input.records[input.parentSessionId] : undefined
    const bound = (parent !== undefined && isOrgEndpointBoundRecord(parent))
        || (input.resumeClaudeSessionId !== undefined && (isOrgEndpointConversationAnywhere(input.projectDir, input.resumeClaudeSessionId)
            || Object.values(input.records).some((record) =>
                (record.metadata as { claudeSessionId?: unknown }).claudeSessionId === input.resumeClaudeSessionId && isOrgEndpointBoundRecord(record))))
    if (!bound) return undefined
    return 'ORG_LLM_ENDPOINT_PARENT_BOUND: this conversation ran on an organization LLM endpoint and cannot be continued in a new session; '
        + 'resume the same session, or start a new conversation.'
}

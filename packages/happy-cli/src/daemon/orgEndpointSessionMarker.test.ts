import { describe, expect, it } from 'vitest'
import type { PersistedSession } from '@/persistence'
import { ORG_ENDPOINT_BINDING_ENV } from '@/utils/childEnv'
import { isOrgEndpointBoundMetadata, orgEndpointMarker, orgEndpointParentRefusal } from './orgEndpointSessionMarker'

// aplus specs/org-llm-endpoints r3 — what ties a conversation to an organization LLM endpoint outlives one daemon record.

const BINDING = 'binding-1:endpoint-1:target-a:3'
const marker = { version: 1 as const, bindingId: 'binding-1', endpointId: 'endpoint-1' }

function record(over: { env?: Record<string, string | undefined>; metadata?: Record<string, unknown> } = {}): PersistedSession {
    return {
        encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 1, metadataVersion: 1, agentStateVersion: 1, savedAt: 1,
        metadata: { path: '/p', host: 'h', claudeSessionId: 'claude-1', ...over.metadata },
        ...(over.env ? { agentEnvironment: over.env } : {}),
    } as PersistedSession
}
const endpointSelection = (endpointId: string) => ({ kind: 'org-endpoint' as const, bindingId: 'binding-2', endpointId, generation: 3, candidates: ['target-a'] })

describe('the session marker', () => {
    it('is the non-secret binding and endpoint, version 1', () => {
        expect(orgEndpointMarker(`${BINDING}`)).toEqual(marker)
        expect(JSON.stringify(orgEndpointMarker(BINDING))).not.toMatch(/target|token|generation/)
    })

    it.each([undefined, '', 'a:b:c', 'a:b:c:0', 'a b:b:c:1'])('is absent for an environment with no valid binding (%j)', (value) => {
        expect(orgEndpointMarker(value)).toBeUndefined()
    })

    it('recognizes bound session metadata by the field alone, whatever it holds', () => {
        expect(isOrgEndpointBoundMetadata({ orgLlmEndpoint: marker })).toBe(true)
        expect(isOrgEndpointBoundMetadata({ orgLlmEndpoint: 'anything' })).toBe(true)
        expect(isOrgEndpointBoundMetadata({})).toBe(false)
        expect(isOrgEndpointBoundMetadata({ orgLlmEndpoint: null })).toBe(false)
        expect(isOrgEndpointBoundMetadata(undefined)).toBe(false)
    })
})

describe('a spawn that continues another conversation', () => {
    const bound = record({ env: { [ORG_ENDPOINT_BINDING_ENV]: BINDING }, metadata: { orgLlmEndpoint: marker } })

    it('is refused when the parent session ran on an endpoint, by its binding record', () => {
        const refusal = orgEndpointParentRefusal({ parentSessionId: 'parent-1', records: { 'parent-1': record({ env: { [ORG_ENDPOINT_BINDING_ENV]: BINDING } }) } })
        expect(refusal).toMatch(/^ORG_LLM_ENDPOINT_PARENT_BOUND/)
    })

    it('is refused when the parent session ran on an endpoint, by the marker in its metadata alone', () => {
        expect(orgEndpointParentRefusal({ parentSessionId: 'parent-1', records: { 'parent-1': record({ metadata: { orgLlmEndpoint: marker } }) } })).toMatch(/ORG_LLM_ENDPOINT_PARENT_BOUND/)
    })

    it('is refused when the native conversation to resume belongs to an endpoint session, found through its Claude id', () => {
        expect(orgEndpointParentRefusal({ resumeClaudeSessionId: 'claude-1', records: { other: record({ metadata: { claudeSessionId: 'claude-9' } }), 'parent-1': bound } }))
            .toMatch(/ORG_LLM_ENDPOINT_PARENT_BOUND/)
    })

    it('is refused when the recorded binding is corrupt, since what it was bound to is unknown', () => {
        expect(orgEndpointParentRefusal({ parentSessionId: 'parent-1', records: { 'parent-1': record({ env: { [ORG_ENDPOINT_BINDING_ENV]: '' } }) } })).toMatch(/ORG_LLM_ENDPOINT_PARENT_BOUND/)
    })

    it('is refused under any selection, the same endpoint included: a same-session resume goes through resume-check, which pins URL and generation', () => {
        // Inputs are built as variables: the function takes no selection, so a literal would be an excess property.
        for (const selection of [undefined, { kind: 'org-bundle' as const }, { kind: 'machine-personal' as const }, endpointSelection('endpoint-2'), endpointSelection('endpoint-1')]) {
            for (const input of [
                { parentSessionId: 'parent-1', records: { 'parent-1': bound }, selection },
                { resumeClaudeSessionId: 'claude-1', records: { 'parent-1': bound }, selection },
                { parentSessionId: 'parent-1', resumeClaudeSessionId: 'claude-1', records: { 'parent-1': bound }, selection },
            ]) expect(orgEndpointParentRefusal(input)).toMatch(/ORG_LLM_ENDPOINT_PARENT_BOUND/)
        }
    })

    it('leaves every other spawn alone: no parent, an unknown parent, an ordinary parent, an ordinary resume', () => {
        const ordinary = record()
        expect(orgEndpointParentRefusal({ records: { 'parent-1': bound } })).toBeUndefined()
        expect(orgEndpointParentRefusal({ parentSessionId: 'unknown', records: { 'parent-1': bound } })).toBeUndefined()
        expect(orgEndpointParentRefusal({ parentSessionId: 'parent-1', records: { 'parent-1': ordinary } })).toBeUndefined()
        expect(orgEndpointParentRefusal({ resumeClaudeSessionId: 'claude-1', records: { 'parent-1': ordinary } })).toBeUndefined()
        expect(orgEndpointParentRefusal({ resumeClaudeSessionId: 'never-seen', records: { 'parent-1': bound } })).toBeUndefined()
    })

    it('names no session id, address or token in the refusal', () => {
        const refusal = orgEndpointParentRefusal({ parentSessionId: 'parent-1', records: { 'parent-1': bound } })!
        expect(refusal).not.toMatch(/parent-1|binding-1|endpoint-1|target-a/)
    })
})

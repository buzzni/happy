import { describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type AgentGrant, type GrantId, type ProfileId } from './contracts'
import { mintAgentGrant, mintInteractiveCapability, verifyToken } from './auth'

const keys = { agentKey: 'synthetic-agent-key', interactiveKey: 'synthetic-ui-key' }
const grant = (operations: AgentGrant['operations'] = ['getTask']): AgentGrant => ({
    kind: 'agent-grant', grantId: 'g1' as GrantId, principalId: 'p1' as never, workspaceId: 'w1' as never,
    machineId: 'm1' as never, agentSessionId: 'a1' as never, profileId: 'profile1' as ProfileId,
    allowedOrigins: ['https://fixture.test'], operations, taskSpaceIds: [], issuedAtMs: 10, expiresAtMs: 1000,
})

describe('signed credential kinds', () => {
    it('uses separate signing keys and rejects interactive operation escalation at mint and verify', () => {
        expect(() => mintAgentGrant(grant(['approve' as never]), keys, 20)).toThrowError(BrowserRuntimeError)
        const agentToken = mintAgentGrant(grant(), keys, 20)
        expect(() => verifyToken(agentToken, { ...keys, agentKey: 'wrong-key' }, 20)).toThrowError(BrowserRuntimeError)
        const interactiveToken = mintInteractiveCapability({ kind: 'interactive', capabilityId: 'c1', principalId: 'p1' as never, workspaceId: 'w1' as never, machineId: 'm1' as never, viewerSessionId: 'v1', profileId: 'profile1' as ProfileId, operations: ['approve'], issuedAtMs: 10, expiresAtMs: 1000 }, keys, 20)
        expect(() => verifyToken(interactiveToken, keys, 20, new Set(['c1']))).toThrowError(BrowserRuntimeError)
        expect(verifyToken(agentToken, keys, 20).credential.kind).toBe('agent-grant')
    })

    it('rejects expired and overlong grants', () => {
        expect(() => mintAgentGrant({ ...grant(), expiresAtMs: 10 + 3_600_000 + 1 }, keys, 20)).toThrowError(BrowserRuntimeError)
        const token = mintAgentGrant(grant(), keys, 20)
        expect(() => verifyToken(token, keys, 1000)).toThrowError(BrowserRuntimeError)
    })
})

import { describe, expect, it } from 'vitest'
import { assertPersonalEndpointWorkspace, buildPersonalEndpointEnvironment, parsePersonalEndpointSelection } from './personalLlmEndpoint'
import { verifyAiAuthSelection } from './sessionEnv'
import { foldModelToOrgEndpoint } from '@/claude/utils/orgEndpointModel'
import { orgEndpointLocalModeRefusal } from '@/claude/utils/orgEndpointLocalMode'
const selection = { kind: 'personal-endpoint', issuer: 'https://studio.example.test', ownerUserId: 'a', endpointId: 'ep', generation: 1, ticket: 'a'.repeat(43) } as const
const relay = { version: 1, leaseId: 'lease', baseUrl: 'http://127.0.0.1:1234/inference/lease', relayToken: 'relay-secret-long-value', model: 'local-model', modelTiers: {}, maxContextTokens: 32768, apiTimeoutMs: 30000, workspace: { projectId: 'project' }, purpose: 'start' }
describe('personal endpoint launches', () => {
  it('accepts only closed scoped selections and rejects missing/unknown credential data', () => {
    expect(parsePersonalEndpointSelection(selection)).toEqual(selection)
    expect(() => parsePersonalEndpointSelection({ ...selection, token: 'secret' })).toThrow()
    expect(() => parsePersonalEndpointSelection({ ...selection, ticket: '' })).toThrow()
  })
  it('marks only an applied local relay and pins model/remote mode without upstream secrets', () => {
    const env = buildPersonalEndpointEnvironment(selection, 'pc', relay)
    expect(env.HAPPY_AI_AUTH_SOURCE).toBe('personal-endpoint')
    expect(verifyAiAuthSelection(selection, env).rejection).toBeUndefined()
    expect(foldModelToOrgEndpoint('claude-opus-5-5', env)).toBe('local-model')
    expect(orgEndpointLocalModeRefusal(env)).toBeTruthy()
    expect(env.HAPPY_AI_AUTH_PERSONAL_ENDPOINT_BINDING).not.toContain(selection.ticket)
    expect(() => buildPersonalEndpointEnvironment(selection, 'pc', { ...relay, baseUrl: 'https://attacker.example.test' })).toThrow()
  })
})

it('requires the granted workspace to equal the actual launch or frozen resume workspace', () => {
  expect(() => assertPersonalEndpointWorkspace({ projectId: 'p' }, { projectId: 'p' })).not.toThrow()
  for (const actual of [{}, { projectId: 'other' }, { personalChatId: 'chat' }, { projectId: 'p', personalChatId: 'chat' }]) expect(() => assertPersonalEndpointWorkspace({ projectId: 'p' }, actual)).toThrow('PERSONAL_ENDPOINT_WORKSPACE_MISMATCH')
})

import { describe, expect, it, vi } from 'vitest'
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
  it('preserves machine proxy and extra CA while appending local bypasses for the relay', () => {
    const machine = { HTTPS_PROXY: 'https://corp.proxy', HTTP_PROXY: 'http://corp.proxy', NODE_EXTRA_CA_CERTS: '/corp/ca.pem', NO_PROXY: 'corp.internal' }
    for (const [key, value] of Object.entries(machine)) vi.stubEnv(key, value)
    try {
      const env = buildPersonalEndpointEnvironment(selection, 'pc', relay)
      expect(env.HTTPS_PROXY).toBe(machine.HTTPS_PROXY)
      expect(env.HTTP_PROXY).toBe(machine.HTTP_PROXY)
      expect(env.NODE_EXTRA_CA_CERTS).toBe(machine.NODE_EXTRA_CA_CERTS)
      expect(env.NO_PROXY?.split(',')).toEqual(['corp.internal', '127.0.0.1', 'localhost', '::1'])
      expect(env.no_proxy).toBe(env.NO_PROXY)
      expect(process.env.NO_PROXY).toBe('corp.internal')
    } finally { vi.unstubAllEnvs() }
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

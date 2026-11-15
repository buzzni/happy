import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ORG_ENDPOINT_CLEARED_ENV_KEYS, ORG_ENDPOINT_MACHINE_ENV_KEYS } from '@/claude/utils/orgEndpointEnvKeys'
export const PERSONAL_ENDPOINT_LEASE_ENV = 'HAPPY_AI_AUTH_PERSONAL_ENDPOINT_LEASE'
import { PERSONAL_ENDPOINT_BINDING_ENV } from '@/utils/childEnv'
export { PERSONAL_ENDPOINT_BINDING_ENV } from '@/utils/childEnv'
export type PersonalEndpointSelection = { kind: 'personal-endpoint'; issuer: string; ownerUserId: string; endpointId: string; generation: number; ticket: string }
export type PersonalEndpointMarker = { endpointId: string; generation: number; ownerUserId: string; issuer: string; machineId: string; name: string; model: string; workspace: Record<string, string> }
const object = (v: unknown): Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,128}$/.test(v)
const fail = (): never => { throw Error('PERSONAL_ENDPOINT_INVALID') }
export function parsePersonalEndpointSelection(value: unknown): PersonalEndpointSelection {
  const v = object(value)
  if (Object.keys(v).some(k => !['kind', 'issuer', 'ownerUserId', 'endpointId', 'generation', 'ticket'].includes(k)) || v.kind !== 'personal-endpoint' || !identifier(v.ownerUserId) || !identifier(v.endpointId) || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1 || typeof v.ticket !== 'string' || !/^[\w-]{43}$/.test(v.ticket)) return fail()
  let origin: URL; try { origin = new URL(String(v.issuer)) } catch { return fail() }
  if (origin.origin !== v.issuer || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) return fail()
  return v as PersonalEndpointSelection
}
export function personalEndpointMarker(raw?: string): PersonalEndpointMarker | undefined {
  if (raw === undefined) return undefined
  try {
    const v = object(JSON.parse(raw))
    if (!identifier(v.endpointId) || !identifier(v.ownerUserId) || !identifier(v.machineId) || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1 || typeof v.issuer !== 'string' || typeof v.name !== 'string' || typeof v.model !== 'string') return fail()
    assertPersonalEndpointWorkspace(v.workspace, v.workspace)
    return v as PersonalEndpointMarker
  } catch { return fail() }
}
/** Descriptor and proof material never cross a Happy RPC. Only public registration info leaves this call. */
export async function callPersonalEndpointBroker(input: Record<string, unknown>, home = process.env.APLUS_PERSONAL_AI_BRIDGE_HOME_DIR || homedir()): Promise<Record<string, unknown>> {
  const d = object(JSON.parse(await readFile(join(home, '.aplus', 'personal-llm-endpoint-bridge.json'), 'utf8')))
  if (d.version !== 1 || !Number.isInteger(d.port) || Number(d.port) < 1 || Number(d.port) > 65535 || typeof d.secret !== 'string' || !/^[a-f0-9]{64}$/.test(d.secret)) return fail()
  const response = await fetch(`http://127.0.0.1:${d.port}/rpc`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { 'Content-Type': 'application/json', 'X-Saycode-Bridge': d.secret }, body: JSON.stringify({ ...input, daemonPid: process.pid }) })
  const text = await response.text(); if (text.length > 32_000) return fail()
  const value = object(JSON.parse(text))
  if (!response.ok) {
    const allowed = new Set(['PERSONAL_ENDPOINT_REAUTH_REQUIRED', 'PERSONAL_ENDPOINT_DEVICE_REVOKED', 'PERSONAL_ENDPOINT_DEVICE_KEY_CHANGED', 'PERSONAL_ENDPOINT_CHANGED', 'PERSONAL_ENDPOINT_GRANT_REFUSED', 'PERSONAL_ENDPOINT_POLICY_DENIED', 'PERSONAL_ENDPOINT_CONTEXT_MISMATCH', 'PERSONAL_ENDPOINT_KEYSTORE_UNAVAILABLE', 'PERSONAL_ENDPOINT_ENROLL_PENDING'])
    throw Error(typeof value.error === 'string' && allowed.has(value.error) ? value.error : 'PERSONAL_ENDPOINT_BROKER_UNAVAILABLE')
  }
  return value
}
export function buildPersonalEndpointEnvironment(selection: PersonalEndpointSelection, machineId: string, value: unknown): Record<string, string> {
  const v = object(value)
  let url: URL; try { url = new URL(String(v.baseUrl)) } catch { return fail() }
  if (v.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/inference\/[\w-]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash || typeof v.relayToken !== 'string' || !/^[\w-]{16,128}$/.test(v.relayToken) || typeof v.model !== 'string' || !/^[!-~]{1,200}$/.test(v.model) || !Number.isSafeInteger(v.maxContextTokens) || Number(v.maxContextTokens) < 1024 || !Number.isSafeInteger(v.apiTimeoutMs) || Number(v.apiTimeoutMs) < 10_000) return fail()
  if (v.purpose !== 'test') assertPersonalEndpointWorkspace(v.workspace, v.workspace)
  const tiers = object(v.modelTiers), env: Record<string, string> = Object.fromEntries([...ORG_ENDPOINT_CLEARED_ENV_KEYS, ...ORG_ENDPOINT_MACHINE_ENV_KEYS].map(key => [key, '']))
  Object.assign(env, { ANTHROPIC_BASE_URL: url.toString().replace(/\/$/, ''), ANTHROPIC_AUTH_TOKEN: v.relayToken, ANTHROPIC_MODEL: v.model, CLAUDE_CODE_SUBAGENT_MODEL: v.model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(v.maxContextTokens), API_TIMEOUT_MS: String(v.apiTimeoutMs), CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', HAPPY_AI_AUTH_SOURCE: 'personal-endpoint', NO_PROXY: '127.0.0.1,localhost,::1', NODE_TLS_REJECT_UNAUTHORIZED: '1' })
  for (const tier of ['OPUS', 'SONNET', 'HAIKU', 'FABLE']) env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = typeof tiers[tier.toLowerCase()] === 'string' ? String(tiers[tier.toLowerCase()]) : v.model
  if (typeof v.leaseId !== 'string' || !/^[\w-]{1,128}$/.test(v.leaseId)) return fail()
  env[PERSONAL_ENDPOINT_LEASE_ENV] = v.leaseId
  env[PERSONAL_ENDPOINT_BINDING_ENV] = JSON.stringify({ endpointId: selection.endpointId, generation: selection.generation, issuer: selection.issuer, ownerUserId: selection.ownerUserId, machineId, name: typeof v.name === 'string' ? v.name : 'Local LLM', model: v.model, workspace: v.workspace })
  return env
}
/** The broker's server-approved scope must equal the real spawn and the frozen resume scope. */
export function assertPersonalEndpointWorkspace(granted: unknown, actual: unknown) {
  const valid = (raw: unknown) => {
    const v = object(raw)
    return Object.keys(v).every(k => ['projectId', 'personalChatId'].includes(k))
      && Number(identifier(v.projectId)) + Number(identifier(v.personalChatId)) === 1
      && (v.projectId === undefined || identifier(v.projectId)) && (v.personalChatId === undefined || identifier(v.personalChatId))
  }
  const a = object(granted), b = object(actual)
  if (!valid(granted) || !valid(actual) || a.projectId !== b.projectId || a.personalChatId !== b.personalChatId) throw Error('PERSONAL_ENDPOINT_WORKSPACE_MISMATCH')
}
export async function personalEndpointEnvironment(agent: string | undefined, selection: PersonalEndpointSelection, machineId: string, purpose: 'start' | 'resume' = 'start', workspace: { projectId?: string; personalChatId?: string } = {}) {
  if (agent && agent !== 'claude') throw Error('PERSONAL_ENDPOINT_CLAUDE_REQUIRED')
  assertPersonalEndpointWorkspace(workspace, workspace)
  const relay = await callPersonalEndpointBroker({ ...selection, machineId, operation: 'acquire', userId: selection.ownerUserId })
  try {
    if (relay.purpose !== purpose) throw Error('PERSONAL_ENDPOINT_PURPOSE_MISMATCH')
    assertPersonalEndpointWorkspace(relay.workspace, workspace)
    return buildPersonalEndpointEnvironment(selection, machineId, relay)
  } catch (error) {
    if (typeof relay.leaseId === 'string') await callPersonalEndpointBroker({ issuer: selection.issuer, userId: selection.ownerUserId, machineId, operation: 'release', leaseId: relay.leaseId }).catch(() => console.warn('[personal-llm] refused launch cleanup unavailable'))
    throw error
  }
}

export async function releasePersonalEndpointEnvironment(env: Record<string, string | undefined> | undefined) {
  const marker = personalEndpointMarker(env?.[PERSONAL_ENDPOINT_BINDING_ENV]), leaseId = env?.[PERSONAL_ENDPOINT_LEASE_ENV]
  if (marker && leaseId) await callPersonalEndpointBroker({ issuer: marker.issuer, userId: marker.ownerUserId, machineId: marker.machineId, operation: 'release', leaseId })
}

export async function bindPersonalEndpointLease(env: Record<string, string | undefined>, childPid: number) {
  const marker = personalEndpointMarker(env[PERSONAL_ENDPOINT_BINDING_ENV]), leaseId = env[PERSONAL_ENDPOINT_LEASE_ENV]
  if (marker && leaseId) await callPersonalEndpointBroker({ issuer: marker.issuer, userId: marker.ownerUserId, machineId: marker.machineId, operation: 'attach', leaseId, childPid })
}

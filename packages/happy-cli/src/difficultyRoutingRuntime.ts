import tweetnacl from 'tweetnacl'
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { decodeBase64, encodeBase64, getRandomBytes } from '@/api/encryption'
import {
  DIFFICULTY_ROUTING_POLICY_VERSION,
  pickDifficultyRoutingPrompt,
} from './difficultyRouting'
import {
  classifyDifficultyHeuristic,
  isSupportedRoutedModelEffort,
  resolveEscalation,
  routeSendModelOptionsWithDifficulty,
  shouldReusePreviousDifficultyForContinuation,
  type ClassifiableDifficulty,
  type Difficulty,
  type RoutableAgent,
  type SendModelOptionsResult,
} from './difficultyRoutingPolicy'

export type DifficultyRoutingState = {
  difficulty?: Difficulty
  hardTurns?: number
  updatedAt?: number
}

export type DifficultyRoutingRuntimeInput = {
  agent: RoutableAgent
  sourceMachineId: string
  sessionId: string
  contentText: string
  meta: Record<string, unknown> | undefined
  current: { model?: string; effort?: string | null }
  state?: DifficultyRoutingState
}

export type DifficultyRoutingRuntimeDecision = {
  route: SendModelOptionsResult
  state: DifficultyRoutingState
  event: SessionEnvelope
}

type GrantOk = {
  ok: true
  grant: {
    policyRevision: number
    expiresAt: number
    sourceMachineId: string
    hostMachineId: string
    hostProcessKeyId: string
    hostProcessPublicKey: string
    maxInputChars: 8000
    modelMaxInputTokens: 512
    relayDeadlineAt: number
  }
  signedGrant: string
  aiModelPolicy: DifficultyRoutingAiModelPolicy
}

type DifficultyRoutingAiModelPolicy = {
  source: 'unrestricted' | 'organization' | 'member'
  allowedSelectionKeys: string[] | null
  defaultSelectionKey: string | null
}

type RelayResponse = {
  version: 1
  requestId: string
  policyRevision: number
  status: 'ok' | 'busy' | 'not-ready' | 'expired' | 'revoked' | 'unsupported' | 'error'
  difficulty?: ClassifiableDifficulty | null
  classifierRevision?: string
}

const STICKY_IDLE_RESET_MS = 60 * 60 * 1000
const RUNTIME_ROUTING_DEADLINE_MS = 750
let circuitBreakerUntil = 0
let consecutiveFailures = 0

/**
 * Every exit of `resolveDifficultyRouting` reports why, because a failure here
 * is invisible by design: the turn silently keeps the client's model. Without
 * this the only field evidence was the byte size of an encrypted relay
 * response, which cannot distinguish "classified but discarded" from
 * "never classified".
 *
 * Never pass the prompt, the intent or the turn authorization — the contract
 * keeps routing text out of logs (`difficultyRoutingRuntime.test.ts` pins it).
 */
function logRoutingOutcome(
  outcome: string,
  detail: Record<string, string | number | boolean | null | undefined> = {},
): void {
  logger.debug(`[difficultyRouting] ${outcome}`, detail)
}

/**
 * A decision builder returns null when the routed model/effort is unusable or
 * the org AI policy disallows it. That discard is the one outcome that looks
 * identical to "routing never ran" from outside, so name it explicitly.
 */
function logDecision(
  classifierSource: string,
  decision: DifficultyRoutingRuntimeDecision | null,
  clientRequestId: string,
  remoteStatus?: string,
): DifficultyRoutingRuntimeDecision | null {
  if (!decision) {
    logRoutingOutcome('decision-discarded', { classifierSource, clientRequestId, remoteStatus })
    return null
  }
  logRoutingOutcome('applied', {
    classifierSource,
    clientRequestId,
    remoteStatus,
    model: decision.route.model,
    effort: decision.route.effort,
    difficulty: decision.route.difficulty,
  })
  return decision
}

export async function resolveDifficultyRouting(
  input: DifficultyRoutingRuntimeInput,
): Promise<DifficultyRoutingRuntimeDecision | null> {
  const intent = input.meta?.difficultyRoutingIntent
  if (hasManualModelOverride(input.meta)) {
    logRoutingOutcome('skipped', { reason: 'manual-model-override', sessionId: input.sessionId })
    return null
  }
  const clientRequestId = typeof intent === 'object' && intent !== null
    ? (intent as Record<string, unknown>).clientRequestId
    : undefined
  if (typeof clientRequestId !== 'string' || !clientRequestId) {
    logRoutingOutcome('skipped', { reason: 'missing-client-request-id', sessionId: input.sessionId })
    return null
  }
  const prompt = pickDifficultyRoutingPrompt({
    intent,
    contentText: input.contentText,
    metaPrompt: input.meta?.difficultyRoutingPrompt,
  })
  if (prompt === null) {
    logRoutingOutcome('skipped', { reason: 'prompt-not-routable', sessionId: input.sessionId, clientRequestId })
    return null
  }
  const authorization = typeof input.meta?.difficultyRoutingAuthorization === 'string'
    ? input.meta.difficultyRoutingAuthorization
    : ''
  if (!authorization) {
    logRoutingOutcome('skipped', { reason: 'missing-authorization', sessionId: input.sessionId, clientRequestId })
    return null
  }
  const deadline = Date.now() + RUNTIME_ROUTING_DEADLINE_MS
  let grant: GrantRequestResult
  try {
    grant = await requestGrant(input, clientRequestId, deadline)
  } catch (error) {
    noteRemoteFailure()
    logRoutingOutcome('grant-request-failed', {
      clientRequestId,
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return null
  }
  if (!grant.ok) {
    if ((grant.reason === 'host-unavailable' || grant.reason === 'unsupported') && grant.aiModelPolicy) {
      const p1 = classifyDifficultyHeuristic(prompt)
      noteRemoteFailure()
      logRoutingOutcome('grant-rejected-falling-back', { clientRequestId, reason: grant.reason, failureStage: grant.failureStage })
      return logDecision('fallback-p1', buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, null, undefined, 'fallback-p1', grant.aiModelPolicy), clientRequestId, grant.reason)
    }
    logRoutingOutcome('skipped', {
      reason: grant.reason ?? 'grant-rejected',
      failureStage: grant.failureStage,
      httpStatus: grant.httpStatus,
      failed: grant.failed?.join(','),
      expiresInMs: grant.expiresInMs,
      relayDeadlineInMs: grant.relayDeadlineInMs,
      clientRequestId,
    })
    return null
  }

  const p1 = classifyDifficultyHeuristic(prompt)
  if (p1.confident || shouldReusePreviousDifficultyForContinuation(prompt, freshPreviousDifficulty(input.state)) || circuitBreakerUntil > Date.now()) {
    return logDecision('p1-local', buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, grant.value.grant.policyRevision, undefined, 'p1-local', grant.value.aiModelPolicy), clientRequestId)
  }

  try {
    const sealedText = sealText(prompt, grant.value.grant.hostProcessPublicKey)
    const relay = await requestRelay({
      requestId: clientRequestId,
      signedGrant: grant.value.signedGrant,
      policyRevision: grant.value.grant.policyRevision,
      sourceMachineId: grant.value.grant.sourceMachineId,
      hostMachineId: grant.value.grant.hostMachineId,
      hostProcessKeyId: grant.value.grant.hostProcessKeyId,
      deadlineAt: Math.min(grant.value.grant.relayDeadlineAt, deadline),
      sealedText,
    }, deadline)
    if (relay.status !== 'ok' || !relay.difficulty) {
      noteRemoteFailure()
      return logDecision('fallback-p1', buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, grant.value.grant.policyRevision, relay.status, 'fallback-p1', grant.value.aiModelPolicy), clientRequestId, relay.status)
    }
    consecutiveFailures = 0

    return logDecision('p2-org-shared', buildRemoteDecision(input, prompt, clientRequestId, relay.difficulty, grant.value.grant.policyRevision, relay, grant.value.aiModelPolicy), clientRequestId, relay.status)
  } catch (error) {
    const p1 = classifyDifficultyHeuristic(prompt)
    noteRemoteFailure()
    logRoutingOutcome('relay-request-failed', {
      clientRequestId,
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return logDecision('fallback-p1', buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, null, undefined, 'fallback-p1', grant.value.aiModelPolicy), clientRequestId)
  }
}

function buildRemoteDecision(
  input: DifficultyRoutingRuntimeInput,
  prompt: string,
  clientRequestId: string,
  difficulty: ClassifiableDifficulty,
  policyRevision: number,
  relay: RelayResponse,
  aiModelPolicy: DifficultyRoutingAiModelPolicy,
): DifficultyRoutingRuntimeDecision | null {
  const priorState = freshState(input.state)
  const previousDifficulty = priorState?.difficulty
  const ageMs = priorState?.updatedAt ? Date.now() - priorState.updatedAt : undefined
  const baseRoute = routeSendModelOptionsWithDifficulty(
    input.agent,
    prompt,
    {},
    difficulty,
    previousDifficulty,
  )
  const escalated = resolveEscalation(input.agent, prompt, baseRoute, {
    hardTurns: priorState?.hardTurns,
    ageMs,
  })
  if (!escalated.routed.model || !escalated.routed.effort) return null
  if (!isSupportedRoutedModelEffort(input.agent, escalated.routed)) return null
  const routed = resolveRouteAllowedByAiPolicy(input.agent, escalated.routed, input.current, aiModelPolicy)
  if (!routed?.model || !routed.effort) return null
  const state: DifficultyRoutingState = {
    difficulty: escalated.stickyDifficulty,
    hardTurns: escalated.hardTurns,
    updatedAt: Date.now(),
  }
  return {
    route: routed,
    state,
    event: createDifficultyRoutingEvent({
      clientRequestId,
      policyRevision,
      route: routed,
      classifierSource: 'p2-org-shared',
      remoteStatus: relay.status,
      classifierRevision: relay.classifierRevision,
    }),
  }
}

function buildLocalDecision(
  input: DifficultyRoutingRuntimeInput,
  prompt: string,
  clientRequestId: string,
  difficulty: ClassifiableDifficulty,
  policyRevision: number | null = null,
  remoteStatus?: RelayResponse['status'],
  classifierSource: 'p1-local' | 'fallback-p1' = 'fallback-p1',
  aiModelPolicy?: DifficultyRoutingAiModelPolicy,
): DifficultyRoutingRuntimeDecision | null {
  const state = freshState(input.state)
  const previousDifficulty = state?.difficulty
  const ageMs = state?.updatedAt ? Date.now() - state.updatedAt : undefined
  const baseRoute = routeSendModelOptionsWithDifficulty(input.agent, prompt, {}, difficulty, previousDifficulty, 'p1')
  const escalated = resolveEscalation(input.agent, prompt, baseRoute, {
    hardTurns: state?.hardTurns,
    ageMs,
  })
  if (!escalated.routed.model || !escalated.routed.effort) return null
  if (!isSupportedRoutedModelEffort(input.agent, escalated.routed)) return null
  const routed = resolveRouteAllowedByAiPolicy(input.agent, escalated.routed, input.current, aiModelPolicy)
  if (!routed?.model || !routed.effort) return null
  return {
    route: routed,
    state: {
      difficulty: escalated.stickyDifficulty,
      hardTurns: escalated.hardTurns,
      updatedAt: Date.now(),
    },
    event: createDifficultyRoutingEvent({
      clientRequestId,
      policyRevision,
      route: routed,
      classifierSource,
      remoteStatus,
    }),
  }
}

/**
 * A rejected grant used to collapse to `{ ok: false }` with no reason on four
 * different paths, so the field log could not tell a broken response from a
 * failed check. Name the stage; keep whatever reason the server did send.
 */
type GrantRequestResult =
  | { ok: true; value: GrantOk }
  | {
    ok: false
    failureStage: 'parse' | 'http' | 'response' | 'validation'
    reason?: string
    httpStatus?: number
    failed?: GrantFailureCode[]
    expiresInMs?: number
    relayDeadlineInMs?: number
    aiModelPolicy?: DifficultyRoutingAiModelPolicy
  }

async function requestGrant(
  input: DifficultyRoutingRuntimeInput,
  clientRequestId: string,
  deadline: number,
): Promise<GrantRequestResult> {
  const response = await fetch(`${resolveAplusApiOrigin()}/api/me/difficulty-routing/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
      'X-Aplus-Machine-Id': input.sourceMachineId,
    },
    body: JSON.stringify({
      version: 1,
      clientRequestId,
      authorization: input.meta?.difficultyRoutingAuthorization,
      sourceMachineId: input.sourceMachineId,
      sessionId: input.sessionId,
      policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
      intent: input.meta?.difficultyRoutingIntent,
    }),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  })
  const body = await response.json().catch(() => null) as unknown
  if (!body || typeof body !== 'object') return { ok: false, failureStage: 'parse' }
  const record = body as Record<string, unknown>
  const reason = typeof record.reason === 'string' ? record.reason : undefined
  if (!response.ok) {
    return {
      ok: false,
      failureStage: 'http',
      httpStatus: response.status,
      reason,
      aiModelPolicy: parseAiModelPolicy(record.aiModelPolicy),
    }
  }
  if (record.ok !== true) {
    return { ok: false, failureStage: 'response', reason, aiModelPolicy: parseAiModelPolicy(record.aiModelPolicy) }
  }
  const validation = validateGrant(record, { clientRequestId, sourceMachineId: input.sourceMachineId }, Date.now())
  if (!validation.ok) {
    return {
      ok: false,
      failureStage: 'validation',
      failed: validation.failed,
      expiresInMs: validation.expiresInMs,
      relayDeadlineInMs: validation.relayDeadlineInMs,
    }
  }
  return { ok: true, value: validation.value }
}

async function requestRelay(input: {
  requestId: string
  signedGrant: string
  policyRevision: number
  sourceMachineId: string
  hostMachineId: string
  hostProcessKeyId: string
  deadlineAt: number
  sealedText: ReturnType<typeof sealText>
}, deadline: number): Promise<RelayResponse> {
  const response = await fetch(`${resolveAplusApiOrigin()}/api/me/difficulty-routing/classify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
      'X-Aplus-Machine-Id': input.sourceMachineId,
    },
    body: JSON.stringify({
      version: 1,
      requestId: input.requestId,
      signedGrant: input.signedGrant,
      policyRevision: input.policyRevision,
      sourceMachineId: input.sourceMachineId,
      hostMachineId: input.hostMachineId,
      hostProcessKeyId: input.hostProcessKeyId,
      deadlineAt: input.deadlineAt,
      sealedText: input.sealedText,
    }),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  })
  if (!response.ok) return {
    version: 1,
    requestId: input.requestId,
    policyRevision: input.policyRevision,
    status: 'error',
  }
  const body = await response.json().catch(() => null) as { ok?: unknown; result?: unknown } | null
  const result = body?.ok === true && isRelayResponse(body.result, input.requestId, input.policyRevision)
    ? body.result
    : null
  return result ?? {
    version: 1,
    requestId: input.requestId,
    policyRevision: input.policyRevision,
    status: 'error',
  }
}

/**
 * Every condition is evaluated, not short-circuited: a single reported cause
 * sends the next investigation at the wrong field when several are wrong at
 * once. Returns the narrowed grant on success so callers keep type safety
 * without a cast.
 *
 * `now` is captured once by the caller and shared with the log, because
 * reading the clock twice makes the reported remainder disagree with the
 * decision that used it.
 */
type GrantFailureCode =
  | 'ok' | 'signedGrant' | 'grant' | 'version' | 'grantId' | 'policyRevision'
  | 'expiresAt' | 'expiresAt-past' | 'expiresAt-too-far'
  | 'sourceMachineId' | 'hostMachineId' | 'hostProcessKeyId' | 'hostProcessPublicKey'
  | 'maxInputChars' | 'modelMaxInputTokens'
  | 'relayDeadlineAt' | 'relayDeadlineAt-past' | 'relayDeadlineAt-too-far'
  | 'aiModelPolicy' | 'clientRequestId'

type GrantValidation =
  | { ok: true; value: GrantOk }
  | { ok: false; failed: GrantFailureCode[]; expiresInMs?: number; relayDeadlineInMs?: number }

function validateGrant(
  value: Record<string, unknown>,
  expected: { clientRequestId: string; sourceMachineId: string },
  now: number,
): GrantValidation {
  const failed: GrantFailureCode[] = []
  const add = (code: GrantFailureCode, pass: boolean) => { if (!pass) failed.push(code) }

  add('ok', value.ok === true)
  add('signedGrant', typeof value.signedGrant === 'string'
    && value.signedGrant.length > 0 && value.signedGrant.length <= 8192)
  add('aiModelPolicy', isAiModelPolicy(value.aiModelPolicy))
  add('clientRequestId', typeof expected.clientRequestId === 'string' && expected.clientRequestId.length > 0)

  const grant = value.grant
  const record = typeof grant === 'object' && grant !== null && !Array.isArray(grant)
    ? grant as Record<string, unknown>
    : null
  if (record === null) {
    failed.push('grant')
    return { ok: false, failed }
  }

  add('version', record.version === 1)
  add('grantId', typeof record.grantId === 'string' && record.grantId.length > 0 && record.grantId.length <= 200)
  add('policyRevision', typeof record.policyRevision === 'number'
    && Number.isSafeInteger(record.policyRevision) && record.policyRevision >= 0)

  const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
    ? record.expiresAt
    : null
  if (expiresAt === null) failed.push('expiresAt')
  else {
    add('expiresAt-past', expiresAt > now)
    add('expiresAt-too-far', expiresAt <= now + 60_000)
  }

  add('sourceMachineId', typeof record.sourceMachineId === 'string'
    && record.sourceMachineId === expected.sourceMachineId)
  add('hostMachineId', typeof record.hostMachineId === 'string'
    && record.hostMachineId.length > 0 && record.hostMachineId.length <= 200)
  add('hostProcessKeyId', typeof record.hostProcessKeyId === 'string'
    && record.hostProcessKeyId.length > 0 && record.hostProcessKeyId.length <= 200)
  const publicKey = typeof record.hostProcessPublicKey === 'string'
    ? decodeBase64OrNull(record.hostProcessPublicKey)
    : null
  add('hostProcessPublicKey', publicKey?.length === tweetnacl.box.publicKeyLength)
  add('maxInputChars', record.maxInputChars === 8000)
  add('modelMaxInputTokens', record.modelMaxInputTokens === 512)

  const relayDeadlineAt = typeof record.relayDeadlineAt === 'number' && Number.isFinite(record.relayDeadlineAt)
    ? record.relayDeadlineAt
    : null
  if (relayDeadlineAt === null) failed.push('relayDeadlineAt')
  else {
    add('relayDeadlineAt-past', relayDeadlineAt > now)
    add('relayDeadlineAt-too-far', relayDeadlineAt <= now + 1_000)
  }

  if (failed.length > 0) {
    return {
      ok: false,
      failed,
      ...(expiresAt !== null ? { expiresInMs: expiresAt - now } : {}),
      ...(relayDeadlineAt !== null ? { relayDeadlineInMs: relayDeadlineAt - now } : {}),
    }
  }
  return { ok: true, value: value as unknown as GrantOk }
}

function parseAiModelPolicy(value: unknown): DifficultyRoutingAiModelPolicy | undefined {
  return isAiModelPolicy(value) ? value : undefined
}

function isAiModelPolicy(value: unknown): value is DifficultyRoutingAiModelPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.source !== 'unrestricted' && record.source !== 'organization' && record.source !== 'member') return false
  if (record.source === 'unrestricted') {
    return record.allowedSelectionKeys === null && record.defaultSelectionKey === null
  }
  if (!Array.isArray(record.allowedSelectionKeys)
    || record.allowedSelectionKeys.length === 0
    || record.allowedSelectionKeys.length > 256
    || record.allowedSelectionKeys.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 256)) {
    return false
  }
  return record.defaultSelectionKey === null
    || (typeof record.defaultSelectionKey === 'string'
      && record.defaultSelectionKey.length > 0
      && record.defaultSelectionKey.length <= 256
      && record.allowedSelectionKeys.includes(record.defaultSelectionKey))
}

function resolveRouteAllowedByAiPolicy(
  agent: RoutableAgent,
  route: SendModelOptionsResult,
  current: { model?: string; effort?: string | null },
  policy: DifficultyRoutingAiModelPolicy | undefined,
): SendModelOptionsResult | null {
  if (!policy || policy.allowedSelectionKeys === null) return route
  if (route.model && isModelAllowedByAiPolicy(policy, agent, route.model)) return route
  if (current.model && isModelAllowedByAiPolicy(policy, agent, current.model)) {
    return {
      ...route,
      model: current.model,
      effort: current.effort ?? route.effort,
    }
  }
  const fallbackModel = defaultModelForAgent(policy, agent)
  if (!fallbackModel) return null
  return {
    ...route,
    model: fallbackModel,
    effort: current.effort ?? route.effort,
  }
}

function isModelAllowedByAiPolicy(
  policy: DifficultyRoutingAiModelPolicy,
  agent: RoutableAgent,
  model: string,
): boolean {
  if (policy.allowedSelectionKeys === null) return true
  return policy.allowedSelectionKeys.includes(`${agent}:${model}`)
}

function defaultModelForAgent(policy: DifficultyRoutingAiModelPolicy, agent: RoutableAgent): string | null {
  if (!policy.defaultSelectionKey) return null
  const prefix = `${agent}:`
  return policy.defaultSelectionKey.startsWith(prefix)
    ? policy.defaultSelectionKey.slice(prefix.length)
    : null
}

function hasManualModelOverride(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false
  const hasModel = Object.prototype.hasOwnProperty.call(meta, 'model')
  const hasEffort = Object.prototype.hasOwnProperty.call(meta, 'effort')
  if (!hasModel && !hasEffort) return false
  return meta.modelSource !== 'auto'
}

function decodeBase64OrNull(value: string): Uint8Array | null {
  try {
    return decodeBase64(value)
  } catch {
    return null
  }
}

function freshState(state: DifficultyRoutingState | undefined): DifficultyRoutingState | undefined {
  if (!state?.updatedAt) return state
  return Date.now() - state.updatedAt > STICKY_IDLE_RESET_MS ? undefined : state
}

function freshPreviousDifficulty(state: DifficultyRoutingState | undefined): Difficulty | undefined {
  return freshState(state)?.difficulty
}

export function resolveAplusApiOrigin(): string {
  const configured = process.env.HAPPY_APLUS_MCP_CONFIG_URL
  if (configured) {
    try {
      const parsed = new URL(configured)
      return parsed.origin
    } catch {
      // Fall through to the UI origin.
    }
  }
  return configuration.webappUrl
}

function isRelayResponse(value: unknown, requestId: string, policyRevision: number): value is RelayResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.requestId !== requestId || record.policyRevision !== policyRevision) return false
  if (!['ok', 'busy', 'not-ready', 'expired', 'revoked', 'unsupported', 'error'].includes(String(record.status))) return false
  if (record.status === 'ok') {
    if (record.difficulty !== 'trivial' && record.difficulty !== 'routine' && record.difficulty !== 'hard') return false
    if (typeof record.classifierRevision !== 'string' || record.classifierRevision.length === 0) return false
  }
  return true
}

function noteRemoteFailure(): void {
  consecutiveFailures += 1
  if (consecutiveFailures >= 3) {
    circuitBreakerUntil = Date.now() + 30_000
    consecutiveFailures = 0
  }
}

function sealText(text: string, hostProcessPublicKey: string): {
  alg: 'x25519-xsalsa20-poly1305'
  nonce: string
  ephemeralPublicKey: string
  ciphertext: string
} {
  const ephemeral = tweetnacl.box.keyPair()
  const nonce = getRandomBytes(tweetnacl.box.nonceLength)
  const ciphertext = tweetnacl.box(
    new TextEncoder().encode(text),
    nonce,
    decodeBase64(hostProcessPublicKey),
    ephemeral.secretKey,
  )
  return {
    alg: 'x25519-xsalsa20-poly1305',
    nonce: encodeBase64(nonce),
    ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
    ciphertext: encodeBase64(ciphertext),
  }
}

function createDifficultyRoutingEvent(input: {
  clientRequestId: string
  policyRevision: number | null
  route: SendModelOptionsResult
  classifierSource: 'p2-org-shared' | 'p1-local' | 'fallback-p1'
  remoteStatus?: RelayResponse['status']
  classifierRevision?: string
}): SessionEnvelope {
  return createEnvelope('session', {
    t: 'difficulty-routing',
    result: {
      version: 1,
      clientRequestId: input.clientRequestId,
      mode: 'auto',
      policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
      policyRevision: input.policyRevision,
      model: input.route.model ?? '',
      effort: input.route.effort ?? null,
      difficulty: input.route.difficulty ?? 'routine',
      classifierSource: input.classifierSource,
      ...(input.remoteStatus ? { remoteStatus: input.remoteStatus } : {}),
      ...(input.classifierRevision ? { classifierRevision: input.classifierRevision } : {}),
    },
  })
}

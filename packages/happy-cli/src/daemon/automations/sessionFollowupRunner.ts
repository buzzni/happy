import {
  SESSION_FOLLOWUP_WIRE_VERSION,
  sessionFollowupDaemonSchema,
  sessionFollowupSyncResponseSchema,
  type SessionFollowupDaemon,
  type SessionFollowupEvaluationTerminalCode,
  type SessionFollowupPayload,
} from '@slopus/happy-wire'

export type SessionFollowupTransportResult<T> =
  | { ok: true; value: T }
  | { ok: false; error?: string }

export interface SessionFollowupTransport {
  sync(input: { wireVersion: 1; afterSeq: string; limit: number }): Promise<SessionFollowupTransportResult<unknown>>
  claim(input: {
    wireVersion: 1; followupId: string; generation: number; step: number
  }): Promise<SessionFollowupTransportResult<unknown>>
  evaluate(input: {
    wireVersion: 1
    followupId: string
    generation: number
    step: number
    claimToken: string
    decision: 'WAIT' | 'CONTINUE' | 'TERMINATE'
    observedSeq: number
    terminalCode?: SessionFollowupEvaluationTerminalCode
  }): Promise<SessionFollowupTransportResult<unknown>>
  deliver(input: {
    wireVersion: 1
    followupId: string
    generation: number
    step: number
    claimToken: string
    expectedSeq: number
    localId: string
    contentCiphertext: string
  }): Promise<SessionFollowupTransportResult<unknown>>
}

export interface FollowupSessionBinding {
  sessionId: string
  directory: string
  encryptionKey: Uint8Array
  encryptionVariant: 'legacy' | 'dataKey'
  live: boolean
}

export interface EncryptedFollowupMessage {
  seq: number
  localId: string | null
  contentCiphertext: string
}

export interface SessionFollowupRunnerInput {
  transport: SessionFollowupTransport
  decryptPayload(action: SessionFollowupDaemon): SessionFollowupPayload
  resolveSession(sessionId: string): FollowupSessionBinding | null
  sameDirectory(left: string, right: string): Promise<boolean>
  fetchMessages(input: {
    sessionId: string
    afterSeq: number
  }): Promise<EncryptedFollowupMessage[]>
  decryptMessage(binding: FollowupSessionBinding, ciphertext: string): unknown
  encryptUserMessage(binding: FollowupSessionBinding, message: unknown): string
  ensureSessionRunning(input: { sessionId: string; directory: string }): Promise<{
    ok: boolean
    error?: string
    retryable?: boolean
  }>
  logDebug?(message: string): void
}

export interface SessionFollowupSyncState {
  afterSeq: bigint
  byId: Map<string, SessionFollowupDaemon>
}

export function createSessionFollowupSyncState(): SessionFollowupSyncState {
  return { afterSeq: 0n, byId: new Map() }
}

type ClaimedFollowup = {
  claimToken: string
  followup: SessionFollowupDaemon
}

function parseClaim(value: unknown): ClaimedFollowup | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.claimToken !== 'string' || !row.claimToken) return null
  const parsed = sessionFollowupDaemonSchema.safeParse(row.followup)
  if (!parsed.success) return null
  return { claimToken: row.claimToken, followup: parsed.data }
}

function parseReturnedFollowup(value: unknown): SessionFollowupDaemon | null {
  const parsed = sessionFollowupDaemonSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function contentRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export type ObservedTurn = {
  observedSeq: number
  complete: boolean
  failed: boolean
  userIntervened: boolean
  agentTexts: string[]
}

export function observeFollowupTurn(messages: Array<{ seq: number; localId: string | null; content: unknown }>): ObservedTurn {
  let observedSeq = 0
  let complete = false
  let failed = false
  let userIntervened = false
  const agentTexts: string[] = []
  for (const message of messages) {
    observedSeq = Math.max(observedSeq, message.seq)
    const root = contentRecord(message.content)
    if (!root) continue
    if (root.role === 'user') {
      userIntervened = true
      continue
    }
    if (root.role === 'session') {
      const wrapper = contentRecord(root.content)
      const envelope = contentRecord(wrapper?.data ?? wrapper)
      const event = contentRecord(envelope?.ev)
      if (envelope?.role === 'user') {
        userIntervened = true
        continue
      }
      if (envelope?.role === 'agent' && event?.t === 'text' && typeof event.text === 'string' && event.thinking !== true) {
        agentTexts.push(event.text)
      }
      if (event?.t === 'turn-end') {
        complete = true
        failed = event.status !== 'completed'
      }
      continue
    }
    if (root.role !== 'agent') continue
    const content = contentRecord(root.content)
    if (!content) continue
    const data = contentRecord(content.data)
    if (content.type === 'event' && data?.type === 'ready') complete = true
    if ((content.type === 'acp' || content.type === 'codex') && data) {
      if (data.type === 'message' && typeof data.message === 'string') agentTexts.push(data.message)
      if (data.type === 'task_complete' || data.type === 'turn_aborted') {
        complete = true
        failed = data.type === 'turn_aborted'
      }
    }
    if (content.type === 'output' && data) {
      if (data.type === 'result' && typeof data.result === 'string') agentTexts.push(data.result)
      if (data.type === 'assistant') {
        const providerMessage = contentRecord(data.message)
        const blocks = providerMessage?.content
        if (Array.isArray(blocks)) {
          const text = blocks
            .filter((block) => contentRecord(block)?.type === 'text')
            .map((block) => contentRecord(block)?.text)
            .filter((item): item is string => typeof item === 'string')
            .join('')
          if (text) agentTexts.push(text)
        }
      }
    }
  }
  return { observedSeq, complete, failed, userIntervened, agentTexts }
}

const COMPLETION_SIGNAL_BLOCK_RE = /<saycode-complete\b(?=[^>]*\bstatus="(?:completed|blocked)")(?=[^>]*\bfindings="\d+")[^>]*>[\s\S]*<\/saycode-complete>$/

function terminalCompletionSignalStart(text: string): number | null {
  const match = COMPLETION_SIGNAL_BLOCK_RE.exec(text)
  return match?.index ?? null
}

type RawJsonObject = { end: number; value: unknown }

function parseTopLevelRawJsonObjects(text: string): RawJsonObject[] {
  const objects: RawJsonObject[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (start < 0) {
      if (char === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          objects.push({ end: index + 1, value: JSON.parse(text.slice(start, index + 1)) })
        } catch {
          // Invalid brace-delimited prose is not a review contract.
        }
        start = -1
      }
    }
  }
  return objects
}

function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty')
  const fences = [...trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi)]
  const fenceStarts = trimmed.match(/```json\b/gi)?.length ?? 0
  if (fences.length > 1 || fenceStarts !== fences.length) throw new Error('multiple-json-contracts')
  if (fences.length === 1) {
    const fence = fences[0]!
    const trailing = trimmed.slice((fence.index ?? 0) + fence[0].length).trim()
    if (trailing && terminalCompletionSignalStart(trailing) !== 0) {
      throw new Error('json-contract-is-not-final')
    }
    return JSON.parse(fence[1]!)
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    const completionSignalStart = terminalCompletionSignalStart(trimmed)
    if (completionSignalStart === null) throw new Error('invalid-raw-json-contract')
    const body = trimmed.slice(0, completionSignalStart).trim()
    const objects = parseTopLevelRawJsonObjects(body)
    const contract = objects.length === 1 ? objects[0] : null
    if (!contract || contract.end !== body.length) throw new Error('invalid-raw-json-contract')
    return contract.value
  }
}

export type ReviewEvaluation =
  | { kind: 'continue' }
  | { kind: 'terminate'; terminalCode: 'CLEAN' | 'LOW_OR_NIT_ONLY' | 'UNSTRUCTURED' }

export function evaluateReviewFindings(agentTexts: string[]): ReviewEvaluation {
  const joined = agentTexts.join('')
  const last = agentTexts.at(-1) ?? ''
  // A provider may stream one response across multiple text events or emit
  // the final response as one last snapshot. A snapshot is safe to prefer only
  // when the preceding deltas are its prefix; otherwise evaluate the complete
  // response so two distinct JSON contracts fail closed.
  const preceding = agentTexts.slice(0, -1).join('')
  const candidate = preceding && last.startsWith(preceding) ? last : joined
  let parsed: unknown
  try {
    parsed = parseJsonCandidate(candidate)
  } catch {
    return { kind: 'terminate', terminalCode: 'UNSTRUCTURED' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'terminate', terminalCode: 'UNSTRUCTURED' }
  }
  const findings = (parsed as Record<string, unknown>).findings
  if (findings === undefined || findings === null) return { kind: 'terminate', terminalCode: 'CLEAN' }
  if (!Array.isArray(findings)) return { kind: 'terminate', terminalCode: 'UNSTRUCTURED' }
  if (findings.length === 0) return { kind: 'terminate', terminalCode: 'CLEAN' }
  const severities: string[] = []
  for (const finding of findings) {
    const row = contentRecord(finding)
    if (!row || typeof row.severity !== 'string'
      || !['high', 'medium', 'low', 'nit'].includes(row.severity)) {
      return { kind: 'terminate', terminalCode: 'UNSTRUCTURED' }
    }
    severities.push(row.severity)
  }
  return severities.some((severity) => severity === 'high' || severity === 'medium')
    ? { kind: 'continue' }
    : { kind: 'terminate', terminalCode: 'LOW_OR_NIT_ONLY' }
}

async function terminate(
  input: SessionFollowupRunnerInput,
  action: SessionFollowupDaemon,
  claimToken: string,
  observedSeq: number,
  terminalCode: SessionFollowupEvaluationTerminalCode,
) {
  return input.transport.evaluate({
    wireVersion: SESSION_FOLLOWUP_WIRE_VERSION,
    followupId: action.id,
    generation: action.generation,
    step: action.step,
    claimToken,
    decision: 'TERMINATE',
    observedSeq,
    terminalCode,
  })
}

async function validateBinding(
  input: SessionFollowupRunnerInput,
  action: SessionFollowupDaemon,
  payload: SessionFollowupPayload,
): Promise<
  | { ok: true; binding: FollowupSessionBinding }
  | { ok: false; terminalCode: 'SESSION_UNAVAILABLE' | 'TARGET_MISMATCH' }
> {
  const binding = input.resolveSession(action.sessionId)
  if (!binding || binding.sessionId !== action.sessionId) {
    return { ok: false, terminalCode: 'SESSION_UNAVAILABLE' }
  }
  // The tracked session directory is the only binding: projects rarely carry
  // an explicit workspaceDir, and worktree sessions never run inside it. See
  // docs/adr/2026-09-01-durable-existing-session-followups.md (2026-09-02).
  return await input.sameDirectory(binding.directory, payload.directory)
    ? { ok: true, binding }
    : { ok: false, terminalCode: 'TARGET_MISMATCH' }
}

async function deliverPending(
  input: SessionFollowupRunnerInput,
  claimed: ClaimedFollowup,
  payload: SessionFollowupPayload,
  binding: FollowupSessionBinding,
) {
  const action = claimed.followup
  if (action.status !== 'DELIVERY_PENDING' || action.pendingExpectedSeq === null || !action.pendingLocalId) return
  // Make the local consumer ready before the server commits the prompt. The
  // server delivery is the final generation/claim/Session.seq fence, so a
  // concurrent pause/stop can still prevent the message from being inserted.
  const resumed = await input.ensureSessionRunning({
    sessionId: action.sessionId,
    directory: payload.directory,
  })
  if (!resumed.ok) {
    if (!resumed.retryable) {
      await terminate(input, action, claimed.claimToken, action.lastObservedSeq, 'SESSION_UNAVAILABLE')
    }
    return
  }
  const contentCiphertext = input.encryptUserMessage(binding, {
    role: 'user',
    content: { type: 'text', text: payload.prompt },
    localKey: action.pendingLocalId,
    meta: { sentFrom: 'automation' },
  })
  const delivered = await input.transport.deliver({
    wireVersion: SESSION_FOLLOWUP_WIRE_VERSION,
    followupId: action.id,
    generation: action.generation,
    step: action.step,
    claimToken: claimed.claimToken,
    expectedSeq: action.pendingExpectedSeq,
    localId: action.pendingLocalId,
    contentCiphertext,
  })
  if (!delivered.ok) return
}

async function processAction(input: SessionFollowupRunnerInput, action: SessionFollowupDaemon): Promise<void> {
  const claim = await input.transport.claim({
    wireVersion: SESSION_FOLLOWUP_WIRE_VERSION,
    followupId: action.id,
    generation: action.generation,
    step: action.step,
  })
  if (!claim.ok) return
  const claimed = parseClaim(claim.value)
  if (!claimed) return
  let payload: SessionFollowupPayload
  try {
    payload = input.decryptPayload(claimed.followup)
  } catch {
    await terminate(input, claimed.followup, claimed.claimToken, claimed.followup.lastObservedSeq, 'DECRYPT_FAILED')
    return
  }
  const bindingResult = await validateBinding(input, claimed.followup, payload)
  if (!bindingResult.ok) {
    await terminate(
      input,
      claimed.followup,
      claimed.claimToken,
      claimed.followup.lastObservedSeq,
      bindingResult.terminalCode,
    )
    return
  }
  const binding = bindingResult.binding
  if (claimed.followup.status === 'DELIVERY_PENDING') {
    await deliverPending(input, claimed, payload, binding)
    return
  }

  let encryptedMessages: EncryptedFollowupMessage[]
  try {
    encryptedMessages = await input.fetchMessages({
      sessionId: claimed.followup.sessionId,
      afterSeq: claimed.followup.responseBoundarySeq,
    })
  } catch {
    await input.transport.evaluate({
      wireVersion: SESSION_FOLLOWUP_WIRE_VERSION,
      followupId: claimed.followup.id,
      generation: claimed.followup.generation,
      step: claimed.followup.step,
      claimToken: claimed.claimToken,
      decision: 'WAIT',
      observedSeq: claimed.followup.lastObservedSeq,
    })
    return
  }
  const decrypted: Array<{ seq: number; localId: string | null; content: unknown }> = []
  try {
    for (const message of encryptedMessages) {
      decrypted.push({
        seq: message.seq,
        localId: message.localId,
        content: input.decryptMessage(binding, message.contentCiphertext),
      })
    }
  } catch {
    await terminate(input, claimed.followup, claimed.claimToken, claimed.followup.lastObservedSeq, 'DECRYPT_FAILED')
    return
  }
  const observed = observeFollowupTurn(decrypted)
  const observedSeq = Math.max(claimed.followup.responseBoundarySeq, observed.observedSeq)
  if (observed.userIntervened) {
    await terminate(input, claimed.followup, claimed.claimToken, observedSeq, 'USER_INTERVENTION')
    return
  }
  if (!observed.complete) {
    if (!binding.live) {
      const resumed = await input.ensureSessionRunning({
        sessionId: claimed.followup.sessionId,
        directory: payload.directory,
      })
      if (!resumed.ok) {
        if (!resumed.retryable) {
          await terminate(input, claimed.followup, claimed.claimToken, observedSeq, 'SESSION_UNAVAILABLE')
          return
        }
      }
    }
    await input.transport.evaluate({
      wireVersion: SESSION_FOLLOWUP_WIRE_VERSION,
      followupId: claimed.followup.id,
      generation: claimed.followup.generation,
      step: claimed.followup.step,
      claimToken: claimed.claimToken,
      decision: 'WAIT',
      observedSeq,
    })
    return
  }
  if (observed.failed) {
    await terminate(input, claimed.followup, claimed.claimToken, observedSeq, 'UNSTRUCTURED')
    return
  }
  const evaluation = evaluateReviewFindings(observed.agentTexts)
  if (evaluation.kind === 'terminate') {
    await terminate(input, claimed.followup, claimed.claimToken, observedSeq, evaluation.terminalCode)
    return
  }
  if (claimed.followup.currentRound >= claimed.followup.totalRounds) {
    await terminate(input, claimed.followup, claimed.claimToken, observedSeq, 'ROUNDS_EXHAUSTED')
    return
  }
  const reserved = await input.transport.evaluate({
    wireVersion: SESSION_FOLLOWUP_WIRE_VERSION,
    followupId: claimed.followup.id,
    generation: claimed.followup.generation,
    step: claimed.followup.step,
    claimToken: claimed.claimToken,
    decision: 'CONTINUE',
    observedSeq,
  })
  if (!reserved.ok) return
  const pending = parseReturnedFollowup(reserved.value)
  if (!pending || pending.status !== 'DELIVERY_PENDING') return
  const deliveryClaim = await input.transport.claim({
    wireVersion: SESSION_FOLLOWUP_WIRE_VERSION,
    followupId: pending.id,
    generation: pending.generation,
    step: pending.step,
  })
  if (!deliveryClaim.ok) return
  const claimedDelivery = parseClaim(deliveryClaim.value)
  if (!claimedDelivery) return
  await deliverPending(input, claimedDelivery, payload, binding)
}

export async function runSessionFollowupTick(
  input: SessionFollowupRunnerInput,
  state: SessionFollowupSyncState = createSessionFollowupSyncState(),
): Promise<void> {
  while (true) {
    const response = await input.transport.sync({
      wireVersion: SESSION_FOLLOWUP_WIRE_VERSION,
      afterSeq: state.afterSeq.toString(),
      limit: 500,
    })
    if (!response.ok) return
    const parsed = sessionFollowupSyncResponseSchema.safeParse(response.value)
    if (!parsed.success) return
    const row = parsed.data
    const nextSeq = BigInt(row.nextSeq)
    if (nextSeq < state.afterSeq || (row.hasMore && nextSeq === state.afterSeq)) return
    let changeSeq = state.afterSeq
    for (const change of row.changes) {
      const seq = BigInt(change.seq)
      if (seq <= changeSeq || seq > nextSeq) return
      changeSeq = seq
    }
    if (nextSeq > state.afterSeq && changeSeq !== nextSeq) return
    for (const change of row.changes) {
      if (change.kind === 'TOMBSTONE') state.byId.delete(change.followupId)
      else state.byId.set(change.followupId, change)
    }
    state.afterSeq = nextSeq
    if (!row.hasMore) break
  }
  for (const action of [...state.byId.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    try {
      await processAction(input, action)
    } catch (error) {
      input.logDebug?.(`[session-followup] ${action.id} tick failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

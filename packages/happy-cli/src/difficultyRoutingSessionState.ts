/**
 * Session-scoped auto-routing state, split into the three things that used to
 * share one record (`{ difficulty, hardTurns, updatedAt }`):
 *
 * - **base route** — the floor the conversation has actually executed on. It has
 *   no idle TTL. An hour of silence is not evidence that the conversation became
 *   easy, and the old shared TTL silently dropped a hard conversation back to the
 *   trivial tier on the next message.
 * - **escalation counters** — repeated-failure bookkeeping (`hardTurns`). These
 *   *do* expire on idle and on an explicit resolution signal: they describe a
 *   streak, and a streak does go stale.
 * - **pending decisions** — what was selected for a client request that has been
 *   accepted into the queue but not yet handed to the execution engine. A pending
 *   decision never moves the floor or a counter.
 *
 * The floor is committed only at the engine-applied boundary (`commitAppliedRouting`),
 * so a turn that is cancelled, or that fails before the runner hands its settings
 * to the engine, cannot raise the floor or move a streak. A turn that fails *after*
 * that boundary keeps its commit.
 *
 * "Applied" means this runner handed the setting to the execution engine. It is
 * **not** evidence that a provider received the request, ran that model, or
 * answered — nothing in this module observes the provider. Provider confirmation
 * is a separate, optional signal and must never be inferred from a commit here.
 *
 * Nothing here talks to the network or the clock on its own; callers pass `now`
 * so a restart-and-replay is reproducible.
 */

import {
  HARD_TURNS_BEFORE_ESCALATION,
  USER_REQUEST_MODELS,
  isKnownRoutePair,
  type Difficulty,
  type RoutableAgent,
} from './difficultyRoutingPolicy'

export const ROUTING_STATE_VERSION = 2

/** Counters describe a streak, so they go stale. The floor does not. */
export const ESCALATION_IDLE_RESET_MS = 60 * 60 * 1000

/*
 * Receipts are kept for the whole epoch, with no cap and no truncation.
 *
 * Every bounded scheme tried here was wrong in a way that matters: a window
 * silently forgets, so a replay one execution past it runs again; and a
 * timestamp cutoff cannot help either, because a replay arrives with a fresh
 * `createdAt` while a legitimately long-waiting request gets refused for being
 * old. The only honest bound is the conversation itself — `startRoutingEpoch`
 * clears the receipts at an explicit context reset.
 *
 * Memory is therefore proportional to executions per epoch. That is accepted
 * here rather than traded for correctness.
 */

/**
 * How the base route came to be believed.
 *
 * `engine-applied` means this runner handed this model/effort to the execution
 * engine and observed it do so — the strongest evidence this module has, and
 * still not proof that a provider ran it.
 *
 * Where the *classifier* ran is irrelevant to this judgement. A turn whose tier
 * the client chose is still an execution this process applied and watched, so it
 * is `engine-applied` too. Marking it weaker made consumers discard a floor the
 * CLI had genuinely established.
 *
 * `legacy-selection` is reserved for a record of a selection with no observed
 * apply behind it: a pre-v2 record migrated from history. `unknown` means the
 * record could not be read and the floor must be neither trusted nor replaced
 * by a re-classification.
 */
export type RoutingProvenance = 'engine-applied' | 'legacy-selection' | 'unknown'

export type RoutingRouteSnapshot = {
  difficulty: Difficulty
  model: string
  effort: string | null
}

export type RoutingBaseRoute = RoutingRouteSnapshot & {
  provenance: RoutingProvenance
  policyVersion: string
  policyRevision: number | null
  appliedAt: number
  executionId?: string
  clientRequestIds?: string[]
}

export type RoutingEscalationState = {
  hardTurns: number
  updatedAt: number
}

/**
 * Reasons are additive and non-content: they name why a route changed, never
 * what the user wrote.
 */
export type RoutingDecisionReason =
  | 'classified-up'
  | 'sticky-floor-maintained'
  | 'continuation-reuse'
  | 'temporary-escalation'
  | 'temporary-escalation-return'
  | 'manual-return-to-auto'
  | 'policy-fallback'
  | 'legacy-bootstrap'
  | 'context-reset'
  | 'classifier-fallback'
  /** The queued decision was computed against a floor that has since risen. */
  | 'stale-queued-decision'

/**
 * What produced this turn's settings.
 *
 * - `auto` — this CLI classified and routed it. Full evidence.
 * - `local-auto-bootstrap` — the client's own auto-router chose the model and
 *   this CLI applied it. The apply is observed here, so the evidence is the same
 *   `engine-applied` as any other executed turn; only the classifier differed,
 *   and `kind` is what records that.
 * - `manual` — the user pinned the model. Never feeds the floor or the counters
 *   (R5); recorded only so the return to Auto is observable.
 */
export type RoutingDecisionKind = 'auto' | 'local-auto-bootstrap' | 'manual'

/**
 * What this turn should do to the repeated-failure streak, expressed as an
 * intent rather than an absolute.
 *
 * Absolutes are wrong under concurrency: two hard turns classified before
 * either applied both carry `hardTurns: 1`, so writing the absolute twice pins
 * the streak at 1 no matter how many hard turns actually ran. The intent is
 * resolved against the counter that exists at commit time, so each execution
 * advances once and a merged batch advances once.
 */
export type RoutingHardTurnsIntent = 'increment' | 'decrement' | 'reset' | 'none'

/** The org policy in force for this request's grant, kept so the engine
 *  boundary can re-validate a raise without minting a fresh grant. */
export type RoutingPolicySnapshot = {
  allowedSelectionKeys: string[] | null
  defaultSelectionKey: string | null
}

export type RoutingPendingDecision = {
  clientRequestId: string
  kind?: RoutingDecisionKind
  /** Evidence strength for the floor this turn commits. Defaults to applied. */
  baseProvenance?: RoutingProvenance
  policySnapshot?: RoutingPolicySnapshot
  /** What the classifier said about this input, before the floor was applied. */
  candidateDifficulty: Difficulty
  /** What this turn will actually run on, including any temporary escalation. */
  selectedDifficulty: Difficulty
  selected: { model: string; effort: string | null }
  /** The floor this turn would commit — never the temporarily escalated tier. */
  base: RoutingRouteSnapshot
  temporaryEscalation: boolean
  /** Decision-time absolute. Kept for diagnostics; the intent is authoritative. */
  hardTurns: number
  hardTurnsIntent?: RoutingHardTurnsIntent
  decisionReasons: RoutingDecisionReason[]
  classifierSource: string
  policyRevision: number | null
  policyVersion: string
  createdAt: number
}

export type DifficultyRoutingSessionState = {
  stateVersion: number
  /** Monotonic within a session. Older revisions never overwrite newer ones. */
  revision: number
  base?: RoutingBaseRoute
  escalation?: RoutingEscalationState
  pending?: Record<string, RoutingPendingDecision>
  lastApplied?: { executionId: string; clientRequestIds: string[]; at: number }
  /**
   * Bounded FIFO of requests already applied in this epoch. `lastApplied` only
   * remembers the newest execution, so a replay separated by another execution
   * used to slip past it and move the counters twice for one user request.
   * Bounded because this lives in session metadata.
   */
  appliedRequestIds?: string[]
  /**
   * The last manually pinned selection actually applied. Kept out of the floor
   * (R5) and used only so the next Auto turn can name the return and show what
   * the conversation was actually on.
   */
  lastManual?: { model: string; effort: string | null; at: number }
  /**
   * The route the previous execution ACTUALLY ran on, whatever produced it.
   *
   * Not derivable from `base`: during a temporary escalation the base is
   * deliberately not what ran, and a manual turn has no base at all. R8 asks for
   * the previous actual selection across every transition — auto, escalation,
   * return, manual — so it is recorded once, here, at the only place that knows
   * what was applied.
   *
   * Absent means unknown, never "same as the floor": a state written before this
   * field existed has no answer, and reconstructing one would be a guess.
   */
  lastAppliedRoute?: {
    model: string
    effort: string | null
    difficulty: Difficulty
    kind: RoutingDecisionKind
    at: number
  }
  epochStartedAt?: number
  /**
   * When a context reset was *accepted*, which is earlier than when the provider
   * actually resets. Decisions accepted after this point were queued behind the
   * reset and still run, so the reset must not take their receipts with it.
   */
  epochRequestedAt?: number
  /**
   * The stored record could not be read (malformed, or written by a newer
   * version). Distinct from "no floor yet": a fresh session may safely classify
   * from scratch, whereas an unreadable record means a floor probably exists and
   * this process cannot see it — so it must not classify downward.
   */
  floorUnknown?: true
  /** Set when the record came from a newer writer. Blocks persisting over it. */
  foreignStateVersion?: number
  /**
   * The execution that ran on a temporary escalation. Its presence is what lets
   * the next turn name its return to the base path (`temporary-escalation-return`)
   * instead of presenting it as uninterrupted continuity.
   */
  lastEscalatedExecutionId?: string
}

/** The pre-v2 record. Still read, never written. */
export type LegacyDifficultyRoutingState = {
  difficulty?: Difficulty
  hardTurns?: number
  updatedAt?: number
}

const DIFFICULTY_ORDER: readonly Difficulty[] = ['trivial', 'routine', 'hard', 'escalated']

function tierRank(difficulty: Difficulty): number {
  return DIFFICULTY_ORDER.indexOf(difficulty)
}

function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTY_ORDER as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Accepts the v2 record, the pre-v2 record, and anything unrecognisable.
 *
 * An unrecognisable or newer-than-known record yields a state with no base and
 * no counters but the revision preserved, so a client running behind the writer
 * degrades to "unknown floor" instead of silently restarting the conversation
 * at the cheapest tier and instead of writing a lower revision over a higher one.
 */
export function normalizeRoutingSessionState(
  raw: unknown,
  agent: RoutableAgent,
): DifficultyRoutingSessionState {
  if (!isRecord(raw)) return { stateVersion: ROUTING_STATE_VERSION, revision: 0 }

  const revision = typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0
    ? raw.revision
    : 0

  if (raw.stateVersion === ROUTING_STATE_VERSION) {
    // Never a bare cast: a malformed record that type-asserts its way in would
    // feed a garbage tier straight into routing and into the floor comparison.
    return readV2State(raw, revision)
  }
  if (typeof raw.stateVersion === 'number') {
    // A record written by a newer CLI. Keep the revision so this process cannot
    // roll the shared record backwards, claim nothing about the floor, and
    // refuse to persist over it.
    return {
      stateVersion: ROUTING_STATE_VERSION,
      revision,
      floorUnknown: true,
      foreignStateVersion: raw.stateVersion,
    }
  }

  return migrateLegacyRoutingState(raw as LegacyDifficultyRoutingState, agent)
}

/**
 * The pre-v2 record stored a tier and a counter, never a model. The tier is
 * mapped through today's catalog because that is the only mapping available —
 * so it is recorded as `legacy-selection`, not as evidence of what ran.
 *
 * `escalated` is a one-turn override, never a floor: a legacy record that was
 * captured mid-escalation restores the `hard` floor underneath it.
 */
function migrateLegacyRoutingState(
  legacy: LegacyDifficultyRoutingState,
  agent: RoutableAgent,
): DifficultyRoutingSessionState {
  const state: DifficultyRoutingSessionState = {
    stateVersion: ROUTING_STATE_VERSION,
    revision: 0,
  }
  if (isDifficulty(legacy.difficulty)) {
    const difficulty = legacy.difficulty === 'escalated' ? 'hard' : legacy.difficulty
    const route = USER_REQUEST_MODELS[agent][difficulty]
    state.base = {
      difficulty,
      model: route.model,
      effort: route.effort,
      provenance: 'legacy-selection',
      policyVersion: 'legacy',
      policyRevision: null,
      appliedAt: typeof legacy.updatedAt === 'number' ? legacy.updatedAt : 0,
    }
  }
  if (typeof legacy.hardTurns === 'number' && typeof legacy.updatedAt === 'number') {
    state.escalation = { hardTurns: legacy.hardTurns, updatedAt: legacy.updatedAt }
  }
  return state
}

/**
 * Reads a v2 record field by field. A base that does not validate leaves the
 * state with an unknown floor rather than no floor; invalid pending entries are
 * simply dropped, since a pending decision carries no durable authority.
 */
function readV2State(raw: Record<string, unknown>, revision: number): DifficultyRoutingSessionState {
  const state: DifficultyRoutingSessionState = { stateVersion: ROUTING_STATE_VERSION, revision }

  if (raw.floorUnknown === true) state.floorUnknown = true
  if (typeof raw.foreignStateVersion === 'number' && raw.foreignStateVersion > ROUTING_STATE_VERSION) {
    state.foreignStateVersion = raw.foreignStateVersion
    state.floorUnknown = true
  }
  if (raw.base !== undefined) {
    const base = readBaseRoute(raw.base)
    if (base) state.base = base
    else state.floorUnknown = true
  }
  const escalation = readEscalation(raw.escalation)
  if (escalation) state.escalation = escalation
  const pending = readPending(raw.pending)
  if (pending) state.pending = pending
  const lastApplied = readLastApplied(raw.lastApplied)
  if (lastApplied) state.lastApplied = lastApplied
  if (Array.isArray(raw.appliedRequestIds) && raw.appliedRequestIds.every((id) => typeof id === 'string')) {
    state.appliedRequestIds = raw.appliedRequestIds as string[]
  }
  const lastManual = readLastManual(raw.lastManual)
  if (lastManual) state.lastManual = lastManual
  const lastAppliedRoute = readLastAppliedRoute(raw.lastAppliedRoute)
  if (lastAppliedRoute) state.lastAppliedRoute = lastAppliedRoute
  if (typeof raw.epochStartedAt === 'number') state.epochStartedAt = raw.epochStartedAt
  if (typeof raw.epochRequestedAt === 'number') state.epochRequestedAt = raw.epochRequestedAt
  if (typeof raw.lastEscalatedExecutionId === 'string') state.lastEscalatedExecutionId = raw.lastEscalatedExecutionId
  return state
}

function readBaseRoute(value: unknown): RoutingBaseRoute | null {
  if (!isRecord(value)) return null
  if (!isDifficulty(value.difficulty)) return null
  if (typeof value.model !== 'string' || value.model.length === 0) return null
  if (value.effort !== null && typeof value.effort !== 'string') return null
  const provenance = value.provenance
  if (provenance !== 'engine-applied' && provenance !== 'legacy-selection' && provenance !== 'unknown') return null
  if (typeof value.policyVersion !== 'string') return null
  if (value.policyRevision !== null && typeof value.policyRevision !== 'number') return null
  if (typeof value.appliedAt !== 'number') return null
  return {
    difficulty: value.difficulty,
    model: value.model,
    effort: value.effort as string | null,
    provenance,
    policyVersion: value.policyVersion,
    policyRevision: value.policyRevision as number | null,
    appliedAt: value.appliedAt,
    ...(typeof value.executionId === 'string' ? { executionId: value.executionId } : {}),
    ...(Array.isArray(value.clientRequestIds)
      && value.clientRequestIds.every((id) => typeof id === 'string')
      ? { clientRequestIds: value.clientRequestIds as string[] }
      : {}),
  }
}

function readLastManual(value: unknown): DifficultyRoutingSessionState['lastManual'] | null {
  if (!isRecord(value)) return null
  if (typeof value.model !== 'string' || value.model.length === 0) return null
  if (value.effort !== null && typeof value.effort !== 'string') return null
  if (typeof value.at !== 'number') return null
  return { model: value.model, effort: value.effort as string | null, at: value.at }
}

function readLastAppliedRoute(value: unknown): DifficultyRoutingSessionState['lastAppliedRoute'] | null {
  if (!isRecord(value)) return null
  if (typeof value.model !== 'string' || value.model.length === 0) return null
  if (value.effort !== null && typeof value.effort !== 'string') return null
  if (!isDifficulty(value.difficulty)) return null
  const kind = value.kind
  if (kind !== 'auto' && kind !== 'local-auto-bootstrap' && kind !== 'manual') return null
  if (typeof value.at !== 'number') return null
  return {
    model: value.model,
    effort: value.effort as string | null,
    difficulty: value.difficulty,
    kind,
    at: value.at,
  }
}

function readPolicySnapshot(value: unknown): RoutingPolicySnapshot | null {
  if (!isRecord(value)) return null
  const keys = value.allowedSelectionKeys
  if (keys !== null && !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))) return null
  if (value.defaultSelectionKey !== null && typeof value.defaultSelectionKey !== 'string') return null
  return {
    allowedSelectionKeys: keys === null ? null : keys as string[],
    defaultSelectionKey: value.defaultSelectionKey as string | null,
  }
}

function readEscalation(value: unknown): RoutingEscalationState | null {
  if (!isRecord(value)) return null
  if (typeof value.hardTurns !== 'number' || !Number.isFinite(value.hardTurns)) return null
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null
  return { hardTurns: value.hardTurns, updatedAt: value.updatedAt }
}

function readPending(value: unknown): Record<string, RoutingPendingDecision> | null {
  if (!isRecord(value)) return null
  const out: Record<string, RoutingPendingDecision> = Object.create(null)
  for (const [key, entry] of Object.entries(value)) {
    const parsed = readPendingDecision(entry, key)
    if (parsed) out[key] = parsed
  }
  return Object.keys(out).length > 0 ? out : null
}

function readPendingDecision(value: unknown, key: string): RoutingPendingDecision | null {
  if (!isRecord(value)) return null
  if (value.clientRequestId !== key) return null
  if (!isDifficulty(value.candidateDifficulty) || !isDifficulty(value.selectedDifficulty)) return null
  if (!isRecord(value.selected) || typeof value.selected.model !== 'string') return null
  if (value.selected.effort !== null && typeof value.selected.effort !== 'string') return null
  const base = readRouteSnapshot(value.base)
  if (!base) return null
  if (typeof value.temporaryEscalation !== 'boolean') return null
  if (typeof value.hardTurns !== 'number') return null
  const intent = value.hardTurnsIntent
  if (!Array.isArray(value.decisionReasons) || value.decisionReasons.some((r) => typeof r !== 'string')) return null
  if (typeof value.classifierSource !== 'string') return null
  if (value.policyRevision !== null && typeof value.policyRevision !== 'number') return null
  if (typeof value.policyVersion !== 'string') return null
  if (typeof value.createdAt !== 'number') return null
  const kind = value.kind
  const baseProvenance = value.baseProvenance
  return {
    clientRequestId: key,
    ...(kind === 'auto' || kind === 'local-auto-bootstrap' || kind === 'manual' ? { kind } : {}),
    ...(baseProvenance === 'engine-applied' || baseProvenance === 'legacy-selection' || baseProvenance === 'unknown'
      ? { baseProvenance }
      : {}),
    ...(readPolicySnapshot(value.policySnapshot)
      ? { policySnapshot: readPolicySnapshot(value.policySnapshot)! }
      : {}),
    candidateDifficulty: value.candidateDifficulty,
    selectedDifficulty: value.selectedDifficulty,
    selected: { model: value.selected.model, effort: value.selected.effort as string | null },
    base,
    temporaryEscalation: value.temporaryEscalation,
    hardTurns: value.hardTurns,
    ...(intent === 'increment' || intent === 'decrement' || intent === 'reset' || intent === 'none'
      ? { hardTurnsIntent: intent }
      : {}),
    decisionReasons: value.decisionReasons as RoutingDecisionReason[],
    classifierSource: value.classifierSource,
    policyRevision: value.policyRevision as number | null,
    policyVersion: value.policyVersion,
    createdAt: value.createdAt,
  }
}

function readRouteSnapshot(value: unknown): RoutingRouteSnapshot | null {
  if (!isRecord(value)) return null
  if (!isDifficulty(value.difficulty)) return null
  if (typeof value.model !== 'string' || value.model.length === 0) return null
  if (value.effort !== null && typeof value.effort !== 'string') return null
  return { difficulty: value.difficulty, model: value.model, effort: value.effort as string | null }
}

function readLastApplied(value: unknown): DifficultyRoutingSessionState['lastApplied'] | null {
  if (!isRecord(value)) return null
  if (typeof value.executionId !== 'string' || value.executionId.length === 0) return null
  if (!Array.isArray(value.clientRequestIds) || value.clientRequestIds.some((id) => typeof id !== 'string')) return null
  if (typeof value.at !== 'number') return null
  return { executionId: value.executionId, clientRequestIds: value.clientRequestIds as string[], at: value.at }
}

/**
 * True when a floor may exist but this process cannot read it. Callers must
 * neither claim continuity nor re-classify downward: keep whatever the engine is
 * currently configured with, and say the protection status is unknown.
 */
export function isFloorUnknown(state: DifficultyRoutingSessionState): boolean {
  return state.floorUnknown === true
}

/**
 * False when the record came from a newer writer. Writing a v2 record over it
 * would destroy fields this build does not know about.
 */
export function canPersistRoutingState(state: DifficultyRoutingSessionState): boolean {
  return state.foreignStateVersion === undefined
}

/** The floor the conversation runs on. No idle expiry — that is the point. */
export function baseFloorDifficulty(state: DifficultyRoutingSessionState): Difficulty | undefined {
  return state.base?.difficulty
}

/**
 * Counters as of `now`. Past the idle window they read as a fresh streak, and
 * `ageMs` goes undefined so downstream escalation logic cannot re-derive the
 * expired age and act on it.
 */
export function effectiveEscalation(
  state: DifficultyRoutingSessionState,
  now: number,
): { hardTurns: number; ageMs: number | undefined } {
  const escalation = state.escalation
  if (!escalation) return { hardTurns: 0, ageMs: undefined }
  const ageMs = now - escalation.updatedAt
  if (ageMs > ESCALATION_IDLE_RESET_MS) return { hardTurns: 0, ageMs: undefined }
  return { hardTurns: escalation.hardTurns, ageMs }
}

export function pendingDecision(
  state: DifficultyRoutingSessionState,
  clientRequestId: string,
): RoutingPendingDecision | undefined {
  const pending = state.pending
  return pending && Object.prototype.hasOwnProperty.call(pending, clientRequestId)
    ? pending[clientRequestId]
    : undefined
}

/**
 * Records what was selected for an accepted request. Keyed by `clientRequestId`,
 * so a re-send of the same request replaces its pending decision rather than
 * queueing a second one that would be counted again at commit.
 */
export function recordPendingDecision(
  state: DifficultyRoutingSessionState,
  decision: RoutingPendingDecision,
): DifficultyRoutingSessionState {
  return {
    ...state,
    revision: state.revision + 1,
    pending: { ...(state.pending ?? {}), [decision.clientRequestId]: decision },
  }
}

/**
 * Drops pending decisions for requests that will never reach the engine
 * (cancelled, failed before apply, superseded). The floor and the counters are
 * untouched by construction: they were never written at accept time.
 *
 * Returns the same object when nothing matched, so a caller can skip a metadata
 * write without comparing contents.
 */
export function discardPendingDecisions(
  state: DifficultyRoutingSessionState,
  clientRequestIds: readonly string[],
  _reason: 'cancelled' | 'failed' | 'superseded',
): DifficultyRoutingSessionState {
  const pending = state.pending
  if (!pending) return state
  const remaining = { ...pending }
  let removed = false
  for (const id of clientRequestIds) {
    if (Object.prototype.hasOwnProperty.call(remaining, id)) {
      delete remaining[id]
      removed = true
    }
  }
  if (!removed) return state
  const next: DifficultyRoutingSessionState = { ...state, revision: state.revision + 1 }
  if (Object.keys(remaining).length > 0) next.pending = remaining
  else delete next.pending
  return next
}

export type CommitAppliedInput = {
  /** Every client request merged into this one execution. */
  clientRequestIds: readonly string[]
  /** Identifies the execution attempt, so a replayed commit is a no-op. */
  executionId: string
  now: number
  /**
   * The route the engine boundary actually applied, when it differed from the
   * queued decision (a stale decision raised to the latest floor). Recorded as
   * what ran, so the state never disagrees with the engine.
   */
  /**
   * The latest floor outranks this turn, but this turn's own policy forbids the
   * floor's model, so it ran lower on purpose. The commit must then record what
   * ran instead of re-confirming a floor the turn never reached.
   */
  policyBlocked?: boolean
  revised?: {
    model: string
    effort: string | null
    difficulty: Difficulty
    reasons: RoutingDecisionReason[]
    hardTurnsIntent?: RoutingHardTurnsIntent
    /** A one-turn override. Must not become the floor (R4). */
    temporaryEscalation?: true
  }
}

/**
 * The engine-applied boundary. Called once per execution, when the runner has
 * handed this batch's settings to the provider process.
 *
 * Of the merged inputs, the highest-tier pending decision wins — the batch runs
 * as one turn, so it runs at the difficulty of its hardest input. The counters
 * move once for that execution, never once per merged input, and the floor takes
 * the *base* tier of the winner, never its temporary escalation.
 */
export function commitAppliedRouting(
  state: DifficultyRoutingSessionState,
  input: CommitAppliedInput,
): { state: DifficultyRoutingSessionState; applied: RoutingPendingDecision | null } {
  if (state.lastApplied?.executionId === input.executionId) {
    return { state, applied: null }
  }
  const pending = state.pending
  if (!pending) return { state, applied: null }

  // A request already applied in this epoch is never applied again, however
  // many executions ago that was and whatever execution now claims it. This is
  // the guard `lastApplied` alone could not provide.
  const alreadyApplied = new Set(state.appliedRequestIds ?? [])
  const matched = [...new Set(input.clientRequestIds)]
    .filter((id) => !alreadyApplied.has(id))
    .map((id) => pendingDecision(state, id))
    .filter((entry): entry is RoutingPendingDecision => Boolean(entry))
  if (matched.length === 0) return { state, applied: null }

  const winner = selectBatchWinner(matched)!

  const remaining = { ...pending }
  for (const id of input.clientRequestIds) delete remaining[id]

  const nextReceipts = [...(state.appliedRequestIds ?? []), ...matched.map((entry) => entry.clientRequestId)]

  const next: DifficultyRoutingSessionState = {
    ...state,
    revision: state.revision + 1,
    lastApplied: {
      executionId: input.executionId,
      clientRequestIds: [...input.clientRequestIds],
      at: input.now,
    },
    appliedRequestIds: nextReceipts,
  }

  const policyBlockedReasons: RoutingDecisionReason[] = input.policyBlocked ? ['policy-fallback'] : []
  const recorded: RoutingPendingDecision = input.revised
    ? {
      ...winner,
      selectedDifficulty: input.revised.difficulty,
      selected: { model: input.revised.model, effort: input.revised.effort },
      // An escalation raise is a one-turn override: it changes what runs, never
      // the floor underneath it (R4). A plain floor raise does move the base,
      // because there the raise IS the floor being honoured.
      base: input.revised.temporaryEscalation
        ? winner.base
        : { difficulty: input.revised.difficulty, model: input.revised.model, effort: input.revised.effort },
      temporaryEscalation: input.revised.temporaryEscalation ?? winner.temporaryEscalation,
      decisionReasons: [...winner.decisionReasons, ...input.revised.reasons],
    }
    : policyBlockedReasons.length > 0
      ? { ...winner, decisionReasons: [...winner.decisionReasons, ...policyBlockedReasons] }
      : winner

  // Recorded for every kind, from the route that actually reached the engine.
  next.lastAppliedRoute = {
    model: recorded.selected.model,
    effort: recorded.selected.effort,
    difficulty: recorded.selectedDifficulty,
    kind: recorded.kind ?? 'auto',
    at: input.now,
  }

  if ((winner.kind ?? 'auto') === 'manual') {
    /*
     * R5: a manual pin is honoured and recorded, but it is not evidence about
     * the conversation's difficulty. It must move neither the floor nor the
     * streak — only the marker that lets the next Auto turn name the return.
     */
    next.lastManual = { model: winner.selected.model, effort: winner.selected.effort, at: input.now }
  } else {
    const effective = recorded
    const base = resolveCommittedBase(state.base, effective, input)
    next.base = base
    /*
     * The counters follow the floor. When an established floor outranks this
     * decision, the decision was computed against a stale floor and its
     * `hardTurns` (typically 0) describes a conversation that no longer exists —
     * letting it through wiped a real escalation streak.
     */
    /*
     * The streak follows what actually ran. Resolved against the counter as it
     * stands now, never against the absolute the decision computed before other
     * executions moved it. A raise at the boundary carries its own intent,
     * because the turn really did become a hard turn.
     */
    const prior = effectiveEscalation(state, input.now).hardTurns
    const intent = input.revised?.hardTurnsIntent
      // A policy-blocked turn ran below the hard tier on purpose, so the hard
      // streak genuinely did not continue through it.
      ?? (input.policyBlocked && effective.base.difficulty !== 'hard' && effective.base.difficulty !== 'escalated'
        ? 'reset' as const
        : undefined)
      ?? effective.hardTurnsIntent
      ?? legacyIntentFor(effective, prior)
    next.escalation = { hardTurns: applyHardTurnsIntent(prior, intent), updatedAt: input.now }

    if (recorded.temporaryEscalation) next.lastEscalatedExecutionId = input.executionId
    else delete next.lastEscalatedExecutionId

    // The return to Auto has now happened, so the marker has done its job.
    // Leaving it would make every later Auto turn report the same return.
    delete next.lastManual
  }

  if (Object.keys(remaining).length > 0) next.pending = remaining
  else delete next.pending
  return { state: next, applied: recorded }
}

/**
 * True when the floor outranks this turn but this turn's own policy snapshot
 * forbids the floor's model.
 *
 * Distinct from `resolveEngineBoundaryRoute` returning null, which also covers
 * "already at the floor". Collapsing the two made the commit re-confirm a floor
 * that the org had just prevented this turn from reaching.
 */
export function isFloorRaiseBlockedByPolicy(
  state: DifficultyRoutingSessionState,
  decision: RoutingPendingDecision,
  agent: RoutableAgent,
): boolean {
  if ((decision.kind ?? 'auto') === 'manual') return false
  const base = state.base
  if (!base) return false
  if (tierRank(decision.selectedDifficulty) >= tierRank(base.difficulty)) return false
  if (!isKnownRoutePair(agent, base)) return false
  return !isAllowedByPolicySnapshot(decision.policySnapshot, agent, base.model)
}

function applyHardTurnsIntent(prior: number, intent: RoutingHardTurnsIntent): number {
  if (intent === 'reset') return 0
  if (intent === 'increment') return prior + 1
  if (intent === 'decrement') return Math.max(0, prior - 1)
  return prior
}

/**
 * A decision written before intents existed carries only an absolute. Read it
 * as the intent it most likely expressed, so a record in flight across an
 * upgrade still moves the streak in the right direction.
 */
function legacyIntentFor(decision: RoutingPendingDecision, prior: number): RoutingHardTurnsIntent {
  if (decision.hardTurns === 0) return 'reset'
  if (decision.hardTurns > prior) return 'increment'
  if (decision.hardTurns < prior) return 'decrement'
  return 'none'
}

/**
 * The single rule for which of a merged batch's decisions the execution runs as:
 * the highest tier, because the batch runs as one turn and a turn runs at the
 * difficulty of its hardest input.
 *
 * Exported so the engine boundary picks the same winner it will later commit.
 * When those two disagreed, the mode handed to the engine could be recomputed
 * from one decision while the state recorded another.
 */
export function selectBatchWinner(
  decisions: readonly RoutingPendingDecision[],
): RoutingPendingDecision | null {
  if (decisions.length === 0) return null
  return decisions.reduce((best, entry) => (
    tierRank(entry.selectedDifficulty) > tierRank(best.selectedDifficulty) ? entry : best
  ))
}

/**
 * Whether the latest floor outranks what this queued decision is about to run,
 * and if so the exact route that should replace it.
 *
 * This is the engine boundary's last chance to be correct: the decision was
 * computed when the request was accepted, and another execution may have raised
 * the floor since. The caller must apply the returned route to the *actual*
 * engine settings — recording it in the ledger alone would leave the turn
 * running on the stale model while the state claimed otherwise.
 *
 * Returns null whenever the raise cannot be justified: already at or above the
 * floor, a temporary escalation already in flight, an unsupported stored pair,
 * or a model this request's own policy snapshot forbids (R6 — continuity never
 * licenses running a forbidden model).
 */
export function resolveEngineBoundaryRoute(
  state: DifficultyRoutingSessionState,
  decision: RoutingPendingDecision,
  agent: RoutableAgent,
  now: number = Date.now(),
): {
  model: string
  effort: string | null
  difficulty: Difficulty
  reasons: RoutingDecisionReason[]
  /**
   * Set only when the raise changed what kind of turn this is. A correction that
   * only fixes the model/effort at the SAME tier leaves it undefined, so the
   * decision's own intent stands — otherwise a user's "it's fixed" would be
   * silently converted into another hard turn by a cosmetic model correction.
   */
  hardTurnsIntent?: RoutingHardTurnsIntent
  temporaryEscalation?: true
} | null {
  // A manual pin is the user's explicit instruction and is never overridden.
  // A client-routed turn is not: it is an automatic choice made with less
  // information, so it gets the same protection as our own.
  if ((decision.kind ?? 'auto') === 'manual') return null

  // Checked before the floor raise: a stale cheap turn sitting behind a hard
  // streak has earned the escalation, and raising it only to the floor would
  // still miss it.
  const escalation = resolveBoundaryEscalation(state, decision, agent, now)
  if (escalation) return escalation
  const base = state.base
  if (!base) return null
  // A turn already above the floor needs nothing.
  if (tierRank(decision.selectedDifficulty) > tierRank(base.difficulty)) return null
  // At the SAME tier the exact pair can still differ — the floor's model may
  // have changed between accept and apply (a cross-generation client, a policy
  // substitution). Running the queued pair then quietly reverts the floor's
  // model, which is the continuity this whole feature is about.
  if (tierRank(decision.selectedDifficulty) === tierRank(base.difficulty)
    && decision.selected.model === base.model
    && decision.selected.effort === base.effort) {
    return null
  }
  // A temporary escalation is deliberately above its base and must not be
  // pulled back down to it.
  if (decision.temporaryEscalation) return null

  // The floor's own stored pair, not today's catalog default for the tier:
  // retaining the exact model/effort is what keeps the conversation on one model.
  const candidate = { difficulty: base.difficulty, model: base.model, effort: base.effort }
  // Recognised in EITHER generation: a floor written by a newer client is still
  // a real floor, and refusing it here would drop it back to the cheap tier.
  if (!isKnownRoutePair(agent, candidate)) return null
  if (!isAllowedByPolicySnapshot(decision.policySnapshot, agent, candidate.model)) return null

  // Did the tier actually move, or is this only a model/effort correction?
  const tierRose = tierRank(candidate.difficulty) > tierRank(decision.selectedDifficulty)
  return {
    ...candidate,
    reasons: ['stale-queued-decision', 'sticky-floor-maintained'],
    // Only a genuine rise into a hard tier changes what the counters describe.
    // A same-tier correction keeps the decision's intent (and its legacy
    // fallback) by leaving this undefined.
    ...(tierRose && (candidate.difficulty === 'hard' || candidate.difficulty === 'escalated')
      ? { hardTurnsIntent: 'increment' as const }
      : {}),
  }
}

/**
 * Re-checks the count-based escalation rule against the streak as it stands NOW.
 *
 * The classifier decides escalation when a request is accepted, from a counter
 * that other executions can move before this one runs. Two hard turns applying
 * ahead of a third leave that third turn running the ordinary hard model even
 * though it is the turn that crosses the threshold — escalation arrives a turn
 * late, which is exactly when it is least useful.
 *
 * Only the count clause is re-checked. The classifier's other route into
 * escalation reads a frustration signal out of the prompt, and the prompt is
 * deliberately not carried this far (the contract keeps routing text out of
 * state and logs), so that judgement stays where the text is.
 */
function resolveBoundaryEscalation(
  state: DifficultyRoutingSessionState,
  decision: RoutingPendingDecision,
  agent: RoutableAgent,
  now: number,
): {
  model: string
  effort: string | null
  difficulty: Difficulty
  reasons: RoutingDecisionReason[]
  hardTurnsIntent: RoutingHardTurnsIntent
  temporaryEscalation: true
} | null {
  if (decision.temporaryEscalation) return null
  // Mirrors the classifier: only a turn genuinely classified hard escalates,
  // never one that merely inherited the hard floor.
  if (decision.candidateDifficulty !== 'hard') return null

  const intent = decision.hardTurnsIntent ?? 'none'
  const streakAfterThisTurn = applyHardTurnsIntent(effectiveEscalation(state, now).hardTurns, intent)
  if (streakAfterThisTurn < HARD_TURNS_BEFORE_ESCALATION) return null

  const route = USER_REQUEST_MODELS[agent].escalated
  if (!isKnownRoutePair(agent, route)) return null
  if (!isAllowedByPolicySnapshot(decision.policySnapshot, agent, route.model)) return null

  return {
    model: route.model,
    effort: route.effort,
    difficulty: 'escalated',
    reasons: ['stale-queued-decision', 'temporary-escalation'],
    hardTurnsIntent: intent,
    temporaryEscalation: true,
  }
}

function isAllowedByPolicySnapshot(
  snapshot: RoutingPolicySnapshot | undefined,
  agent: RoutableAgent,
  model: string,
): boolean {
  if (!snapshot || snapshot.allowedSelectionKeys === null) return true
  return snapshot.allowedSelectionKeys.includes(`${agent}:${model}`)
}

/**
 * The floor only moves up on its own. It moves *down* only when the decision
 * itself says the higher tier was unavailable — an org policy substitution or an
 * explicit context reset. Without that exception a session whose floor model was
 * revoked would keep a floor it can never run on; without the rule, one
 * misclassified easy message would undo a hard conversation's floor.
 */
function resolveCommittedBase(
  current: RoutingBaseRoute | undefined,
  winner: RoutingPendingDecision,
  input: CommitAppliedInput,
): RoutingBaseRoute {
  const committed: RoutingBaseRoute = {
    difficulty: winner.base.difficulty,
    model: winner.base.model,
    effort: winner.base.effort,
    // A bootstrap records that the model really was applied, but the tier came
    // from the client, so it must not masquerade as this CLI's own evidence.
    provenance: winner.baseProvenance ?? 'engine-applied',
    policyVersion: winner.policyVersion,
    policyRevision: winner.policyRevision,
    appliedAt: input.now,
    executionId: input.executionId,
    clientRequestIds: [...input.clientRequestIds],
  }
  if (!current) return committed
  const forcedDown = winner.decisionReasons.includes('policy-fallback')
    || winner.decisionReasons.includes('context-reset')
  if (forcedDown) return committed
  return tierRank(committed.difficulty) >= tierRank(current.difficulty)
    ? committed
    // Keep the established floor's identity, but record that this execution
    // re-confirmed it — otherwise `appliedAt` would freeze at the first commit.
    : { ...current, appliedAt: input.now, executionId: input.executionId, clientRequestIds: [...input.clientRequestIds] }
}

/**
 * An explicit new-context boundary (`/clear` and friends). This is *not* the idle
 * path: an idle gap keeps the floor and only ages the counters, while a context
 * reset really does start a new conversation and so starts a new floor.
 */
/**
 * A context reset has been accepted but the provider has not reset yet.
 *
 * Recorded separately from the reset itself because the two are not the same
 * moment: between them, further user requests are accepted and really do run.
 */
export function requestRoutingEpoch(
  state: DifficultyRoutingSessionState,
  now: number,
): DifficultyRoutingSessionState {
  return { ...state, revision: state.revision + 1, epochRequestedAt: now }
}

/**
 * The provider actually reset. The floor, the counters and the receipts all
 * belong to the conversation that just ended.
 *
 * Pending decisions accepted *after* the reset was requested are kept: their
 * queue entries survived the flush and will still be executed, so discarding
 * their receipts would leave those turns unable to commit anything. Without a
 * recorded request there is no cutoff to reason about, so nothing is kept —
 * guessing one would preserve genuinely stale decisions.
 */
export function startRoutingEpoch(
  state: DifficultyRoutingSessionState,
  now: number,
): DifficultyRoutingSessionState {
  const cutoff = state.epochRequestedAt
  const carried = cutoff === undefined
    ? {}
    : Object.fromEntries(
      Object.entries(state.pending ?? {}).filter(([, decision]) => decision.createdAt >= cutoff),
    )
  return {
    stateVersion: ROUTING_STATE_VERSION,
    revision: state.revision + 1,
    epochStartedAt: now,
    ...(Object.keys(carried).length > 0 ? { pending: carried } : {}),
    // A reset starts a new conversation; it does not make an unreadable record
    // readable, nor does it license writing over a newer writer.
    ...(state.floorUnknown ? { floorUnknown: state.floorUnknown } : {}),
    ...(state.foreignStateVersion !== undefined ? { foreignStateVersion: state.foreignStateVersion } : {}),
    // The ledger is epoch-scoped: a new context may legitimately reuse ids.
  }
}

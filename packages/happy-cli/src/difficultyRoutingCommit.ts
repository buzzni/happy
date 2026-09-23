/**
 * Holds a session's auto-routing state across the gap between *accepting* a
 * request and the runner *applying* its settings to the execution engine.
 *
 * Both runners (Claude and Codex) drive the same three operations, so they live
 * here rather than being re-implemented per runner, where they drifted before:
 *
 * - `recordPending` — a request was accepted into the queue. Nothing durable moves.
 * - `commitApplied` — the runner handed a batch's settings to the engine. The
 *   floor and the counters move exactly once, for the whole batch.
 * - `discardPending` — the request will not run under this decision.
 *
 * "Applied" is this runner's own boundary. It is not evidence that a provider
 * received the request, ran that model, or answered; no code here observes the
 * provider.
 */

import { logger } from '@/ui/logger'
import type { SessionEnvelope } from '@slopus/happy-wire'
import { createDifficultyRoutingAppliedEvent } from './difficultyRoutingRuntime'
import {
  canPersistRoutingState,
  commitAppliedRouting,
  discardPendingDecisions,
  normalizeRoutingSessionState,
  recordPendingDecision,
  requestRoutingEpoch,
  isFloorRaiseBlockedByPolicy,
  resolveEngineBoundaryRoute,
  selectBatchWinner,
  startRoutingEpoch,
  type DifficultyRoutingSessionState,
  type RoutingPendingDecision,
} from './difficultyRoutingSessionState'
import type { RoutableAgent } from './difficultyRoutingPolicy'

export type DifficultyRoutingCommitterOptions = {
  agent: RoutableAgent
  /** Persist the state. Skipped entirely when the record belongs to a newer writer. */
  persist: (state: DifficultyRoutingSessionState) => void
  emit: (envelope: SessionEnvelope) => void
  now?: () => number
}

export class DifficultyRoutingCommitter {
  private state: DifficultyRoutingSessionState
  private readonly now: () => number

  constructor(initial: unknown, private readonly opts: DifficultyRoutingCommitterOptions) {
    this.state = normalizeRoutingSessionState(initial, opts.agent)
    this.now = opts.now ?? Date.now
  }

  current(): DifficultyRoutingSessionState {
    return this.state
  }

  /**
   * Adopts the state the decision already carries (it contains the pending
   * entry). Persisted so a restart before the engine boundary still knows a
   * decision was pending — read back as pending, never as applied.
   */
  recordPending(next: DifficultyRoutingSessionState): void {
    if (!canPersistRoutingState(this.state)) return
    const pending = { ...this.state.pending }
    for (const [id, decision] of Object.entries(next.pending ?? {})) {
      if (!this.alreadyApplied(id)) pending[id] = decision
    }
    this.state = { ...this.state, revision: this.state.revision + 1, pending }
    this.persist()
  }

  /**
   * Whether this request has already been applied in this epoch.
   *
   * Reads the epoch receipts, not `lastApplied`: the latter names only the most
   * recent execution, so filtering on it let an older applied request back into
   * `pending`, where it then sat forever — the commit correctly refuses it
   * (it is in the receipts) and nothing else ever clears it.
   */
  private alreadyApplied(clientRequestId: string): boolean {
    return (this.state.appliedRequestIds ?? []).includes(clientRequestId)
  }

  /**
   * The engine-applied boundary. `clientRequestIds` is every request merged into
   * this execution, so a batch commits once rather than once per input.
   *
   * Emits an `applied` event only when something was actually committed — an
   * unmatched or replayed execution emits nothing, because claiming an apply
   * that did not happen is exactly what the old queue-time event did.
   */
  commitApplied(
    clientRequestIds: readonly string[] | undefined,
    executionId: string,
  ): { model: string; effort: string | null } | null {
    if (!clientRequestIds || clientRequestIds.length === 0) return null

    /*
     * The decision was computed when the request was accepted; another
     * execution may have raised the floor since. Recompute against the *latest*
     * floor before committing, and hand the revision back so the caller can put
     * it into the engine's actual settings. Recording it here while the turn ran
     * on the stale model would make the state a claim rather than a record.
     */
    const alreadyApplied = new Set(this.state.appliedRequestIds ?? [])
    const queued = clientRequestIds
      .filter((id) => !alreadyApplied.has(id))
      .map((id) => this.state.pending?.[id])
      .filter((entry): entry is RoutingPendingDecision => Boolean(entry))
    // The same winner rule the commit will use. Picking differently here would
    // let the engine run one decision's model while the state recorded another.
    const winner = selectBatchWinner(queued)
    const revised = winner ? resolveEngineBoundaryRoute(this.state, winner, this.opts.agent, this.now()) : null
    // The floor outranks this turn but this turn's policy forbids the floor's
    // model, so it runs lower deliberately. Recorded as such, never as the
    // higher floor being re-confirmed by a turn that never reached it.
    const policyBlocked = !revised && winner
      ? isFloorRaiseBlockedByPolicy(this.state, winner, this.opts.agent)
      : false

    // Captured before the commit overwrites it — this is the route the PREVIOUS
    // execution ran on, which is what a reader of this event needs.
    const previousApplied = this.state.lastAppliedRoute
    const { state, applied } = commitAppliedRouting(this.state, {
      clientRequestIds,
      executionId,
      now: this.now(),
      ...(revised ? { revised } : {}),
      ...(policyBlocked ? { policyBlocked } : {}),
    })
    if (!applied) return null
    this.state = state
    this.persist()

    /*
     * A manual pin is recorded but not announced: the result event's `mode` is
     * `auto`, so publishing a pinned turn as an automatic routing result would
     * misdescribe it.
     *
     * A client-routed turn IS announced. It is an automatic selection, and
     * without the event a client that later moves between local and shared
     * routing has no way to learn the floor this execution established — the
     * exact restore gap in AC3. Its weaker evidence travels in `evidence`.
     */
    if ((applied.kind ?? 'auto') !== 'manual') {
      this.emit(createDifficultyRoutingAppliedEvent({
        applied,
        clientRequestIds,
        executionId,
        revision: state.revision,
        evidence: applied.baseProvenance ?? 'engine-applied',
        ...(previousApplied
          ? {
            previousApplied: {
              model: previousApplied.model,
              effort: previousApplied.effort,
              difficulty: previousApplied.difficulty,
              kind: previousApplied.kind,
            },
          }
          : {}),
      }))
    }
    logger.debug('[difficultyRouting] engine-applied', {
      executionId,
      kind: applied.kind ?? 'auto',
      requestCount: clientRequestIds.length,
      model: revised?.model ?? applied.selected.model,
      effort: revised?.effort ?? applied.selected.effort,
      baseDifficulty: applied.base.difficulty,
      temporaryEscalation: applied.temporaryEscalation,
      revisedAtBoundary: Boolean(revised),
      policyBlockedAtBoundary: policyBlocked,
    })
    return revised ? { model: revised.model, effort: revised.effort } : null
  }

  /**
   * A turn this CLI did not route: the client's own auto-router chose it, or the
   * user pinned it. Kept in the same pending channel so the engine boundary
   * commits it through exactly one path.
   */
  recordLocalPending(decision: RoutingPendingDecision): void {
    if (!canPersistRoutingState(this.state)) return
    if (this.alreadyApplied(decision.clientRequestId)) return
    this.state = recordPendingDecision(this.state, decision)
    this.persist()
  }

  /** A request that will never reach the engine. The floor never moved for it. */
  discardPending(clientRequestIds: readonly string[], reason: 'cancelled' | 'failed' | 'superseded'): void {
    const next = discardPendingDecisions(this.state, clientRequestIds, reason)
    if (next === this.state) return
    this.state = next
    this.persist()
    logger.debug('[difficultyRouting] pending-discarded', { reason, requestCount: clientRequestIds.length })
  }

  /**
   * An explicit new-context boundary. Distinct from idle: idle keeps the floor
   * and only ages the counters, whereas this really does start a new conversation.
   */
  /**
   * A context reset was accepted. Phase one of two: nothing is cleared yet,
   * because turns accepted between here and the provider's actual reset really
   * do run and need their receipts.
   */
  requestEpoch(): void {
    if (!canPersistRoutingState(this.state)) return
    this.state = requestRoutingEpoch(this.state, this.now())
    this.persist()
    logger.debug('[difficultyRouting] routing-epoch-requested')
  }

  /** Phase two: the provider actually reset. */
  startEpoch(): void {
    if (!canPersistRoutingState(this.state)) return
    const carriedBefore = Object.keys(this.state.pending ?? {}).length
    this.state = startRoutingEpoch(this.state, this.now())
    this.persist()
    logger.debug('[difficultyRouting] routing-epoch-started', {
      pendingBefore: carriedBefore,
      pendingCarried: Object.keys(this.state.pending ?? {}).length,
    })
  }

  /*
   * Routing bookkeeping must never take the chat down with it. Both sinks are
   * owned by the session transport, which can fail transiently; a throw here
   * would propagate into the user-message handler and drop the turn.
   *
   * The failure is logged with non-content detail only (R13) — never the state,
   * the prompt or the model choice — and is deliberately visible rather than
   * swallowed, because a persist that silently never lands looks exactly like
   * "routing is off" from the field.
   */
  private persist(): void {
    // A record written by a newer CLI holds fields this build cannot represent.
    // Writing over it would destroy them, so this build reads and never writes.
    if (!canPersistRoutingState(this.state)) {
      logger.debug('[difficultyRouting] persist-skipped', { reason: 'foreign-state-version' })
      return
    }
    try {
      this.opts.persist(this.state)
    } catch (error) {
      logger.warn('[difficultyRouting] persist-failed', {
        errorName: error instanceof Error ? error.name : typeof error,
        revision: this.state.revision,
      })
    }
  }

  private emit(envelope: SessionEnvelope): void {
    try {
      this.opts.emit(envelope)
    } catch (error) {
      logger.warn('[difficultyRouting] emit-failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      })
    }
  }
}

export type { RoutingPendingDecision }

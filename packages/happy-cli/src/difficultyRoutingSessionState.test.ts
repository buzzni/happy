import { describe, expect, it } from 'vitest'
import {
  ROUTING_STATE_VERSION,
  baseFloorDifficulty,
  canPersistRoutingState,
  commitAppliedRouting,
  discardPendingDecisions,
  effectiveEscalation,
  isFloorUnknown,
  normalizeRoutingSessionState,
  pendingDecision,
  recordPendingDecision,
  requestRoutingEpoch,
  isFloorRaiseBlockedByPolicy,
  resolveEngineBoundaryRoute,
  startRoutingEpoch,
  type DifficultyRoutingSessionState,
  type RoutingPendingDecision,
} from './difficultyRoutingSessionState'

const HOUR = 60 * 60 * 1000
const NOW = 1_700_000_000_000

function pending(overrides: Partial<RoutingPendingDecision> = {}): RoutingPendingDecision {
  return {
    clientRequestId: 'req-1',
    candidateDifficulty: 'hard',
    selectedDifficulty: 'hard',
    selected: { model: 'claude-opus-5', effort: 'high' },
    base: { difficulty: 'hard', model: 'claude-opus-5', effort: 'high' },
    temporaryEscalation: false,
    hardTurns: 1,
    decisionReasons: ['classified-up'],
    classifierSource: 'p1-local',
    policyRevision: 7,
    policyVersion: 'org-shared-difficulty-routing.v1',
    createdAt: NOW,
    ...overrides,
  }
}

describe('normalizeRoutingSessionState', () => {
  it('shouldReturnEmptyVersionedStateForMissingInput', () => {
    const state = normalizeRoutingSessionState(undefined, 'claude')
    expect(state).toEqual({ stateVersion: ROUTING_STATE_VERSION, revision: 0 })
  })

  it('shouldMigrateLegacyStateKeepingLegacySelectionProvenance', () => {
    const state = normalizeRoutingSessionState(
      { difficulty: 'hard', hardTurns: 2, updatedAt: NOW - 10 },
      'claude',
    )
    expect(state.base).toMatchObject({
      difficulty: 'hard',
      model: 'claude-opus-5-5',
      effort: 'high',
      provenance: 'legacy-selection',
    })
    expect(state.escalation).toEqual({ hardTurns: 2, updatedAt: NOW - 10 })
  })

  it('shouldNotInventABaseRouteFromLegacyStateWithoutADifficulty', () => {
    const state = normalizeRoutingSessionState({ hardTurns: 3, updatedAt: NOW }, 'claude')
    expect(state.base).toBeUndefined()
    expect(state.escalation).toEqual({ hardTurns: 3, updatedAt: NOW })
  })

  it('shouldNotPromoteLegacyEscalatedTierIntoTheBaseFloor', () => {
    const state = normalizeRoutingSessionState(
      { difficulty: 'escalated', hardTurns: 3, updatedAt: NOW },
      'claude',
    )
    expect(state.base?.difficulty).toBe('hard')
  })

  it('shouldKeepAnAlreadyVersionedStateAsIs', () => {
    const v2 = {
      stateVersion: ROUTING_STATE_VERSION,
      revision: 5,
      base: {
        difficulty: 'routine' as const,
        model: 'claude-sonnet-5',
        effort: 'high',
        provenance: 'engine-applied' as const,
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 7,
        appliedAt: NOW,
      },
    }
    expect(normalizeRoutingSessionState(v2, 'claude')).toEqual(v2)
  })

  it('shouldMarkAnUnknownFutureStateVersionAsUnknownFloorRatherThanNoFloor', () => {
    const state = normalizeRoutingSessionState({ stateVersion: 99, revision: 3 }, 'claude')
    expect(state.base).toBeUndefined()
    expect(state.revision).toBe(3)
    expect(isFloorUnknown(state)).toBe(true)
  })

  it('preserves unreadable state guards when normalized more than once', () => {
    for (const raw of [{ stateVersion: 99, revision: 3 }, { stateVersion: 2, revision: 4, base: {} }]) {
      const once = normalizeRoutingSessionState(raw, 'claude')
      const twice = normalizeRoutingSessionState(once, 'claude')
      expect(twice).toEqual(once)
      expect(isFloorUnknown(twice)).toBe(true)
    }
  })

  it('shouldRefuseToPersistOverARecordWrittenByANewerVersion', () => {
    const state = normalizeRoutingSessionState({ stateVersion: 99, revision: 3 }, 'claude')
    expect(canPersistRoutingState(state)).toBe(false)
    expect(canPersistRoutingState(normalizeRoutingSessionState(undefined, 'claude'))).toBe(true)
  })

  it('shouldTreatAStructurallyInvalidV2RecordAsUnknownInsteadOfTrustingTheCast', () => {
    const state = normalizeRoutingSessionState({
      stateVersion: ROUTING_STATE_VERSION,
      revision: 4,
      base: { difficulty: 'nonsense', model: 42 },
    }, 'claude')
    expect(state.base).toBeUndefined()
    expect(isFloorUnknown(state)).toBe(true)
    expect(state.revision).toBe(4)
  })

  it('shouldDropAnInvalidPendingEntryWithoutDiscardingAValidBase', () => {
    const state = normalizeRoutingSessionState({
      stateVersion: ROUTING_STATE_VERSION,
      revision: 2,
      base: {
        difficulty: 'hard',
        model: 'claude-opus-5',
        effort: 'high',
        provenance: 'engine-applied',
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 7,
        appliedAt: NOW,
      },
      pending: { bad: { clientRequestId: 'bad' } },
    }, 'claude')
    expect(state.base?.difficulty).toBe('hard')
    expect(state.pending).toBeUndefined()
    expect(isFloorUnknown(state)).toBe(false)
  })

  it('shouldNotReportAnUnknownFloorForAFreshSessionThatSimplyHasNoHistory', () => {
    expect(isFloorUnknown(normalizeRoutingSessionState(undefined, 'claude'))).toBe(false)
  })
})

describe('baseFloorDifficulty', () => {
  it('shouldKeepTheFloorAfterAnIdleGapLongerThanTheOldStickyTtl', () => {
    const state = normalizeRoutingSessionState(
      { difficulty: 'hard', hardTurns: 2, updatedAt: NOW - HOUR - 1 },
      'claude',
    )
    expect(baseFloorDifficulty(state)).toBe('hard')
  })
})

describe('effectiveEscalation', () => {
  it('shouldExpireOnlyTheCountersAfterTheIdleWindow', () => {
    const state = normalizeRoutingSessionState(
      { difficulty: 'hard', hardTurns: 2, updatedAt: NOW - HOUR - 1 },
      'claude',
    )
    expect(effectiveEscalation(state, NOW)).toEqual({ hardTurns: 0, ageMs: undefined })
    expect(baseFloorDifficulty(state)).toBe('hard')
  })

  it('shouldKeepFreshCounters', () => {
    const state = normalizeRoutingSessionState(
      { difficulty: 'hard', hardTurns: 2, updatedAt: NOW - 1000 },
      'claude',
    )
    expect(effectiveEscalation(state, NOW)).toEqual({ hardTurns: 2, ageMs: 1000 })
  })
})

describe('recordPendingDecision', () => {
  it('shouldNotTouchTheBaseFloorOrCounters', () => {
    const before = normalizeRoutingSessionState(undefined, 'claude')
    const after = recordPendingDecision(before, pending())
    expect(after.base).toBeUndefined()
    expect(after.escalation).toBeUndefined()
    expect(pendingDecision(after, 'req-1')).toMatchObject({ selectedDifficulty: 'hard' })
  })

  it('shouldAdvanceRevisionMonotonically', () => {
    const state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    expect(state.revision).toBe(1)
    expect(recordPendingDecision(state, pending({ clientRequestId: 'req-2' })).revision).toBe(2)
  })

  it('shouldReplaceRatherThanDuplicateAResendOfTheSameClientRequestId', () => {
    const first = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    const second = recordPendingDecision(first, pending({ selectedDifficulty: 'trivial' }))
    expect(Object.keys(second.pending ?? {})).toEqual(['req-1'])
    expect(pendingDecision(second, 'req-1')?.selectedDifficulty).toBe('trivial')
  })
})

describe('commitAppliedRouting', () => {
  it('shouldCommitTheBaseFloorOnlyWhenTheEngineAppliesTheSetting', () => {
    const queued = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    expect(baseFloorDifficulty(queued)).toBeUndefined()

    const { state, applied } = commitAppliedRouting(queued, {
      clientRequestIds: ['req-1'],
      executionId: 'exec-1',
      now: NOW,
    })
    expect(applied).not.toBeNull()
    expect(baseFloorDifficulty(state)).toBe('hard')
    expect(state.base?.provenance).toBe('engine-applied')
    expect(state.base?.clientRequestIds).toEqual(['req-1'])
    expect(state.escalation?.hardTurns).toBe(1)
    expect(state.pending).toBeUndefined()
  })

  it('shouldUpdateCountersOnceForAnExecutionThatMergedSeveralInputs', () => {
    let state = normalizeRoutingSessionState(undefined, 'claude')
    state = recordPendingDecision(state, pending({ clientRequestId: 'a', hardTurns: 1 }))
    state = recordPendingDecision(state, pending({ clientRequestId: 'b', hardTurns: 1 }))

    const committed = commitAppliedRouting(state, {
      clientRequestIds: ['a', 'b'],
      executionId: 'exec-1',
      now: NOW,
    })
    expect(committed.state.escalation?.hardTurns).toBe(1)
    expect(committed.state.base?.clientRequestIds).toEqual(['a', 'b'])
  })

  it('shouldApplyTheHighestCandidateOfABatchWithoutCountingItTwice', () => {
    let state = normalizeRoutingSessionState(undefined, 'claude')
    state = recordPendingDecision(state, pending({
      clientRequestId: 'a',
      selectedDifficulty: 'trivial',
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      hardTurns: 0,
    }))
    state = recordPendingDecision(state, pending({ clientRequestId: 'b', hardTurns: 1 }))

    const committed = commitAppliedRouting(state, {
      clientRequestIds: ['a', 'b'],
      executionId: 'exec-1',
      now: NOW,
    })
    expect(committed.state.base?.difficulty).toBe('hard')
    expect(committed.state.escalation?.hardTurns).toBe(1)
  })

  it('shouldBeIdempotentForARepeatOfTheSameExecutionIdEvenWhenThatRequestIsPendingAgain', () => {
    // The weak version of this test drained `pending` at the first commit, so a
    // deleted executionId guard still "passed". A re-sent request re-populates
    // pending under the same id, which is precisely when the guard has to hold.
    const queued = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    const first = commitAppliedRouting(queued, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW })
    const resent = recordPendingDecision(first.state, pending({ hardTurns: 2 }))

    const second = commitAppliedRouting(resent, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW })

    expect(second.applied).toBeNull()
    expect(second.state).toBe(resent)
    expect(second.state.escalation?.hardTurns).toBe(1)
    expect(pendingDecision(second.state, 'req-1')).toBeDefined()
  })

  it('shouldCountANewExecutionOfTheSameRequestOnlyOnce', () => {
    const queued = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    const first = commitAppliedRouting(queued, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW })
    // Nothing re-queued it, so a different execution claiming the same request
    // finds no pending decision and must not move the counters again.
    const second = commitAppliedRouting(first.state, { clientRequestIds: ['req-1'], executionId: 'exec-2', now: NOW })
    expect(second.applied).toBeNull()
    expect(second.state.escalation?.hardTurns).toBe(1)
  })

  it('shouldIgnoreAnExecutionWithNoMatchingPendingDecision', () => {
    const state = normalizeRoutingSessionState(undefined, 'claude')
    const result = commitAppliedRouting(state, { clientRequestIds: ['ghost'], executionId: 'exec-1', now: NOW })
    expect(result.applied).toBeNull()
    expect(result.state).toBe(state)
  })

  it('shouldCommitTheBaseTierNotTheTemporarilyEscalatedOne', () => {
    const queued = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
      selectedDifficulty: 'escalated',
      selected: { model: 'claude-fable-5-1', effort: 'high' },
      base: { difficulty: 'hard', model: 'claude-opus-5', effort: 'high' },
      temporaryEscalation: true,
      hardTurns: 3,
      decisionReasons: ['temporary-escalation'],
    }))
    const { state, applied } = commitAppliedRouting(queued, {
      clientRequestIds: ['req-1'],
      executionId: 'exec-1',
      now: NOW,
    })
    expect(applied?.selected.model).toBe('claude-fable-5-1')
    expect(state.base).toMatchObject({ difficulty: 'hard', model: 'claude-opus-5', effort: 'high' })
  })

  it('shouldNotLowerAnEstablishedFloorWhenTheAppliedTurnClassifiedLower', () => {
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state
    state = recordPendingDecision(state, pending({
      clientRequestId: 'req-2',
      selectedDifficulty: 'trivial',
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      hardTurns: 0,
    }))
    const after = commitAppliedRouting(state, { clientRequestIds: ['req-2'], executionId: 'exec-2', now: NOW })
    expect(after.state.base?.difficulty).toBe('hard')
  })

  it('shouldAdoptALowerFloorWhenAPolicyFallbackForcedTheSubstitution', () => {
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state
    state = recordPendingDecision(state, pending({
      clientRequestId: 'req-2',
      selectedDifficulty: 'hard',
      selected: { model: 'claude-sonnet-5', effort: 'high' },
      base: { difficulty: 'routine', model: 'claude-sonnet-5', effort: 'high' },
      decisionReasons: ['policy-fallback'],
      hardTurns: 1,
    }))
    const after = commitAppliedRouting(state, { clientRequestIds: ['req-2'], executionId: 'exec-2', now: NOW })
    expect(after.state.base).toMatchObject({ difficulty: 'routine', model: 'claude-sonnet-5' })
  })
})

describe('discardPendingDecisions', () => {
  it('shouldLeaveTheFloorAndCountersUnchangedForACancelledTurn', () => {
    const queued = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    const after = discardPendingDecisions(queued, ['req-1'], 'cancelled')
    expect(after.pending).toBeUndefined()
    expect(after.base).toBeUndefined()
    expect(after.escalation).toBeUndefined()
  })

  it('shouldNotAdvanceRevisionWhenNothingMatched', () => {
    const queued = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    expect(discardPendingDecisions(queued, ['other'], 'cancelled')).toBe(queued)
  })
})

describe('startRoutingEpoch', () => {
  it('shouldClearTheFloorForAnExplicitContextResetUnlikeAnIdleGap', () => {
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state
    const cleared = startRoutingEpoch(state, NOW)
    expect(cleared.base).toBeUndefined()
    expect(cleared.escalation).toBeUndefined()
    expect(cleared.pending).toBeUndefined()
    expect(cleared.epochStartedAt).toBe(NOW)
    expect(cleared.revision).toBeGreaterThan(state.revision)
  })
})

// ---------------------------------------------------------------------------
// Review follow-up: R7 idempotence beyond `lastApplied`, R7 stale-decision
// recompute at the engine boundary, R2/R5 bootstrap and manual observation.
// ---------------------------------------------------------------------------

describe('applied-request ledger (R7)', () => {
  it('shouldNotRerunARequestReplayedTwoExecutionsLater', () => {
    // `lastApplied` remembers only the most recent execution, so a late replay
    // separated by another execution used to slip past it and move the counters
    // a second time for a single user request.
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state
    state = recordPendingDecision(state, pending({ clientRequestId: 'other', hardTurns: 2 }))
    state = commitAppliedRouting(state, { clientRequestIds: ['other'], executionId: 'exec-2', now: NOW }).state

    // The late replay: req-1 is queued again and a third execution claims it.
    state = recordPendingDecision(state, pending({ hardTurns: 9 }))
    const replay = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-3', now: NOW })

    expect(replay.applied).toBeNull()
    expect(replay.state.escalation?.hardTurns).toBe(2)
  })

  it('shouldStillApplyTheUnseenRequestsOfAPartiallyReplayedBatch', () => {
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state
    state = recordPendingDecision(state, pending({ clientRequestId: 'fresh', hardTurnsIntent: 'increment' }))

    const mixed = commitAppliedRouting(state, {
      clientRequestIds: ['req-1', 'fresh'],
      executionId: 'exec-2',
      now: NOW,
    })

    expect(mixed.applied?.clientRequestId).toBe('fresh')
    // The unseen request advances the streak once; the replayed one adds nothing.
    expect(mixed.state.escalation?.hardTurns).toBe(2)
  })

})

describe('stale queued decisions at the engine boundary (R7)', () => {
  it('shouldNotLetAStaleLowerDecisionErodeAnEstablishedStreak', () => {
    // A decision computed before the floor rose must not drag the streak down
    // with it. A genuine resolution signal is a different thing and is covered
    // separately — that one *should* reset, because the user said it is fixed.
    let state = normalizeRoutingSessionState(undefined, 'claude')
    for (const id of ['h1', 'h2', 'h3']) {
      state = recordPendingDecision(state, pending({ clientRequestId: id, hardTurnsIntent: 'increment' }))
      state = commitAppliedRouting(state, { clientRequestIds: [id], executionId: `x-${id}`, now: NOW }).state
    }
    expect(state.escalation?.hardTurns).toBe(3)

    state = recordPendingDecision(state, pending({
      clientRequestId: 'stale',
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      hardTurnsIntent: 'none',
    }))
    const after = commitAppliedRouting(state, { clientRequestIds: ['stale'], executionId: 'exec-2', now: NOW })

    expect(after.state.base?.difficulty).toBe('hard')
    expect(after.state.escalation?.hardTurns).toBe(3)
  })

  it('shouldStillHonourAGenuineResolutionSignalAgainstAHardFloor', () => {
    let state = recordPendingDecision(
      normalizeRoutingSessionState(undefined, 'claude'),
      pending({ hardTurnsIntent: 'increment' }),
    )
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state
    state = recordPendingDecision(state, pending({ clientRequestId: 'fixed', hardTurnsIntent: 'reset' }))

    const after = commitAppliedRouting(state, { clientRequestIds: ['fixed'], executionId: 'exec-2', now: NOW })

    // The floor still holds — resolution ends a streak, not a conversation.
    expect(after.state.base?.difficulty).toBe('hard')
    expect(after.state.escalation?.hardTurns).toBe(0)
  })

  it('shouldRaiseAStaleDecisionToTheLatestFloorKeepingItsExactStoredPair', () => {
    const state: DifficultyRoutingSessionState = {
      stateVersion: ROUTING_STATE_VERSION,
      revision: 3,
      base: {
        difficulty: 'hard',
        // A stored pair that is NOT today's catalog default for the tier.
        model: 'claude-opus-5',
        effort: 'high',
        provenance: 'engine-applied',
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 7,
        appliedAt: NOW,
      },
    }
    const stale = pending({
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      hardTurns: 0,
    })

    const revised = resolveEngineBoundaryRoute(state, stale, 'claude')

    expect(revised).toMatchObject({
      model: 'claude-opus-5',
      effort: 'high',
      difficulty: 'hard',
    })
    expect(revised?.reasons).toContain('stale-queued-decision')
  })

  it('shouldLeaveADecisionAloneWhenItAlreadyMeetsTheFloor', () => {
    const state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending()),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    ).state

    expect(resolveEngineBoundaryRoute(state, pending({ clientRequestId: 'b' }), 'claude')).toBeNull()
  })

  it('shouldNotRaiseAboveATemporaryEscalationAlreadyInFlight', () => {
    const state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending()),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    ).state
    const escalatedTurn = pending({
      clientRequestId: 'esc',
      selectedDifficulty: 'escalated',
      selected: { model: 'claude-fable-5-1', effort: 'high' },
      temporaryEscalation: true,
    })

    expect(resolveEngineBoundaryRoute(state, escalatedTurn, 'claude')).toBeNull()
  })

  it('shouldRefuseToRaiseIntoAModelTheTurnsOwnPolicyForbids', () => {
    // R6: cache continuity never justifies running a forbidden model. The
    // snapshot is the policy that was in force for THIS request's grant.
    const state: DifficultyRoutingSessionState = {
      stateVersion: ROUTING_STATE_VERSION,
      revision: 3,
      base: {
        difficulty: 'hard',
        model: 'claude-opus-5',
        effort: 'high',
        provenance: 'engine-applied',
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 7,
        appliedAt: NOW,
      },
    }
    const stale = pending({
      selectedDifficulty: 'routine',
      selected: { model: 'claude-sonnet-5', effort: 'high' },
      base: { difficulty: 'routine', model: 'claude-sonnet-5', effort: 'high' },
      policySnapshot: { allowedSelectionKeys: ['claude:claude-sonnet-5'], defaultSelectionKey: null },
    })

    expect(resolveEngineBoundaryRoute(state, stale, 'claude')).toBeNull()
  })

  it('shouldRefuseToRaiseIntoAnUnsupportedStoredPair', () => {
    const state: DifficultyRoutingSessionState = {
      stateVersion: ROUTING_STATE_VERSION,
      revision: 3,
      base: {
        difficulty: 'hard',
        model: 'claude-opus-5',
        effort: 'nonsense-effort',
        provenance: 'engine-applied',
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 7,
        appliedAt: NOW,
      },
    }

    expect(resolveEngineBoundaryRoute(state, pending({
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
    }), 'claude')).toBeNull()
  })
})

describe('bootstrap and manual turns (R2, R5)', () => {
  it('shouldHonourAnExplicitWeakProvenanceOnTheDecision', () => {
    // The commit does not decide evidence strength — the decision carries it.
    // Today only migrated history is weak, but the channel stays honest.
    const boot = pending({
      kind: 'local-auto-bootstrap',
      baseProvenance: 'legacy-selection',
      decisionReasons: ['legacy-bootstrap'],
    })
    const state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), boot),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    )

    expect(state.state.base).toMatchObject({ difficulty: 'hard', provenance: 'legacy-selection' })
  })

  it('shouldLetASharedAppliedTurnSupersedeABootstrappedFloorsProvenance', () => {
    let state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
        kind: 'local-auto-bootstrap',
        baseProvenance: 'legacy-selection',
      })),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    ).state
    state = recordPendingDecision(state, pending({ clientRequestId: 'shared' }))
    state = commitAppliedRouting(state, { clientRequestIds: ['shared'], executionId: 'exec-2', now: NOW }).state

    expect(state.base?.provenance).toBe('engine-applied')
  })

  it('shouldRecordAManualTurnWithoutTouchingTheFloorOrTheCounters', () => {
    const state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
        kind: 'manual',
        selected: { model: 'claude-sonnet-5', effort: 'high' },
      })),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    )

    expect(state.state.base).toBeUndefined()
    expect(state.state.escalation).toBeUndefined()
    expect(state.state.lastManual).toMatchObject({ model: 'claude-sonnet-5', effort: 'high' })
  })

  it('shouldNotLetAManualTurnLowerAnEstablishedFloor', () => {
    let state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending()),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    ).state
    state = recordPendingDecision(state, pending({
      clientRequestId: 'manual-turn',
      kind: 'manual',
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      hardTurns: 0,
    }))
    state = commitAppliedRouting(state, { clientRequestIds: ['manual-turn'], executionId: 'exec-2', now: NOW }).state

    expect(state.base?.difficulty).toBe('hard')
    expect(state.escalation?.hardTurns).toBe(1)
    expect(state.lastManual?.model).toBe('claude-haiku-4-5')
  })
})

describe('startRoutingEpoch protection', () => {
  it('shouldKeepTheUnknownAndForeignMarkersAcrossAnEpochReset', () => {
    const foreign = normalizeRoutingSessionState({ stateVersion: 99, revision: 4 }, 'claude')

    const reset = startRoutingEpoch(foreign, NOW)

    expect(isFloorUnknown(reset)).toBe(true)
    expect(canPersistRoutingState(reset)).toBe(false)
  })

  it('shouldClearTheAppliedLedgerSoANewEpochCanReuseRequestIds', () => {
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state

    expect(startRoutingEpoch(state, NOW).appliedRequestIds).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Second review pass: epoch-scoped receipts, streak recomputed at the boundary,
// manual marker lifetime, bootstrap protection.
// ---------------------------------------------------------------------------

describe('epoch receipts (R7)', () => {
  it('shouldStillRefuseAReplayOlderThanAnyFixedWindow', () => {
    // A bounded FIFO of N silently forgets, so a replay N+1 executions later
    // runs again. Receipts are epoch-scoped, not window-scoped.
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state
    for (let i = 0; i < 65; i += 1) {
      state = recordPendingDecision(state, pending({ clientRequestId: `filler-${i}` }))
      state = commitAppliedRouting(state, {
        clientRequestIds: [`filler-${i}`],
        executionId: `exec-filler-${i}`,
        now: NOW,
      }).state
    }
    const streakBefore = state.escalation?.hardTurns

    state = recordPendingDecision(state, pending())
    const replay = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'late', now: NOW })

    expect(replay.applied).toBeNull()
    expect(replay.state.escalation?.hardTurns).toBe(streakBefore)
  })
})

describe('escalation streak recomputed at the boundary (R7)', () => {
  it('shouldAdvanceOncePerExecutionForConcurrentRequestsDecidedBeforeEitherApplied', () => {
    // Both were classified against the same empty state, so both carry the same
    // absolute `hardTurns: 1`. Writing that absolute value twice pinned the
    // streak at 1 however many hard turns actually ran.
    let state = normalizeRoutingSessionState(undefined, 'claude')
    state = recordPendingDecision(state, pending({ clientRequestId: 'a', hardTurnsIntent: 'increment' }))
    state = recordPendingDecision(state, pending({ clientRequestId: 'b', hardTurnsIntent: 'increment' }))

    state = commitAppliedRouting(state, { clientRequestIds: ['a'], executionId: 'exec-a', now: NOW }).state
    expect(state.escalation?.hardTurns).toBe(1)

    state = commitAppliedRouting(state, { clientRequestIds: ['b'], executionId: 'exec-b', now: NOW }).state
    expect(state.escalation?.hardTurns).toBe(2)
  })

  it('shouldAdvanceOnlyOnceWhenThoseRequestsMergeIntoOneExecution', () => {
    let state = normalizeRoutingSessionState(undefined, 'claude')
    state = recordPendingDecision(state, pending({ clientRequestId: 'a', hardTurnsIntent: 'increment' }))
    state = recordPendingDecision(state, pending({ clientRequestId: 'b', hardTurnsIntent: 'increment' }))

    state = commitAppliedRouting(state, { clientRequestIds: ['a', 'b'], executionId: 'exec-1', now: NOW }).state

    expect(state.escalation?.hardTurns).toBe(1)
  })

  it('shouldResetTheStreakWhenTheTurnReportedResolution', () => {
    let state = normalizeRoutingSessionState(undefined, 'claude')
    state = recordPendingDecision(state, pending({ hardTurnsIntent: 'increment' }))
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'e1', now: NOW }).state
    state = recordPendingDecision(state, pending({ clientRequestId: 'resolved', hardTurnsIntent: 'reset' }))
    state = commitAppliedRouting(state, { clientRequestIds: ['resolved'], executionId: 'e2', now: NOW }).state

    expect(state.escalation?.hardTurns).toBe(0)
  })

  it('shouldAdvanceTheStreakWhenTheBoundaryItselfRaisesTheTurnToAHardFloor', () => {
    // The raise is not only a tier change: the turn now runs as a hard turn and
    // the counters have to agree with what actually ran.
    let state = normalizeRoutingSessionState(undefined, 'claude')
    state = recordPendingDecision(state, pending({ hardTurnsIntent: 'increment' }))
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'e1', now: NOW }).state

    const stale = pending({
      clientRequestId: 'stale',
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      hardTurnsIntent: 'reset',
    })
    state = recordPendingDecision(state, stale)
    const revised = resolveEngineBoundaryRoute(state, stale, 'claude')
    expect(revised?.difficulty).toBe('hard')
    expect(revised?.hardTurnsIntent).toBe('increment')

    state = commitAppliedRouting(state, {
      clientRequestIds: ['stale'],
      executionId: 'e2',
      now: NOW,
      revised: revised!,
    }).state

    expect(state.escalation?.hardTurns).toBe(2)
  })
})

describe('manual marker lifetime (R5)', () => {
  it('shouldClearTheManualMarkerOnceAnAutoTurnHasActuallyRun', () => {
    // Otherwise every later Auto turn keeps reporting a return that already
    // happened, and the reason stops meaning anything.
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
      kind: 'manual',
      selected: { model: 'claude-sonnet-5', effort: 'high' },
    }))
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'm1', now: NOW }).state
    expect(state.lastManual).toBeDefined()

    state = recordPendingDecision(state, pending({ clientRequestId: 'auto-turn' }))
    state = commitAppliedRouting(state, { clientRequestIds: ['auto-turn'], executionId: 'a1', now: NOW }).state

    expect(state.lastManual).toBeUndefined()
  })
})

describe('bootstrap boundary protection (R2)', () => {
  it('shouldRaiseAStaleLocalAutoBootstrapToTheLatestFloorToo', () => {
    // A client-routed turn queued before the floor rose would otherwise run on
    // the stale cheap model, which is the same downgrade by another route.
    const state: DifficultyRoutingSessionState = {
      stateVersion: ROUTING_STATE_VERSION,
      revision: 3,
      base: {
        difficulty: 'hard',
        model: 'claude-opus-5',
        effort: 'high',
        provenance: 'engine-applied',
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 7,
        appliedAt: NOW,
      },
    }
    const boot = pending({
      kind: 'local-auto-bootstrap',
      baseProvenance: 'legacy-selection',
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
    })

    expect(resolveEngineBoundaryRoute(state, boot, 'claude')?.model).toBe('claude-opus-5')
  })

  it('shouldStillLeaveAManualPinAlone', () => {
    const state: DifficultyRoutingSessionState = {
      stateVersion: ROUTING_STATE_VERSION,
      revision: 3,
      base: {
        difficulty: 'hard',
        model: 'claude-opus-5',
        effort: 'high',
        provenance: 'engine-applied',
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 7,
        appliedAt: NOW,
      },
    }

    expect(resolveEngineBoundaryRoute(state, pending({
      kind: 'manual',
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
    }), 'claude')).toBeNull()
  })
})

describe('boundary raise blocked by the queued policy (R6)', () => {
  const hardFloor: DifficultyRoutingSessionState = {
    stateVersion: ROUTING_STATE_VERSION,
    revision: 3,
    base: {
      difficulty: 'hard',
      model: 'claude-opus-5',
      effort: 'high',
      provenance: 'engine-applied',
      policyVersion: 'org-shared-difficulty-routing.v1',
      policyRevision: 7,
      appliedAt: NOW,
    },
    escalation: { hardTurns: 2, updatedAt: NOW },
  }
  const allowedLowOnly = pending({
    clientRequestId: 'low',
    selectedDifficulty: 'routine',
    selected: { model: 'claude-sonnet-5', effort: 'high' },
    base: { difficulty: 'routine', model: 'claude-sonnet-5', effort: 'high' },
    policySnapshot: { allowedSelectionKeys: ['claude:claude-sonnet-5'], defaultSelectionKey: null },
    hardTurnsIntent: 'none',
  })

  it('shouldReportTheRaiseAsPolicyBlockedRatherThanAsNothingToDo', () => {
    expect(resolveEngineBoundaryRoute(hardFloor, allowedLowOnly, 'claude')).toBeNull()
    // "null" alone is indistinguishable from "already at the floor", and the
    // commit then re-confirms a floor this turn never ran.
    expect(isFloorRaiseBlockedByPolicy(hardFloor, allowedLowOnly, 'claude')).toBe(true)
  })

  it('shouldNotReportPolicyBlockedWhenTheTurnSimplyMeetsTheFloor', () => {
    expect(isFloorRaiseBlockedByPolicy(hardFloor, pending(), 'claude')).toBe(false)
  })

  it('shouldRecordTheActualLowerRouteItRanRatherThanTheUnreachableFloor', () => {
    const state = recordPendingDecision(hardFloor, allowedLowOnly)

    const after = commitAppliedRouting(state, {
      clientRequestIds: ['low'],
      executionId: 'exec-2',
      now: NOW,
      policyBlocked: true,
    })

    // What ran is what is recorded — never a claim that the hard floor was
    // re-confirmed by a turn that the org forbade from reaching it.
    expect(after.state.base).toMatchObject({ difficulty: 'routine', model: 'claude-sonnet-5' })
    expect(after.state.base?.appliedAt).toBe(NOW)
    expect(after.applied?.decisionReasons).toContain('policy-fallback')
  })

  it('shouldMoveTheCountersWithTheLowerRouteThatActuallyRan', () => {
    const state = recordPendingDecision(hardFloor, allowedLowOnly)

    const after = commitAppliedRouting(state, {
      clientRequestIds: ['low'],
      executionId: 'exec-2',
      now: NOW,
      policyBlocked: true,
    })

    // A routine turn is not a hard turn, so the hard streak does not continue.
    expect(after.state.escalation?.hardTurns).toBe(0)
  })
})

describe('two-phase routing epoch (/clear ordering)', () => {
  it('shouldKeepAPendingDecisionAcceptedAfterTheClearWasRequested', () => {
    // User messages are serialized, so ordering at ACCEPT time is guaranteed.
    // What is not guaranteed is that the provider reset happens before the next
    // request is accepted — and that request's queued mode still runs, so its
    // receipt must survive the reset.
    let state = requestRoutingEpoch(normalizeRoutingSessionState(undefined, 'claude'), NOW)
    state = recordPendingDecision(state, pending({ clientRequestId: 'after', createdAt: NOW + 5 }))

    const reset = startRoutingEpoch(state, NOW + 10)

    expect(pendingDecision(reset, 'after')).toBeDefined()
  })

  it('shouldDropAPendingDecisionFromBeforeTheClearBecauseItsQueueEntryWasFlushed', () => {
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
      clientRequestId: 'before',
      createdAt: NOW - 5,
    }))
    state = requestRoutingEpoch(state, NOW)

    const reset = startRoutingEpoch(state, NOW + 10)

    expect(pendingDecision(reset, 'before')).toBeUndefined()
  })

  it('shouldStillClearTheFloorAndTheReceiptsAtTheActualReset', () => {
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'e1', now: NOW }).state
    state = requestRoutingEpoch(state, NOW + 1)
    state = recordPendingDecision(state, pending({ clientRequestId: 'after', createdAt: NOW + 5 }))

    const reset = startRoutingEpoch(state, NOW + 10)

    expect(reset.base).toBeUndefined()
    expect(reset.escalation).toBeUndefined()
    expect(reset.appliedRequestIds).toBeUndefined()
    expect(pendingDecision(reset, 'after')).toBeDefined()
  })

  it('shouldDropEveryPendingWhenNoClearWasEverRequested', () => {
    // A reset with no request marker cannot tell "after" from "before", so it
    // must not invent a cutoff and keep stale decisions alive.
    const state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())

    expect(startRoutingEpoch(state, NOW + 10).pending).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Third review pass: observed execution is observed execution wherever the
// classifier ran; R8 previous ACTUAL applied route across every transition.
// ---------------------------------------------------------------------------

describe('evidence follows observation, not classifier location (R2)', () => {
  it('shouldTreatALocalAutoTurnThisCliActuallyAppliedAsEngineApplied', () => {
    // The client chose the tier, but THIS process handed the settings to the
    // engine and watched it happen. Downgrading that to `legacy-selection`
    // makes Desktop ignore a floor the CLI genuinely established.
    const state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
        kind: 'local-auto-bootstrap',
      })),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    )

    expect(state.state.base?.provenance).toBe('engine-applied')
  })

  it('shouldStillCallAMigratedHistoryRecordLegacySelection', () => {
    // No apply was ever observed for this one — it is a stored selection only.
    const migrated = normalizeRoutingSessionState(
      { difficulty: 'hard', hardTurns: 1, updatedAt: NOW },
      'claude',
    )

    expect(migrated.base?.provenance).toBe('legacy-selection')
  })
})

describe('previous actual applied route (R8)', () => {
  it('shouldRecordWhatActuallyRanForAnOrdinaryAutoTurn', () => {
    const state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending()),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    ).state

    expect(state.lastAppliedRoute).toMatchObject({
      model: 'claude-opus-5',
      effort: 'high',
      difficulty: 'hard',
      kind: 'auto',
    })
  })

  it('shouldRecordTheEscalatedModelItselfNotTheBaseUnderneathIt', () => {
    // The whole point of "previous actual": during a temporary escalation the
    // base is deliberately NOT what ran, so reporting the base would describe a
    // model the conversation never saw.
    const state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
        selectedDifficulty: 'escalated',
        selected: { model: 'claude-fable-5-1', effort: 'high' },
        base: { difficulty: 'hard', model: 'claude-opus-5', effort: 'high' },
        temporaryEscalation: true,
      })),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    ).state

    expect(state.lastAppliedRoute).toMatchObject({ model: 'claude-fable-5-1', difficulty: 'escalated' })
    expect(state.base?.model).toBe('claude-opus-5')
  })

  it('shouldRecordAManualTurnToo', () => {
    const state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
        kind: 'manual',
        selected: { model: 'claude-sonnet-5', effort: 'high' },
      })),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    ).state

    expect(state.lastAppliedRoute).toMatchObject({ model: 'claude-sonnet-5', kind: 'manual' })
  })

  it('shouldRecordTheRevisedRouteWhenTheBoundaryRaisedTheTurn', () => {
    const state: DifficultyRoutingSessionState = {
      stateVersion: ROUTING_STATE_VERSION,
      revision: 1,
      base: {
        difficulty: 'hard',
        model: 'claude-opus-5',
        effort: 'high',
        provenance: 'engine-applied',
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 7,
        appliedAt: NOW,
      },
    }
    const stale = pending({
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
    })
    const revised = resolveEngineBoundaryRoute(state, stale, 'claude')!

    const after = commitAppliedRouting(recordPendingDecision(state, stale), {
      clientRequestIds: ['req-1'],
      executionId: 'exec-2',
      now: NOW,
      revised,
    }).state

    // What ran is the raise, not the stale queued model.
    expect(after.lastAppliedRoute?.model).toBe('claude-opus-5')
  })

  it('shouldForgetThePreviousRouteAtAnExplicitContextReset', () => {
    let state = commitAppliedRouting(
      recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending()),
      { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW },
    ).state
    state = requestRoutingEpoch(state, NOW + 1)

    expect(startRoutingEpoch(state, NOW + 2).lastAppliedRoute).toBeUndefined()
  })

  it('shouldLeaveThePreviousRouteUnknownForAStateThatNeverRecordedOne', () => {
    // Old state has no such field. It must read as unknown, never as a guess
    // reconstructed from the floor.
    const migrated = normalizeRoutingSessionState(
      { difficulty: 'hard', hardTurns: 1, updatedAt: NOW },
      'claude',
    )

    expect(migrated.lastAppliedRoute).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Fourth review pass: the re-escalation judgement is made when a request is
// accepted, against a streak that other executions can move before it applies.
// ---------------------------------------------------------------------------

describe('stale re-escalation judgement at the engine boundary (R4, R7)', () => {
  const hardTurn = (id: string, overrides: Partial<RoutingPendingDecision> = {}) => pending({
    clientRequestId: id,
    candidateDifficulty: 'hard',
    selectedDifficulty: 'hard',
    selected: { model: 'claude-opus-5', effort: 'high' },
    base: { difficulty: 'hard', model: 'claude-opus-5', effort: 'high' },
    hardTurnsIntent: 'increment',
    ...overrides,
  })

  function streakOf(n: number) {
    let state = normalizeRoutingSessionState(undefined, 'claude')
    for (let i = 0; i < n; i += 1) {
      state = recordPendingDecision(state, hardTurn(`seed-${i}`))
      state = commitAppliedRouting(state, {
        clientRequestIds: [`seed-${i}`], executionId: `x-${i}`, now: NOW,
      }).state
    }
    return state
  }

  it('shouldEscalateATurnWhoseStreakCrossedTheThresholdWhileItWaited', () => {
    // Classified when the streak was 0, so it chose not to escalate. By the time
    // it reaches the engine the streak is 2 and this turn makes 3 — the exact
    // condition escalation exists for. Running Opus here misses it by a turn.
    const state = recordPendingDecision(streakOf(2), hardTurn('waited'))

    const revised = resolveEngineBoundaryRoute(state, hardTurn('waited'), 'claude', NOW)

    expect(revised).toMatchObject({ model: 'claude-fable-5-1', difficulty: 'escalated' })
    expect(revised?.reasons).toContain('temporary-escalation')
  })

  it('shouldKeepTheEscalationTemporarySoTheFloorStaysWhereItWas', () => {
    // R4: the escalation is a one-turn override. If this raise moved the floor,
    // every later turn would start from the most expensive model.
    const state = recordPendingDecision(streakOf(2), hardTurn('waited'))
    const revised = resolveEngineBoundaryRoute(state, hardTurn('waited'), 'claude', NOW)!

    const after = commitAppliedRouting(state, {
      clientRequestIds: ['waited'], executionId: 'exec-e', now: NOW, revised,
    })

    expect(after.state.base).toMatchObject({ difficulty: 'hard', model: 'claude-opus-5' })
    expect(after.state.lastAppliedRoute).toMatchObject({ model: 'claude-fable-5-1', difficulty: 'escalated' })
    expect(after.state.lastEscalatedExecutionId).toBe('exec-e')
  })

  it('shouldNotEscalateBelowTheThreshold', () => {
    const state = recordPendingDecision(streakOf(1), hardTurn('waited'))

    expect(resolveEngineBoundaryRoute(state, hardTurn('waited'), 'claude', NOW)).toBeNull()
  })

  it('shouldNotEscalateATurnThatWasNotClassifiedHard', () => {
    // Mirrors the classifier's own rule: only a genuinely hard turn escalates,
    // never one that merely inherited the hard floor.
    const state = streakOf(2)
    const inherited = hardTurn('inherited', { candidateDifficulty: 'trivial' })

    expect(resolveEngineBoundaryRoute(recordPendingDecision(state, inherited), inherited, 'claude', NOW)).toBeNull()
  })

  it('shouldNotEscalateATurnThatIsAlreadyEscalated', () => {
    const already = hardTurn('already', {
      selectedDifficulty: 'escalated',
      selected: { model: 'claude-fable-5-1', effort: 'high' },
      temporaryEscalation: true,
    })

    expect(resolveEngineBoundaryRoute(recordPendingDecision(streakOf(2), already), already, 'claude', NOW)).toBeNull()
  })

  it('shouldNotEscalateIntoAModelTheTurnsOwnPolicyForbids', () => {
    const restricted = hardTurn('restricted', {
      policySnapshot: { allowedSelectionKeys: ['claude:claude-opus-5'], defaultSelectionKey: null },
    })

    expect(resolveEngineBoundaryRoute(recordPendingDecision(streakOf(2), restricted), restricted, 'claude', NOW))
      .toBeNull()
  })

  it('shouldNotEscalateAManualPin', () => {
    const manual = hardTurn('manual', { kind: 'manual' })

    expect(resolveEngineBoundaryRoute(recordPendingDecision(streakOf(2), manual), manual, 'claude', NOW)).toBeNull()
  })

  it('shouldPreferEscalationOverAPlainFloorRaiseWhenBothApply', () => {
    // A stale cheap turn behind a hard streak: raising it only to the floor
    // would still miss the escalation the streak has earned.
    const state = streakOf(2)
    const staleCheap = pending({
      clientRequestId: 'cheap',
      candidateDifficulty: 'hard',
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      hardTurnsIntent: 'increment',
    })

    expect(resolveEngineBoundaryRoute(recordPendingDecision(state, staleCheap), staleCheap, 'claude', NOW))
      .toMatchObject({ model: 'claude-fable-5-1', difficulty: 'escalated' })
  })
})

describe('receipt retention across a long epoch (AC4)', () => {
  it('shouldStillRefuseTheVeryFirstRequestAfterTenThousandMoreExecutions', () => {
    // No cap, no truncation: the first id must still be refused however many
    // executions later the replay arrives.
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    state = commitAppliedRouting(state, { clientRequestIds: ['req-1'], executionId: 'exec-1', now: NOW }).state
    // Restore a long epoch and cross the old eviction boundary once. Replaying
    // ten thousand unrelated commits makes this invariant depend on CPU load.
    state = normalizeRoutingSessionState({
      ...state,
      appliedRequestIds: ['req-1', ...Array.from({ length: 10_000 }, (_, i) => `f-${i}`)],
    }, 'claude')
    state = recordPendingDecision(state, pending({ clientRequestId: 'after-boundary' }))
    state = commitAppliedRouting(state, {
      clientRequestIds: ['after-boundary'], executionId: 'after-boundary', now: NOW + 10_001,
    }).state
    expect(state.appliedRequestIds).toHaveLength(10_002)
    const streakBefore = state.escalation?.hardTurns

    // The replay carries a NEW createdAt, exactly as a real re-send would.
    state = recordPendingDecision(state, pending({ createdAt: NOW + 20_000 }))
    const replay = commitAppliedRouting(state, {
      clientRequestIds: ['req-1'], executionId: 'late', now: NOW + 20_000,
    })

    expect(replay.applied).toBeNull()
    expect(replay.state.escalation?.hardTurns).toBe(streakBefore)
  })

  it('shouldKeepEveryReceiptRatherThanTruncatingTheLedger', () => {
    let state = normalizeRoutingSessionState(undefined, 'claude')
    for (let i = 0; i < 200; i += 1) {
      state = recordPendingDecision(state, pending({ clientRequestId: `r-${i}` }))
      state = commitAppliedRouting(state, {
        clientRequestIds: [`r-${i}`], executionId: `x-${i}`, now: NOW,
      }).state
    }

    expect(state.appliedRequestIds).toHaveLength(200)
    expect(state.appliedRequestIds?.[0]).toBe('r-0')
  })

  it('shouldNotRefuseALegitimateRequestMerelyForHavingWaitedALongTime', () => {
    let state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({
      clientRequestId: 'patient',
      createdAt: NOW - 10_000_000,
    }))
    for (let i = 0; i < 50; i += 1) {
      state = recordPendingDecision(state, pending({ clientRequestId: `n-${i}` }))
      state = commitAppliedRouting(state, {
        clientRequestIds: [`n-${i}`], executionId: `y-${i}`, now: NOW,
      }).state
    }

    expect(commitAppliedRouting(state, {
      clientRequestIds: ['patient'], executionId: 'z', now: NOW,
    }).applied).not.toBeNull()
  })
})

describe('same-tier pair correction preserves the streak intent (R7)', () => {
  const hardFloorOnNewGen: DifficultyRoutingSessionState = {
    stateVersion: ROUTING_STATE_VERSION,
    revision: 4,
    base: {
      difficulty: 'hard',
      model: 'claude-opus-5-5',
      effort: 'high',
      provenance: 'engine-applied',
      policyVersion: 'org-shared-difficulty-routing.v1',
      policyRevision: 7,
      appliedAt: NOW,
    },
    escalation: { hardTurns: 2, updatedAt: NOW },
  }

  it('shouldCorrectThePairWithoutTurningAResolutionIntoAnIncrement', () => {
    // The user said it is fixed, so the streak must end. Correcting the model
    // to the floor's current pair is a different concern and must not silently
    // convert that reset into another hard turn.
    const resolved = pending({
      clientRequestId: 'resolved',
      selectedDifficulty: 'hard',
      selected: { model: 'claude-opus-5', effort: 'high' },
      base: { difficulty: 'hard', model: 'claude-opus-5', effort: 'high' },
      hardTurnsIntent: 'reset',
    })

    const revised = resolveEngineBoundaryRoute(hardFloorOnNewGen, resolved, 'claude', NOW)
    expect(revised).toMatchObject({ model: 'claude-opus-5-5', difficulty: 'hard' })

    const after = commitAppliedRouting(recordPendingDecision(hardFloorOnNewGen, resolved), {
      clientRequestIds: ['resolved'], executionId: 'exec-1', now: NOW, revised: revised!,
    })

    expect(after.state.base?.model).toBe('claude-opus-5-5')
    expect(after.state.escalation?.hardTurns).toBe(0)
  })

  it('shouldStillIncrementWhenTheBoundaryActuallyRaisedALowerTierToHard', () => {
    const staleCheap = pending({
      clientRequestId: 'cheap',
      candidateDifficulty: 'trivial',
      selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      hardTurnsIntent: 'reset',
    })

    const revised = resolveEngineBoundaryRoute(hardFloorOnNewGen, staleCheap, 'claude', NOW)!
    const after = commitAppliedRouting(recordPendingDecision(hardFloorOnNewGen, staleCheap), {
      clientRequestIds: ['cheap'], executionId: 'exec-2', now: NOW, revised,
    })

    // It really is running as a hard turn now, so the streak reflects that.
    expect(after.state.escalation?.hardTurns).toBe(3)
  })

  it('shouldPreserveADecisionsOwnIntentForASameTierEffortOnlyDifference', () => {
    const differentEffort = pending({
      clientRequestId: 'effort',
      selectedDifficulty: 'hard',
      selected: { model: 'claude-opus-5-5', effort: 'medium' },
      base: { difficulty: 'hard', model: 'claude-opus-5-5', effort: 'medium' },
      hardTurnsIntent: 'decrement',
    })

    const revised = resolveEngineBoundaryRoute(hardFloorOnNewGen, differentEffort, 'claude', NOW)
    expect(revised).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })

    const after = commitAppliedRouting(recordPendingDecision(hardFloorOnNewGen, differentEffort), {
      clientRequestIds: ['effort'], executionId: 'exec-3', now: NOW, revised: revised!,
    })

    // decrement from 2, not an increment forced by the correction.
    expect(after.state.escalation?.hardTurns).toBe(1)
  })
})


describe('duplicate request ids within a batch', () => {
  it('records one receipt and one attempt for a replay merged into the same batch', () => {
    const state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    const applied = commitAppliedRouting(state, {
      clientRequestIds: ['req-1', 'req-1'], executionId: 'batch', now: NOW,
    })
    expect(applied.state.appliedRequestIds).toEqual(['req-1'])
    expect(applied.state.escalation?.hardTurns).toBe(1)
  })
})

describe('opaque pending request ids', () => {
  it.each(['constructor', 'toString', '__proto__'])('does not treat inherited %s as an accepted request', (id) => {
    const state = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending())
    expect(pendingDecision(state, id)).toBeUndefined()
    expect(discardPendingDecisions(state, [id], 'cancelled')).toBe(state)
    expect(commitAppliedRouting(state, { clientRequestIds: [id], executionId: 'exec', now: NOW })).toEqual({ state, applied: null })
  })
  it('restores and commits a literal __proto__ request id', () => {
    const queued = recordPendingDecision(normalizeRoutingSessionState(undefined, 'claude'), pending({ clientRequestId: '__proto__' }))
    const restored = normalizeRoutingSessionState(JSON.parse(JSON.stringify(queued)), 'claude')
    expect(Object.keys(restored.pending ?? {})).toEqual(['__proto__'])
    const result = commitAppliedRouting(restored, { clientRequestIds: ['__proto__'], executionId: 'exec', now: NOW })
    expect(result.applied?.clientRequestId).toBe('__proto__')
    expect(result.state.appliedRequestIds).toEqual(['__proto__'])
  })
})

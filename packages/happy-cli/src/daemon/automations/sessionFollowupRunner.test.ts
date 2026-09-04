import { describe, expect, it, vi } from 'vitest'
import type {
  SessionFollowupDaemon,
  SessionFollowupPayload,
  SessionFollowupTerminalCode,
} from '@slopus/happy-wire'
import {
  createSessionFollowupSyncState,
  evaluateReviewFindings,
  runSessionFollowupTick,
  type SessionFollowupRunnerInput,
  type SessionFollowupTransport,
} from './sessionFollowupRunner'

const payloadCiphertext = Buffer.from(new Uint8Array(41).fill(1)).toString('base64')
const machineKeyEnvelope = Buffer.from(new Uint8Array(105).fill(1)).toString('base64')

function action(patch: Partial<SessionFollowupDaemon> = {}): SessionFollowupDaemon {
  return {
    id: 'followup-1', projectId: 'project-1', projectWorkspaceDir: null, sessionId: 'session-1',
    machineAccountId: 'account-1', machineId: 'machine-1', revision: 1,
    generation: 2, step: 1, status: 'WAITING', totalRounds: 4, currentRound: 1,
    responseBoundarySeq: 10, lastObservedSeq: 10, pendingExpectedSeq: null,
    pendingLocalId: null, payloadVersion: 1, payloadCiphertext,
    machineKeyVersion: 3, machineKeyEnvelope,
    ...patch,
  }
}

const change = (row: SessionFollowupDaemon) => ({
  ...row, seq: '1', followupId: row.id, kind: 'UPSERT' as const,
})

function message(seq: number, content: unknown) {
  return { seq, localId: null, contentCiphertext: JSON.stringify(content) }
}

const completeReview = (reviewText: string) => [
  message(11, { role: 'agent', content: { type: 'acp', data: { type: 'message', message: reviewText } } }),
  message(12, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } }),
]

function harness(options: {
  row?: SessionFollowupDaemon
  messages?: ReturnType<typeof message>[]
  claimGate?: (body: { step: number }) => boolean
  onEvaluate?: (body: any) => unknown
} = {}) {
  const row = options.row ?? action()
  const pending = action({
    revision: row.revision + 1,
    generation: row.generation,
    step: row.step + 1,
    status: 'DELIVERY_PENDING',
    currentRound: row.currentRound,
    lastObservedSeq: 12,
    pendingExpectedSeq: 12,
    pendingLocalId: `happy-followup:${row.id}:${row.generation}:${row.currentRound + 1}`,
  })
  let claimCount = 0
  const transport: SessionFollowupTransport = {
    sync: vi.fn(async () => ({
      ok: true,
      value: { serverTime: 1, nextSeq: '1', hasMore: false, changes: [change(row)] },
    })),
    claim: vi.fn(async (body) => {
      claimCount += 1
      if (options.claimGate && !options.claimGate(body)) return { ok: false as const, error: 'already-claimed' }
      const claimedRow = body.step === pending.step ? pending : row
      return {
        ok: true as const,
        value: {
          claimToken: `claim-${claimCount}`,
          followup: { ...claimedRow, projectWorkspaceDir: '/workspace/project' },
        },
      }
    }),
    evaluate: vi.fn(async (body) => {
      const custom = options.onEvaluate?.(body)
      if (custom !== undefined) return custom as any
      return body.decision === 'CONTINUE'
        ? { ok: true as const, value: pending }
        : { ok: true as const, value: row }
    }),
    deliver: vi.fn(async () => ({ ok: true as const, value: { idempotent: false, messageSeq: 13 } })),
  }
  const input: SessionFollowupRunnerInput = {
    transport,
    decryptPayload: vi.fn(() => ({
      kind: 'existing-session-prompt', directory: '/workspace/project',
      prompt: 'Review again and return JSON.', evaluator: { kind: 'review-findings-v1' },
    } satisfies SessionFollowupPayload)),
    resolveSession: vi.fn(() => ({
      sessionId: 'session-1', directory: '/workspace/project',
      encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', live: true,
    } as const)),
    sameDirectory: vi.fn(async (left, right) => left === right),
    fetchMessages: vi.fn(async () => options.messages ?? completeReview(JSON.stringify({
      findings: [{ severity: 'medium', title: 'race' }],
    }))),
    decryptMessage: vi.fn((_binding, ciphertext) => JSON.parse(ciphertext)),
    encryptUserMessage: vi.fn(() => 'ZW5jcnlwdGVk'),
    ensureSessionRunning: vi.fn(async () => ({ ok: true })),
  }
  return { input, transport, pending }
}

describe('sessionFollowupRunner', () => {
  it('retains an incremental change cursor between daemon ticks', async () => {
    const { input, transport } = harness({
      messages: completeReview(JSON.stringify({ findings: [] })),
    })
    const state = createSessionFollowupSyncState()
    await runSessionFollowupTick(input, state)
    await runSessionFollowupTick(input, state)
    expect(transport.sync).toHaveBeenNthCalledWith(1, expect.objectContaining({ afterSeq: '0' }))
    expect(transport.sync).toHaveBeenNthCalledWith(2, expect.objectContaining({ afterSeq: '1' }))
  })

  it('does not poison retained state with a regressing change page', async () => {
    const { input, transport } = harness()
    const current = action({ revision: 5 })
    const state = { afterSeq: 5n, byId: new Map([[current.id, current]]) }
    transport.sync = vi.fn(async () => ({
      ok: true as const,
      value: {
        serverTime: 1, nextSeq: '4', hasMore: false,
        changes: [{ ...change(action({ revision: 1 })), seq: '4' }],
      },
    }))
    await runSessionFollowupTick(input, state)
    expect(state.afterSeq).toBe(5n)
    expect(state.byId.get(current.id)?.revision).toBe(5)
    expect(transport.claim).not.toHaveBeenCalled()
  })

  it('reads the single fenced JSON contract from a human-readable review response', () => {
    expect(evaluateReviewFindings([
      'Fixed the race and verified the focused tests.\n\n',
      '```json\n{"summary":"fixed","findings":[{"severity":"medium","title":"race"}]}\n```\n',
      '<saycode-complete status="completed" findings="1">Done.</saycode-complete>',
    ])).toEqual({ kind: 'continue' })
  })

  it('fails closed when text appears between a fenced contract and the completion signal', () => {
    expect(evaluateReviewFindings([
      '```json\n{"findings":[{"severity":"medium"}]}\n```\n',
      'This is the final result.\n',
      '<saycode-complete status="completed" findings="1">Done.</saycode-complete>',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('reads a single trailing raw JSON contract before the completion signal', () => {
    expect(evaluateReviewFindings([
      'Fixed the runtime guard and synchronized the documentation.\n\n',
      '{\n  "summary": "fixed",\n  "findings": [\n    { "severity": "medium", "title": "missing guard" },\n    { "severity": "low", "title": "stale docs" }\n  ]\n}\n',
      '<saycode-complete status="completed" findings="2">Done.</saycode-complete>',
    ])).toEqual({ kind: 'continue' })
  })

  it('does not mistake a completion-tag mention in the summary for the block start', () => {
    expect(evaluateReviewFindings([
      '{"findings":[{"severity":"medium"}]}\n',
      '<saycode-complete status="completed" findings="1">Validated the `<saycode-complete>` boundary.</saycode-complete>',
    ])).toEqual({ kind: 'continue' })
  })

  it('does not mistake a completion-tag mention before the raw contract for the signal', () => {
    expect(evaluateReviewFindings([
      'Reviewed the `<saycode-complete>` boundary.\n',
      '{"findings":[{"severity":"medium"}]}\n',
      '<saycode-complete status="completed" findings="1">Done.</saycode-complete>',
    ])).toEqual({ kind: 'continue' })
  })

  it.each([
    ['an omitted findings attribute', '<saycode-complete status="blocked">Blocked.</saycode-complete>'],
    ['status and tag casing with attribute whitespace', '<saycode-complete STATUS = "Completed">Done.</SAYCODE-COMPLETE>'],
  ])('accepts the Desktop completion-signal contract with %s', (_name, signal) => {
    expect(evaluateReviewFindings([
      '{"findings":[{"severity":"medium"}]}\n',
      signal,
    ])).toEqual({ kind: 'continue' })
  })

  it.each([
    ['a similarly named attribute', '<saycode-complete data-status="completed">Done.</saycode-complete>'],
    ['a later invalid duplicate status', '<saycode-complete status="completed" status="done">Done.</saycode-complete>'],
  ])('fails closed on a completion signal with %s', (_name, signal) => {
    expect(evaluateReviewFindings([
      '{"findings":[{"severity":"medium"}]}\n',
      signal,
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('fails closed when two complete raw review responses are concatenated', () => {
    expect(evaluateReviewFindings([
      '{"findings":[{"severity":"medium"}]}\n',
      '<saycode-complete status="completed" findings="1">First.</saycode-complete>\n',
      '{"findings":[]}\n',
      '<saycode-complete status="completed" findings="0">Second.</saycode-complete>',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('fails closed when content follows the first completion-signal close', () => {
    expect(evaluateReviewFindings([
      '{"findings":[{"severity":"medium"}]}\n',
      '<saycode-complete status="completed" findings="1">First.</saycode-complete>\n',
      '{"findings":[]}\n',
      '</saycode-complete>',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('fails closed when human-readable text contains multiple raw JSON contracts', () => {
    expect(evaluateReviewFindings([
      'First result:\n{"findings":[{"severity":"medium"}]}\n',
      'Final result:\n{"findings":[]}\n',
      '<saycode-complete status="completed" findings="0">Done.</saycode-complete>',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('does not extract a raw JSON contract from prose without a completion signal', () => {
    expect(evaluateReviewFindings([
      'Fixed the issue.\n{"findings":[{"severity":"medium"}]}',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('fails closed when text appears between a raw JSON contract and the completion signal', () => {
    expect(evaluateReviewFindings([
      '{"findings":[{"severity":"medium"}]}\nThis is the final result.\n',
      '<saycode-complete status="completed" findings="1">Done.</saycode-complete>',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('fails closed when a response contains multiple JSON contracts', () => {
    expect(evaluateReviewFindings([
      '```json\n{"findings":[{"severity":"medium"}]}\n```\n',
      '```json\n{"findings":[]}\n```',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('fails closed when a raw contract precedes a fenced contract', () => {
    expect(evaluateReviewFindings([
      '{"findings":[{"severity":"medium"}]}\n',
      '```json\n{"findings":[]}\n```\n',
      '<saycode-complete status="completed" findings="0">Done.</saycode-complete>',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('fails closed when an additional JSON contract fence is incomplete', () => {
    expect(evaluateReviewFindings([
      '```json\n{"findings":[{"severity":"medium"}]}\n```\n',
      '```json\n{"findings":[]}',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('does not use a stale JSON fence followed by an unstructured final segment', () => {
    expect(evaluateReviewFindings([
      'I may have found something.\n```json\n{"findings":[{"severity":"medium"}]}\n```\n',
      'After checking the code, here is my final answer: looks fine.',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' })
  })

  it('sends exactly one next-round prompt for a medium/high result', async () => {
    const { input, transport } = harness()
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'CONTINUE', observedSeq: 12,
    }))
    expect(transport.deliver).toHaveBeenCalledTimes(1)
    expect(transport.deliver).toHaveBeenCalledWith(expect.objectContaining({
      expectedSeq: 12,
      localId: 'happy-followup:followup-1:2:2',
      contentCiphertext: 'ZW5jcnlwdGVk',
    }))
    expect(input.ensureSessionRunning).toHaveBeenCalledTimes(1)
    expect((input.ensureSessionRunning as any).mock.invocationCallOrder[0])
      .toBeLessThan((transport.deliver as any).mock.invocationCallOrder[0])
  })

  it.each([
    ['low', JSON.stringify({ findings: [{ severity: 'low' }] }), 'LOW_OR_NIT_ONLY'],
    ['nit', JSON.stringify({ findings: [{ severity: 'nit' }] }), 'LOW_OR_NIT_ONLY'],
    ['clean', JSON.stringify({ findings: [] }), 'CLEAN'],
    ['missing findings', JSON.stringify({ summary: 'clean' }), 'CLEAN'],
    ['unstructured', 'looks good', 'UNSTRUCTURED'],
  ] as const)('terminates %s without delivery', async (_name, review, terminalCode) => {
    const { input, transport } = harness({ messages: completeReview(review) })
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode,
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('terminates instead of exceeding total rounds', async () => {
    const { input, transport } = harness({ row: action({ currentRound: 4, totalRounds: 4 }) })
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'ROUNDS_EXHAUSTED',
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('stops on explicit user intervention after the response boundary', async () => {
    const { input, transport } = harness({
      messages: [message(11, { role: 'user', content: { type: 'text', text: 'stop and do this instead' } })],
    })
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'USER_INTERVENTION',
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('stops on a session-protocol user envelope after the response boundary', async () => {
    const { input, transport } = harness({
      messages: [message(11, {
        role: 'session',
        content: {
          type: 'session',
          data: { id: 'event-1', time: 1, role: 'user', ev: { t: 'text', text: 'change direction' } },
        },
      })],
    })
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'USER_INTERVENTION', observedSeq: 11,
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  // 2026-09-03: Claude Code 는 백그라운드 작업 완료를 턴 중간에 `<task-notification>` 사용자 행으로
  // 기록하고, 세션 스캐너는 이를 턴을 닫지 않는 user 텍스트 envelope 로 올린다
  // (specs/midturn-task-notification-sync R2). 열린 턴 안의 user envelope 는 사용자 개입이 아니다.
  it('ignores a session-protocol user envelope inside the running turn as a task notification', async () => {
    const { input, transport } = harness({
      messages: [
        message(11, { role: 'session', content: { type: 'session', data: { id: 'e1', time: 1, role: 'agent', turn: 't1', ev: { t: 'turn-start' } } } }),
        message(12, { role: 'session', content: { type: 'session', data: { id: 'e2', time: 2, role: 'user', ev: { t: 'text', text: '<task-notification>\n<status>completed</status>\n</task-notification>' } } } }),
        message(13, { role: 'session', content: { type: 'session', data: { id: 'e3', time: 3, role: 'agent', turn: 't1', ev: { t: 'text', text: '```json\n{"findings":[{"severity":"medium"}]}\n```' } } } }),
        message(14, { role: 'session', content: { type: 'session', data: { id: 'e4', time: 4, role: 'agent', turn: 't1', ev: { t: 'turn-end', status: 'completed' } } } }),
      ],
    })
    await runSessionFollowupTick(input)
    expect(transport.evaluate).not.toHaveBeenCalledWith(expect.objectContaining({ terminalCode: 'USER_INTERVENTION' }))
    expect(transport.deliver).toHaveBeenCalledTimes(1)
  })

  it('still stops on a session-protocol user envelope after the turn has ended', async () => {
    const { input, transport } = harness({
      messages: [
        message(11, { role: 'session', content: { type: 'session', data: { id: 'e1', time: 1, role: 'agent', turn: 't1', ev: { t: 'turn-start' } } } }),
        message(12, { role: 'session', content: { type: 'session', data: { id: 'e2', time: 2, role: 'agent', turn: 't1', ev: { t: 'turn-end', status: 'completed' } } } }),
        message(13, { role: 'session', content: { type: 'session', data: { id: 'e3', time: 3, role: 'user', ev: { t: 'text', text: 'change direction' } } } }),
      ],
    })
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'USER_INTERVENTION', observedSeq: 13,
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('fails closed when the observed agent turn aborts', async () => {
    const { input, transport } = harness({
      messages: [
        message(11, { role: 'agent', content: { type: 'acp', data: { type: 'message', message: '{"findings":[{"severity":"medium"}]}' } } }),
        message(12, { role: 'agent', content: { type: 'codex', data: { type: 'turn_aborted' } } }),
      ],
    })
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'UNSTRUCTURED',
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('does not deliver when stop/generation change wins the reservation race', async () => {
    const { input, transport } = harness({
      onEvaluate: (body) => body.decision === 'CONTINUE' ? { ok: false, error: 'claim-not-found' } : undefined,
    })
    await runSessionFollowupTick(input)
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('allows only one delivery when two daemon ticks race the claim', async () => {
    let accepted = false
    const gate = (body: { step: number }) => {
      if (body.step > 1) return true
      if (accepted) return false
      accepted = true
      return true
    }
    const { input, transport } = harness({ claimGate: gate })
    await Promise.all([runSessionFollowupTick(input), runSessionFollowupTick(input)])
    expect(transport.deliver).toHaveBeenCalledTimes(1)
  })

  it('resumes from server state after daemon restart without repeating a delivered round', async () => {
    let state = action({ projectWorkspaceDir: '/workspace/project' })
    let activeClaim: { step: number; token: string } | null = null
    const deliveredLocalIds = new Set<string>()
    let deliveryCount = 0
    const transport: SessionFollowupTransport = {
      sync: vi.fn(async () => ({
        ok: true as const,
        value: { serverTime: 1, nextSeq: '1', hasMore: false, changes: [change(state)] },
      })),
      claim: vi.fn(async (body) => {
        if (body.generation !== state.generation || body.step !== state.step || activeClaim) {
          return { ok: false as const, error: 'already-claimed' }
        }
        activeClaim = { step: body.step, token: `claim-${body.step}` }
        return { ok: true as const, value: { claimToken: activeClaim.token, followup: state } }
      }),
      evaluate: vi.fn(async (body) => {
        if (!activeClaim || body.step !== activeClaim.step || body.claimToken !== activeClaim.token) {
          return { ok: false as const, error: 'claim-not-found' }
        }
        activeClaim = null
        if (body.decision === 'CONTINUE') {
          state = action({
            ...state,
            revision: state.revision + 1,
            step: state.step + 1,
            status: 'DELIVERY_PENDING',
            pendingExpectedSeq: body.observedSeq,
            pendingLocalId: `happy-followup:${state.id}:${state.generation}:${state.currentRound + 1}`,
          })
        }
        return { ok: true as const, value: state }
      }),
      deliver: vi.fn(async (body) => {
        if (!activeClaim || body.step !== activeClaim.step || body.claimToken !== activeClaim.token) {
          return { ok: false as const, error: 'claim-not-found' }
        }
        activeClaim = null
        const idempotent = deliveredLocalIds.has(body.localId)
        if (!idempotent) {
          deliveredLocalIds.add(body.localId)
          deliveryCount += 1
          state = action({
            ...state,
            revision: state.revision + 1,
            step: state.step + 1,
            status: 'WAITING',
            currentRound: state.currentRound + 1,
            responseBoundarySeq: body.expectedSeq + 1,
            lastObservedSeq: body.expectedSeq + 1,
            pendingExpectedSeq: null,
            pendingLocalId: null,
          })
        }
        return {
          ok: true as const,
          value: { idempotent, messageSeq: body.expectedSeq + 1, followup: state },
        }
      }),
    }
    const first = harness().input
    first.transport = transport
    first.fetchMessages = vi.fn(async ({ afterSeq }) => (
      afterSeq < 12
        ? completeReview(JSON.stringify({ findings: [{ severity: 'medium' }] }))
        : []
    ))

    await runSessionFollowupTick(first)
    const restarted = { ...first, fetchMessages: vi.fn(async () => []) }
    await runSessionFollowupTick(restarted)

    expect(deliveryCount).toBe(1)
    expect(deliveredLocalIds).toEqual(new Set(['happy-followup:followup-1:2:2']))
    expect(state).toEqual(expect.objectContaining({
      currentRound: 2,
      status: 'WAITING',
      responseBoundarySeq: 13,
    }))
  })

  it('refuses a different project directory before reading or sending session content', async () => {
    const { input, transport } = harness()
    input.sameDirectory = vi.fn(async (_left, right) => right !== '/workspace/other')
    input.decryptPayload = vi.fn(() => ({
      kind: 'existing-session-prompt', directory: '/workspace/other',
      prompt: 'wrong project', evaluator: { kind: 'review-findings-v1' },
    } satisfies SessionFollowupPayload))
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'TARGET_MISMATCH',
    }))
    expect(input.fetchMessages).not.toHaveBeenCalled()
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('binds to the tracked session directory alone when the project has no workspaceDir', async () => {
    // Worktree sessions run outside the project root and most projects never
    // set workspaceDir — the session's own directory is the binding that counts.
    const worktree = '/workspace/project/.aplus/worktrees/project-1/branch'
    const { input, transport, pending } = harness()
    transport.claim = vi.fn(async (body) => ({
      ok: true as const,
      value: { claimToken: 'claim', followup: body.step === pending.step ? pending : action() },
    }))
    input.decryptPayload = vi.fn(() => ({
      kind: 'existing-session-prompt', directory: worktree,
      prompt: 'Review again and return JSON.', evaluator: { kind: 'review-findings-v1' },
    } satisfies SessionFollowupPayload))
    input.resolveSession = vi.fn(() => ({
      sessionId: 'session-1', directory: worktree,
      encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', live: true,
    } as const))
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({ decision: 'CONTINUE' }))
    expect(transport.evaluate).not.toHaveBeenCalledWith(expect.objectContaining({ terminalCode: 'TARGET_MISMATCH' }))
  })

  it('fails closed when a reserved delivery cannot resume the target session', async () => {
    const { input, transport } = harness()
    input.ensureSessionRunning = vi.fn(async () => ({ ok: false, error: 'resume-failed' }))
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({ decision: 'CONTINUE' }))
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'SESSION_UNAVAILABLE', observedSeq: 12,
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('keeps a reserved delivery durable across a retryable resume failure', async () => {
    const { input, transport } = harness()
    input.ensureSessionRunning = vi.fn(async () => ({
      ok: false, error: 'server unavailable', retryable: true,
    }))

    await runSessionFollowupTick(input)

    expect(transport.evaluate).toHaveBeenCalledTimes(1)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({ decision: 'CONTINUE' }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('fails closed when an incomplete offline turn cannot resume the target session', async () => {
    const { input, transport } = harness({
      messages: [message(11, {
        role: 'agent', content: { type: 'acp', data: { type: 'message', message: 'still working' } },
      })],
    })
    input.resolveSession = vi.fn(() => ({
      sessionId: 'session-1', directory: '/workspace/project',
      encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', live: false,
    } as const))
    input.ensureSessionRunning = vi.fn(async () => ({ ok: false, error: 'resume-failed' }))

    await runSessionFollowupTick(input)

    expect(transport.evaluate).toHaveBeenCalledOnce()
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'SESSION_UNAVAILABLE', observedSeq: 11,
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('waits when an incomplete offline turn has a retryable resume failure', async () => {
    const { input, transport } = harness({
      messages: [message(11, {
        role: 'agent', content: { type: 'acp', data: { type: 'message', message: 'still working' } },
      })],
    })
    input.resolveSession = vi.fn(() => ({
      sessionId: 'session-1', directory: '/workspace/project',
      encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', live: false,
    } as const))
    input.ensureSessionRunning = vi.fn(async () => ({
      ok: false, error: 'server unavailable', retryable: true,
    }))

    await runSessionFollowupTick(input)

    expect(transport.evaluate).toHaveBeenCalledOnce()
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'WAIT', observedSeq: 11,
    }))
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('finishes a restart bootstrap that spans more than one hundred change pages', async () => {
    const { input, transport } = harness()
    let calls = 0
    transport.sync = vi.fn(async (body) => {
      const nextSeq = String(BigInt(body.afterSeq) + 1n)
      return {
        ok: true as const,
        value: {
          serverTime: 1,
          nextSeq,
          hasMore: ++calls <= 100,
          changes: [{ ...change(action()), seq: nextSeq }],
        },
      }
    })
    await runSessionFollowupTick(input)
    expect(transport.sync).toHaveBeenCalledTimes(101)
    expect(transport.claim).toHaveBeenCalled()
  })

  it('fails closed when the daemon no longer owns the target session', async () => {
    const { input, transport } = harness()
    input.resolveSession = vi.fn(() => null)
    await runSessionFollowupTick(input)
    expect(transport.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'TERMINATE', terminalCode: 'SESSION_UNAVAILABLE',
    }))
    expect(input.fetchMessages).not.toHaveBeenCalled()
    expect(transport.deliver).not.toHaveBeenCalled()
  })

  it('fails closed on malformed severities and fenced JSON parsing stays structured', () => {
    expect(evaluateReviewFindings(['```json\n{"findings":[{"severity":"high"}]}\n```']))
      .toEqual({ kind: 'continue' })
    expect(evaluateReviewFindings(['{"findings":[{"severity":"critical"}]}']))
      .toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' as SessionFollowupTerminalCode })
    expect(evaluateReviewFindings([
      '{"findings":[{"severity":"medium"}]}',
      'final response is not structured',
    ])).toEqual({ kind: 'terminate', terminalCode: 'UNSTRUCTURED' as SessionFollowupTerminalCode })
  })
})

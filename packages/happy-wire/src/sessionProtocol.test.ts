import { describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import {
  createEnvelope,
  sessionEnvelopeSchema,
  sessionEventSchema,
  type SessionEvent,
} from './sessionProtocol';

describe('session protocol schemas', () => {
  it('accepts all supported event types', () => {
    const events: SessionEvent[] = [
      { t: 'text', text: 'hello' },
      { t: 'text', text: 'thinking', thinking: true },
      { t: 'service', text: '**Service:** restarting MCP bridge' },
      {
        t: 'tool-call-start',
        call: 'call-1',
        name: 'CodexBash',
        title: 'Run `ls`',
        description: 'Run `ls -la` in the repo root',
        args: { command: 'ls -la' },
      },
      { t: 'tool-call-end', call: 'call-1' },
      // specs/20260815-chat-tool-result-image-render — a tool_result (e.g.
      // Read on a .png) carries base64 image blocks; they ride inline on the
      // same tool-call-end event that already reports the call finished.
      {
        t: 'tool-call-end',
        call: 'call-2',
        images: [{ mediaType: 'image/png', data: 'AAA' }],
      },
      // chat-tool-output-streaming Phase 3 — daemon streams stdout/stderr
      // chunks while a long-running Bash MCP call is in flight.
      { t: 'tool-call-progress', call: 'call-1', stream: 'stdout', lines: ['build started', '...'] },
      { t: 'tool-call-progress', call: 'call-1', stream: 'stderr', lines: ['warning: deprecated API'] },
      { t: 'file', ref: 'upload-1', name: 'report.txt', size: 1024, mimeType: 'text/plain' },
      {
        t: 'file',
        ref: 'upload-2',
        name: 'image.png',
        size: 2048,
        mimeType: 'image/png',
        image: { thumbhash: 'abc', width: 100, height: 80 },
      },
      { t: 'turn-start' },
      { t: 'start', title: 'Research agent' },
            { t: 'turn-end', status: 'completed' },
            { t: 'stop' },
            {
                t: 'difficulty-routing',
                result: {
                    version: 1,
                    clientRequestId: 'client-1',
                    mode: 'auto',
                    policyVersion: 'org-shared-difficulty-routing.v1',
                    policyRevision: 3,
                    model: 'claude-opus-5',
                    effort: 'high',
                    difficulty: 'hard',
                    classifierSource: 'p2-org-shared',
                    remoteStatus: 'ok',
                    classifierRevision: 'hf-commit',
                },
            },
    ];

    for (const event of events) {
      expect(sessionEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('rejects malformed events', () => {
    expect(sessionEventSchema.safeParse({ t: 'tool-call-start', call: '1' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'file', ref: 'x', name: 'x' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'file', ref: 'x', name: 'x', size: 1, image: { width: 10, height: 10 } }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'turn-end' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'turn-end', status: 'canceled' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'start', title: 1 }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'service' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'not-real' }).success).toBe(false);
    // tool-call-progress: stream restricted to stdout/stderr; lines required
    expect(sessionEventSchema.safeParse({ t: 'tool-call-progress', call: 'c1', stream: 'mixed', lines: ['x'] }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'tool-call-progress', call: 'c1', stream: 'stdout' }).success).toBe(false);
    expect(sessionEventSchema.safeParse({ t: 'tool-call-progress', stream: 'stdout', lines: ['x'] }).success).toBe(false);
  });

  it('validates envelopes that include turn/subagent', () => {
    const subagent = createId();
    const envelope = {
      id: 'msg-1',
      time: 1234,
      role: 'agent' as const,
      turn: 'turn-1',
      subagent,
      ev: { t: 'text', text: 'hello' } as const,
    };

    const parsed = sessionEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  it('rejects session role envelopes for text events', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'msg-session-1',
      role: 'session',
      ev: { t: 'text', text: 'shadow copy of user message' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects service from non-agent role', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'msg-2',
      role: 'user',
      ev: { t: 'service', text: 'internal event' },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts difficulty-routing as a session-owned event', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'difficulty-routing-1',
      time: 1234,
      role: 'session',
      ev: {
        t: 'difficulty-routing',
        result: {
          version: 1,
          clientRequestId: 'client-1',
          mode: 'auto',
          policyVersion: 'org-shared-difficulty-routing.v1',
          policyRevision: null,
          model: 'gpt-5.6-terra',
          effort: 'high',
          difficulty: 'routine',
          classifierSource: 'fallback-p1',
          remoteStatus: 'not-ready',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts the additive v2 routing fields alongside every v1 field', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'difficulty-routing-2',
      time: 1234,
      role: 'session',
      ev: {
        t: 'difficulty-routing',
        result: {
          version: 1,
          clientRequestId: 'client-1',
          mode: 'auto',
          policyVersion: 'org-shared-difficulty-routing.v1',
          policyRevision: 7,
          model: 'claude-opus-5',
          effort: 'high',
          difficulty: 'hard',
          classifierSource: 'p1-local',
          stage: 'applied',
          revision: 12,
          evidence: 'engine-applied',
          executionId: 'exec-1',
          clientRequestIds: ['client-1', 'client-2'],
          candidateDifficulty: 'trivial',
          baseRoute: { difficulty: 'hard', model: 'claude-opus-5', effort: 'high' },
          temporaryEscalation: false,
          decisionReasons: ['sticky-floor-maintained'],
          providerConfirmedModel: 'claude-opus-5',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('still accepts a v1 event that carries none of the v2 fields', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'difficulty-routing-3',
      time: 1234,
      role: 'session',
      ev: {
        t: 'difficulty-routing',
        result: {
          version: 1,
          clientRequestId: 'client-1',
          mode: 'auto',
          policyVersion: 'org-shared-difficulty-routing.v1',
          policyRevision: null,
          model: 'claude-opus-5',
          effort: 'high',
          difficulty: 'hard',
          classifierSource: 'p1-local',
        },
      },
    });

    expect(parsed.success).toBe(true);
    // A v1 event says only that a selection happened. A reader must not read an
    // absent `stage` as `applied`.
    expect((parsed as { data: { ev: { result: Record<string, unknown> } } }).data.ev.result.stage).toBeUndefined();
  });

  it('rejects a stage outside the known lifecycle rather than passing it through', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'difficulty-routing-4',
      time: 1234,
      role: 'session',
      ev: {
        t: 'difficulty-routing',
        result: {
          version: 1,
          clientRequestId: 'client-1',
          mode: 'auto',
          policyVersion: 'org-shared-difficulty-routing.v1',
          policyRevision: null,
          model: 'claude-opus-5',
          effort: 'high',
          difficulty: 'hard',
          classifierSource: 'p1-local',
          stage: 'provider-confirmed-cache-hit',
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects difficulty-routing from user or agent roles', () => {
    const event = {
      t: 'difficulty-routing',
      result: {
        version: 1,
        clientRequestId: 'client-1',
        mode: 'auto',
        policyVersion: 'org-shared-difficulty-routing.v1',
        policyRevision: 1,
        model: 'claude-opus-5',
        effort: 'high',
        difficulty: 'hard',
        classifierSource: 'p1-local',
      },
    };

    expect(sessionEnvelopeSchema.safeParse({ id: 'a', time: 1, role: 'agent', ev: event }).success).toBe(false);
    expect(sessionEnvelopeSchema.safeParse({ id: 'u', time: 1, role: 'user', ev: event }).success).toBe(false);
  });

  it('accepts lesson-candidate only as a session-owned event', () => {
    const event = {
      t: 'lesson-candidate',
      candidateId: 'cand-1',
      revision: 2,
      payloadHash: 'hash-1',
      lesson: {
        name: 'rebuild before e2e',
        trigger: 'e2e fails with missing out/',
        steps: ['run the build', 'rerun the suite'],
        scope: 'this repo',
        validation: ['npm run test:e2e'],
        reconsiderWhen: 'the build output moves',
        failureModes: [],
      },
    };

    expect(sessionEnvelopeSchema.safeParse({ id: 's', time: 1, role: 'session', ev: event }).success).toBe(true);
    expect(sessionEnvelopeSchema.safeParse({ id: 'a', time: 1, role: 'agent', ev: event }).success).toBe(false);
    expect(sessionEnvelopeSchema.safeParse({ id: 'u', time: 1, role: 'user', ev: event }).success).toBe(false);
  });

  it('accepts any lesson body the 16KB proposal limit allows', () => {
    // happy-cli refuses a proposal over 16,384 bytes as a whole; a single long
    // field inside that must still announce, or the stored candidate has no card.
    const lesson = {
      name: 'n', trigger: 't'.repeat(10_000), steps: Array.from({ length: 120 }, (_, i) => `step ${i}`), scope: 'x',
      validation: ['v'], reconsiderWhen: 'r', failureModes: [],
    };
    const ev = { t: 'lesson-candidate', candidateId: 'c', revision: 1, payloadHash: 'h', lesson };
    expect(sessionEnvelopeSchema.safeParse({ id: 's', time: 1, role: 'session', ev }).success).toBe(true);
  });

  it('rejects a lesson-candidate without the identifiers approval needs', () => {
    const lesson = {
      name: 'n', trigger: 't', steps: ['s'], scope: 'x', validation: ['v'], reconsiderWhen: 'r', failureModes: [],
    };
    const parse = (ev: Record<string, unknown>) =>
      sessionEnvelopeSchema.safeParse({ id: 's', time: 1, role: 'session', ev: { t: 'lesson-candidate', ...ev } }).success;

    expect(parse({ revision: 1, payloadHash: 'h', lesson })).toBe(false);
    expect(parse({ candidateId: 'c', payloadHash: 'h', lesson })).toBe(false);
    expect(parse({ candidateId: 'c', revision: 1, lesson })).toBe(false);
    expect(parse({ candidateId: 'c', revision: 1, payloadHash: 'h', lesson: { ...lesson, steps: [] } })).toBe(false);
  });

  it('rejects start from non-agent role', () => {
    const subagent = createId();
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'msg-3',
      role: 'user',
      subagent,
      ev: { t: 'start', title: 'Research agent' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects non-cuid subagent values', () => {
    const parsed = sessionEnvelopeSchema.safeParse({
      id: 'msg-4',
      role: 'agent',
      turn: 'turn-1',
      subagent: 'provider-tool-id',
      ev: { t: 'text', text: 'hello' },
    });

    expect(parsed.success).toBe(false);
  });
});

describe('createEnvelope', () => {
  it('creates id by default', () => {
    const envelope = createEnvelope('agent', { t: 'turn-start' });
    expect(typeof envelope.id).toBe('string');
    expect(typeof envelope.time).toBe('number');
    expect(envelope.id.length).toBeGreaterThan(0);
    expect(envelope.role).toBe('agent');
    expect(envelope.ev.t).toBe('turn-start');
  });

  it('respects explicit options', () => {
    const subagent = createId();
    const envelope = createEnvelope(
      'agent',
      { t: 'tool-call-end', call: 'call-1' },
      {
        id: 'fixed-id',
        time: 12345,
        turn: 'turn-1',
        subagent,
        codexItemId: 'item-1',
      }
    );

    expect(envelope).toEqual({
      id: 'fixed-id',
      time: 12345,
      role: 'agent',
      turn: 'turn-1',
      subagent,
      codexItemId: 'item-1',
      ev: { t: 'tool-call-end', call: 'call-1' },
    });
  });

  // specs/agent-activity-indicator Phase 22 — the launch receipt's task id is
  // the only link between a background launch and the later stop / cleanup
  // notice that names it. createEnvelope parses through the schema, so a field
  // the schema does not declare is silently dropped in transit.
  it('keeps the background task id on a tool-call-end envelope', () => {
    const envelope = createEnvelope(
      'agent',
      { t: 'tool-call-end', call: 'call-1', backgroundTaskId: 'b59ok9s5w' },
      { id: 'fixed-id', time: 12345 },
    );

    expect(envelope.ev).toEqual({
      t: 'tool-call-end',
      call: 'call-1',
      backgroundTaskId: 'b59ok9s5w',
    });
  });

  it('validates role/event compatibility', () => {
    expect(() => createEnvelope('user', { t: 'service', text: 'internal event' })).toThrow();
  });
});

describe('difficultyRouting previousApplied contract', () => {
  function resultWith(extra: Record<string, unknown>) {
    return {
      version: 1,
      clientRequestId: 'client-1',
      mode: 'auto',
      policyVersion: 'org-shared-difficulty-routing.v1',
      policyRevision: null,
      model: 'claude-opus-5',
      effort: 'high',
      difficulty: 'hard',
      classifierSource: 'p1-local',
      ...extra,
    };
  }
  const parse = (extra: Record<string, unknown>) => sessionEnvelopeSchema.safeParse({
    id: 'e', time: 1, role: 'session',
    ev: { t: 'difficulty-routing', result: resultWith(extra) },
  });

  it('accepts a previous applied route for every producing kind', () => {
    for (const kind of ['auto', 'local-auto-bootstrap', 'manual']) {
      const parsed = parse({
        previousApplied: { model: 'claude-fable-5-1', effort: 'high', difficulty: 'escalated', kind },
      });
      expect(parsed.success, kind).toBe(true);
    }
  });

  it('accepts a null effort, which is a real value for some models', () => {
    expect(parse({
      previousApplied: { model: 'claude-haiku-4-5', effort: null, difficulty: 'trivial', kind: 'auto' },
    }).success).toBe(true);
  });

  it('treats the field as optional so a producer that never recorded one still validates', () => {
    const parsed = parse({});
    expect(parsed.success).toBe(true);
    // Absent must stay absent — a reader must not receive a fabricated default.
    expect((parsed as { data: { ev: { result: Record<string, unknown> } } }).data.ev.result.previousApplied)
      .toBeUndefined();
  });

  it('rejects a partial previous applied route rather than passing it through', () => {
    // A half-populated snapshot would be read as authoritative.
    expect(parse({ previousApplied: { model: 'claude-opus-5' } }).success).toBe(false);
    expect(parse({ previousApplied: { model: 'claude-opus-5', effort: 'high', difficulty: 'hard' } }).success)
      .toBe(false);
  });

  it('rejects a kind or difficulty outside the known sets', () => {
    expect(parse({
      previousApplied: { model: 'm', effort: 'high', difficulty: 'hard', kind: 'provider-confirmed' },
    }).success).toBe(false);
    expect(parse({
      previousApplied: { model: 'm', effort: 'high', difficulty: 'catastrophic', kind: 'auto' },
    }).success).toBe(false);
  });

  it('rejects an empty model, which would read as a known-but-nameless route', () => {
    expect(parse({
      previousApplied: { model: '', effort: 'high', difficulty: 'hard', kind: 'auto' },
    }).success).toBe(false);
  });
});

/**
 * ⚠️ UNDER REVIEW — LIKELY NEEDS MORE CAREFUL DESIGN
 *
 * This session protocol is not used in production and should NOT be used in dev
 * environments either until we revisit the design. The legacy protocol
 * (role: 'user' / role: 'agent') is the active code path everywhere.
 *
 * Before investing more here, look at how pi.dev standardizes their agent
 * protocol — we may want to align with or build on that approach instead of
 * rolling our own envelope format.
 *
 * Types are kept here for reference but are frozen. Do not add new consumers.
 */

import { createId, isCuid } from '@paralleldrive/cuid2';
import * as z from 'zod';

export const sessionRoleSchema = z.enum(['user', 'agent', 'session']);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const sessionTextEventSchema = z.object({
  t: z.literal('text'),
  text: z.string(),
  thinking: z.boolean().optional(),
});

export const sessionServiceMessageEventSchema = z.object({
  t: z.literal('service'),
  text: z.string(),
});

export const sessionToolCallStartEventSchema = z.object({
  t: z.literal('tool-call-start'),
  call: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  args: z.record(z.string(), z.unknown()),
});

// specs/20260815-chat-tool-result-image-render — a tool_result (e.g. Read on
// an image file) carries base64 image blocks in its content. They ride
// inline on the same tool-call-end event that already reports the call
// finished, rather than a separate attachment-blob upload: this envelope
// stream is already the transport the client decrypts and renders text
// through, so no new upload/download/decrypt path is needed. Optional —
// existing consumers that only read `.call` are unaffected.
// specs/agent-activity-indicator Phase 22 — a background launch's tool_result
// names the detached job by an id of its own; every later report about that
// job (a stop, a previous-session cleanup notice) uses that id, never the
// tool_use id. Riding it here is what lets a client match a stop back to the
// launch it belongs to — without it a stopped task shows as running forever.
// Transport metadata, never rendered. Optional — consumers that only read
// `.call` are unaffected.
export const sessionToolCallEndEventSchema = z.object({
  t: z.literal('tool-call-end'),
  call: z.string(),
  images: z.array(z.object({ mediaType: z.string(), data: z.string() })).optional(),
  backgroundTaskId: z.string().optional(),
});

// chat-tool-output-streaming Phase 3 — daemon-emitted incremental
// stdout/stderr chunks for long-running Bash MCP tool calls. Batched and
// throttled by the daemon (e.g. flush every 200ms or 32 lines) so the wire
// stays cheap. Each line is plain text (no ANSI parsing on this layer).
export const sessionToolCallProgressEventSchema = z.object({
  t: z.literal('tool-call-progress'),
  call: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  lines: z.array(z.string()),
});

export const sessionFileEventSchema = z.object({
  t: z.literal('file'),
  ref: z.string(),
  name: z.string(),
  size: z.number(),
  mimeType: z.string().optional(),
  image: z
    .object({
      width: z.number(),
      height: z.number(),
      thumbhash: z.string(),
    })
    .optional(),
});

export const sessionTurnStartEventSchema = z.object({
  t: z.literal('turn-start'),
});

export const sessionStartEventSchema = z.object({
  t: z.literal('start'),
  title: z.string().optional(),
});

export const sessionTurnEndStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
export type SessionTurnEndStatus = z.infer<typeof sessionTurnEndStatusSchema>;

export const sessionTurnEndEventSchema = z.object({
  t: z.literal('turn-end'),
  status: sessionTurnEndStatusSchema,
});

export const sessionStopEventSchema = z.object({
  t: z.literal('stop'),
});

export const difficultyRoutingResultSchema = z.object({
  version: z.literal(1),
  clientRequestId: z.string().min(1),
  mode: z.literal('auto'),
  policyVersion: z.literal('org-shared-difficulty-routing.v1'),
  policyRevision: z.number().int().min(0).nullable(),
  model: z.string().min(1),
  effort: z.string().min(1).nullable(),
  difficulty: z.enum(['trivial', 'routine', 'hard', 'escalated']),
  classifierSource: z.enum(['p1-local', 'p2-org-shared', 'p2-local', 'fallback-p1', 'manual-legacy']),
  remoteStatus: z.enum(['ok', 'busy', 'not-ready', 'expired', 'revoked', 'unsupported', 'error']).optional(),
  classifierRevision: z.string().min(1).optional(),

  // --- additive v2 fields ---------------------------------------------------
  // Every one is optional, so a v1 producer still validates and a v1 reader
  // still sees exactly the fields it knows. An absent field means "this
  // producer did not report it", never a default: a missing `stage` in
  // particular must not be read as `applied`.

  /**
   * Where in the lifecycle this event was emitted.
   * - `selected` — a route was computed.
   * - `queued` — the request was accepted for execution.
   * - `applied` — the runner handed the setting to the execution engine. This is
   *   NOT provider confirmation, completion, a cache hit, or a cost saving.
   * - `failed` / `cancelled` — the request will not execute under this decision.
   * - `unknown` — the producer could not determine the stage.
   */
  stage: z.enum(['selected', 'queued', 'applied', 'failed', 'cancelled', 'unknown']).optional(),
  /** Monotonic within a session. A lower revision never overwrites a higher one. */
  revision: z.number().int().min(0).optional(),
  /** Strength of the evidence behind the base route, never upgraded by a reader. */
  evidence: z.enum(['engine-applied', 'legacy-selection', 'unknown']).optional(),
  /** Identifies one execution attempt; several client requests may share it. */
  executionId: z.string().min(1).optional(),
  /** Every client request merged into this execution — N inputs, one run. */
  clientRequestIds: z.array(z.string().min(1)).max(256).optional(),
  /** What the classifier said about the input alone, before the floor applied. */
  candidateDifficulty: z.enum(['trivial', 'routine', 'hard', 'escalated']).optional(),
  /** The durable floor, which is never the temporarily escalated tier. */
  baseRoute: z.object({
    difficulty: z.enum(['trivial', 'routine', 'hard', 'escalated']),
    model: z.string().min(1),
    effort: z.string().min(1).nullable(),
  }).optional(),
  /** True when `model` is a one-turn override that does not raise the floor. */
  temporaryEscalation: z.boolean().optional(),
  /** Non-content reasons for the transition. Never prompt or response text. */
  decisionReasons: z.array(z.string().min(1).max(64)).max(16).optional(),
  /**
   * Only ever set when a provider actually confirmed the model it served. It is
   * never a copy of `model` — that would manufacture confirmation the runtime
   * does not have.
   */
  providerConfirmedModel: z.string().min(1).optional(),
  /**
   * The route the previous execution ACTUALLY ran on, whatever produced it —
   * an automatic turn, a temporary escalation, a client-routed turn or a manual
   * pin. This is what makes every transition observable (R8/AC5): during a
   * temporary escalation `baseRoute` is deliberately NOT what ran, and a manual
   * turn has no base at all, so neither can stand in for it.
   *
   * Absent means unknown — a producer that never recorded one, not "the same as
   * the floor". Non-content and optional; `kind: 'manual'` never implies the
   * manual turn fed the automatic floor.
   */
  previousApplied: z.object({
    model: z.string().min(1),
    effort: z.string().min(1).nullable(),
    difficulty: z.enum(['trivial', 'routine', 'hard', 'escalated']),
    kind: z.enum(['auto', 'local-auto-bootstrap', 'manual']),
  }).optional(),
});
export type DifficultyRoutingResult = z.infer<typeof difficultyRoutingResultSchema>;

export const sessionDifficultyRoutingEventSchema = z.object({
  t: z.literal('difficulty-routing'),
  result: difficultyRoutingResultSchema,
});

export const sessionEventSchema = z.discriminatedUnion('t', [
  sessionTextEventSchema,
  sessionServiceMessageEventSchema,
  sessionToolCallStartEventSchema,
  sessionToolCallEndEventSchema,
  sessionToolCallProgressEventSchema,
  sessionFileEventSchema,
  sessionTurnStartEventSchema,
  sessionStartEventSchema,
  sessionTurnEndEventSchema,
  sessionStopEventSchema,
  sessionDifficultyRoutingEventSchema,
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEnvelopeSchema = z
  .object({
    id: z.string(),
    time: z.number(),
    role: sessionRoleSchema,
    turn: z.string().optional(),
    subagent: z
      .string()
      .refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
      })
      .optional(),
    // Underlying agent-protocol message id (e.g. Claude's `uuid` in the
    // session JSONL). Set on text-bearing envelopes so the app can let
    // users pick a precise rewind point for session fork / duplicate.
    claudeUuid: z.string().min(1).optional(),
    // Codex app-server item id for this envelope. Used as the precise
    // rollback point for Codex thread duplicate/fork-from-message.
    codexItemId: z.string().min(1).optional(),
    ev: sessionEventSchema,
  })
  .superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'service events must use role "agent"',
        path: ['role'],
      });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${envelope.ev.t} events must use role "agent"`,
        path: ['role'],
      });
    }
    if (envelope.ev.t === 'difficulty-routing' && envelope.role !== 'session') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'difficulty-routing events must use role "session"',
        path: ['role'],
      });
    }
    if (envelope.ev.t !== 'difficulty-routing' && envelope.role === 'session') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session role is reserved for session-owned events',
        path: ['role'],
      });
    }
  });

export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export type CreateEnvelopeOptions = {
  id?: string;
  time?: number;
  turn?: string;
  subagent?: string;
  claudeUuid?: string;
  codexItemId?: string;
};

export function createEnvelope(role: SessionRole, ev: SessionEvent, opts: CreateEnvelopeOptions = {}): SessionEnvelope {
  return sessionEnvelopeSchema.parse({
    id: opts.id ?? createId(),
    time: opts.time ?? Date.now(),
    role,
    ...(opts.turn ? { turn: opts.turn } : {}),
    ...(opts.subagent ? { subagent: opts.subagent } : {}),
    ...(opts.claudeUuid ? { claudeUuid: opts.claudeUuid } : {}),
    ...(opts.codexItemId ? { codexItemId: opts.codexItemId } : {}),
    ev,
  });
}

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

/**
 * `requestId` is a Core-minted handle for a turn that answers an external messenger request
 * (Saycode specs/desktop-messenger-channels). It appears on the turn boundary rather than on the
 * text events because the boundary is what says *which* work a reply belongs to; matching on
 * "the last assistant message" or on a sequence number is wrong as soon as anything else is in
 * flight. Absent for every ordinary in-app turn.
 */
export const sessionTurnStartEventSchema = z.object({
  t: z.literal('turn-start'),
  requestId: z.string().min(1).max(128).optional(),
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
  /** Same handle as the matching `turn-start`; see that schema. */
  requestId: z.string().min(1).max(128).optional(),
});

/**
 * The engine's own authoritative final answer for a turn (Saycode
 * specs/desktop-messenger-channels — R14), emitted only where the provider actually distinguishes
 * one.
 *
 * It exists because no positional rule over the text stream is sound. "All the agent's text" ships
 * the running commentary before each tool call; "the text after the last tool call" is wrong the
 * moment a model comments after its last tool and then answers separately; "the last message" is
 * somebody else's turn as soon as anything is in flight. So the evidence has to come from the
 * provider: Claude's SDK result `result` field, Codex's `agent_message` with
 * `phase: final_answer`. An engine without such a signal emits nothing here and is not advertised
 * as channel-capable, rather than guessing.
 *
 * Still only a *candidate*: Codex emits a `final_answer` phase for a mid-turn clarifying question
 * and then keeps working. What makes it deliverable is the matching `turn-end` with
 * `status: 'completed'`.
 */
export const sessionFinalAnswerEventSchema = z.object({
  t: z.literal('final-answer'),
  text: z.string(),
  requestId: z.string().min(1).max(128).optional(),
});

export const sessionChannelReadyEventSchema = z.object({
  t: z.literal('channel-ready'),
  requestId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(128),
  nonce: z.string().uuid(),
}).strict();

/**
 * A permission prompt that an external messenger surface may answer, and its withdrawal
 * (Saycode specs/desktop-messenger-channels — R9/R14).
 *
 * Identity only. No tool name, no arguments, no risk classification, no transcript. Whether the
 * prompt is a plain yes/no is decided **inside** the runtime before the event is emitted — a
 * prompt that is not gets no event at all — so the classification never has to travel.
 *
 * `kind` is the whole description a messenger gets, and it decides what the surface may offer:
 *
 * - `generic` — a yes/no the messenger may answer, one-shot, through the dedicated RPC.
 * - `desktop-only` — the prompt exists and the turn is waiting, but it is **not** a yes/no
 *   (a question to answer, a plan-mode exit, a filesystem-scope widening). The messenger shows
 *   that the turn is waiting and points at Desktop; it offers no buttons, and the dedicated RPC
 *   refuses every answer for it. Without this the turn stalled with nothing said at all (R8's
 *   approval-wait state, R9's Desktop hand-off).
 *
 * A consumer that does not recognise a kind must refuse it rather than render it as generic —
 * that is why the field exists rather than being implied by absence.
 *
 * The four identifiers are what an answer must reproduce. They are not a capability — holding
 * them proves which prompt is meant, not that the holder may answer it.
 *
 * `.strict()` is the contract: adding a field means changing this file, so the set of facts that
 * can leave the machine stays reviewable in one place.
 */
export const sessionChannelPermissionEventSchema = z.object({
  t: z.literal('channel-permission'),
  permissionId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128),
  channelRequestId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(128),
  kind: z.enum(['generic', 'desktop-only']),
  createdAt: z.number().int().nonnegative(),
}).strict();

/**
 * The prompt is no longer answerable from outside.
 *
 * Emitted on every path a prompt leaves by — answered here or in Desktop, aborted, or a session
 * reset. Without it an external surface keeps showing a live button for a prompt that is gone,
 * and the tap that follows is refused with no explanation of why.
 *
 * `reason` is bounded and carries no detail about the decision: "answered" does not say approved
 * or denied, because the messenger that asked is not necessarily the surface that answered.
 */
export const sessionChannelPermissionWithdrawnEventSchema = z.object({
  t: z.literal('channel-permission-withdrawn'),
  permissionId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128),
  channelRequestId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(128),
  reason: z.enum(['answered', 'aborted', 'reset']),
  createdAt: z.number().int().nonnegative(),
}).strict();

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
  sessionFinalAnswerEventSchema,
  sessionChannelReadyEventSchema,
  sessionChannelPermissionEventSchema,
  sessionChannelPermissionWithdrawnEventSchema,
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
    // The agent is the only thing that can know a prompt was raised. A user-role
    // `channel-permission` would be a client asserting a prompt exists, and the ids in it are
    // exactly what an answer must reproduce.
    if ((envelope.ev.t === 'channel-permission' || envelope.ev.t === 'channel-permission-withdrawn')
      && envelope.role !== 'agent') {
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

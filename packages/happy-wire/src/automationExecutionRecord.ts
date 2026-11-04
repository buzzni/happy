import { z } from 'zod';
import { AUTOMATION_CONTEXT_INPUT_MAX_BYTES, AUTOMATION_CONTEXT_REFERENCE_MAX_BYTES, automationExecutionSessionId,
  isAutomationExecutionSessionId } from './automation';
import { sessionEnvelopeSchema, type SessionEnvelope } from './sessionProtocol';

const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const eventIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Stored inside the original E2EE creation metadata, separately from mutable native IDs. */
export const automationExecutionSeedSchema = z.strictObject({
  version: z.literal(1), automationId: z.string().min(1).max(200), runId: runIdSchema,
  generation: z.number().int().positive(), revision: z.number().int().positive(),
  displaySessionId: z.string().min(1).max(200).refine(id => !isAutomationExecutionSessionId(id)),
  question: z.string().min(1).refine(text => bytes(text) <= AUTOMATION_CONTEXT_INPUT_MAX_BYTES),
  inputBytes: z.number().int().min(1).max(AUTOMATION_CONTEXT_INPUT_MAX_BYTES),
  referenceBytes: z.number().int().min(0).max(AUTOMATION_CONTEXT_REFERENCE_MAX_BYTES),
  inputSha256: sha256Schema,
  references: z.array(z.strictObject({ kind: z.literal('previous-result'), automationId: z.string().min(1).max(200),
    runId: runIdSchema, revision: z.number().int().positive(),
    bytes: z.number().int().min(1).max(AUTOMATION_CONTEXT_REFERENCE_MAX_BYTES), sha256: sha256Schema })).max(1),
  wholeContextTokens: z.literal('unknown'),
}).superRefine((value, ctx) => {
  if (value.referenceBytes !== value.references.reduce((sum, ref) => sum + ref.bytes, 0)
    || value.inputBytes < bytes(value.question) + value.referenceBytes
    || value.references.some(ref => ref.automationId !== value.automationId || ref.runId === value.runId)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid automation input provenance or byte accounting' });
  }
});
export type AutomationExecutionSeed = z.infer<typeof automationExecutionSeedSchema>;

export function automationExecutionEvidenceLocalId(runId: string, eventId: string): string {
  automationExecutionSessionId(runId);
  return `automation-evidence:${runId}:${eventIdSchema.parse(eventId)}`;
}

export type AutomationExecutionAnswer =
  | { status: 'pending' | 'failed' | 'cancelled' }
  | { status: 'unconfirmed'; reason: string }
  | { status: 'completed'; answer: string; turnId: string; sourceEventId: string };

/** Reads owned, decrypted evidence pages only; it neither grants access nor proves process quiescence. */
export function readAutomationExecutionAnswer(input: { runId: string; complete: boolean;
  messages: Array<{ seq: number; localId: string | null; content: unknown }> }): AutomationExecutionAnswer {
  if (!input.complete) return { status: 'unconfirmed', reason: 'incomplete-pages' };
  automationExecutionSessionId(input.runId);
  const unconfirmed = (reason: string): AutomationExecutionAnswer => ({ status: 'unconfirmed', reason });
  const sources = new Map<string, string>(), sequences = new Map<number, string>();
  const events: SessionEnvelope[] = [];
  for (const row of [...input.messages].sort((a, b) => a.seq - b.seq)) {
    const wrapper = z.object({ role: z.literal('session'), content: sessionEnvelopeSchema }).safeParse(row.content);
    if (!wrapper.success || !Number.isSafeInteger(row.seq) || row.seq < 1) return unconfirmed('invalid-evidence');
    const event = wrapper.data.content;
    if (!eventIdSchema.safeParse(event.id).success || event.role !== 'agent' || event.subagent || !event.turn
      || !['turn-start', 'final-answer', 'turn-end'].includes(event.ev.t)
      || row.localId !== automationExecutionEvidenceLocalId(input.runId, event.id)) return unconfirmed('invalid-evidence');
    const value = JSON.stringify(event), previous = sources.get(event.id);
    if ((previous && previous !== value) || (sequences.has(row.seq) && sequences.get(row.seq) !== event.id)) {
      return unconfirmed('conflicting-source-event');
    }
    sequences.set(row.seq, event.id);
    if (previous) continue;
    sources.set(event.id, value);
    events.push(event);
  }
  let turn: string | null = null;
  let candidate: { answer: string; sourceEventId: string } | null = null;
  let result: AutomationExecutionAnswer = { status: 'pending' };
  const closed = new Set<string>();
  for (const event of events) {
    if (event.ev.t === 'turn-start') {
      if (turn || closed.has(event.turn!)) return unconfirmed('conflicting-turn-boundary');
      turn = event.turn!; candidate = null; result = { status: 'pending' };
    } else {
      if (!turn || event.turn !== turn) return unconfirmed('unmapped-turn');
      if (event.ev.t === 'final-answer') {
        candidate = event.ev.text.trim() ? { answer: event.ev.text, sourceEventId: event.id } : null;
      } else if (event.ev.t === 'turn-end') {
        result = event.ev.status === 'completed'
          ? candidate ? { status: 'completed', ...candidate, turnId: turn } : unconfirmed('missing-final-answer')
          : { status: event.ev.status };
        closed.add(turn); turn = null;
      }
    }
  }
  return result;
}

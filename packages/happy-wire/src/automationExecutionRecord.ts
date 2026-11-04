import { z } from 'zod';
import { AUTOMATION_CONTEXT_INPUT_MAX_BYTES, AUTOMATION_CONTEXT_REFERENCE_MAX_BYTES, automationExecutionSessionId,
  isAutomationExecutionSessionId } from './automation';
import { sessionEnvelopeSchema, type SessionEnvelope } from './sessionProtocol';

const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const eventIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

const automationExecutionSeedBaseSchema = z.strictObject({
  version: z.literal(1), automationId: z.string().min(1).max(200), runId: runIdSchema,
  generation: z.number().int().positive(), revision: z.number().int().positive(),
  displaySessionId: z.string().min(1).max(200).refine((id): boolean => !isAutomationExecutionSessionId(id)),
  question: z.string().min(1).refine(text => bytes(text) <= AUTOMATION_CONTEXT_INPUT_MAX_BYTES),
  inputBytes: z.number().int().min(1).max(AUTOMATION_CONTEXT_INPUT_MAX_BYTES),
  referenceBytes: z.number().int().min(0).max(AUTOMATION_CONTEXT_REFERENCE_MAX_BYTES),
  inputSha256: sha256Schema,
  references: z.array(z.strictObject({ kind: z.literal('previous-result'), automationId: z.string().min(1).max(200),
    runId: runIdSchema, revision: z.number().int().positive(),
    bytes: z.number().int().min(1).max(AUTOMATION_CONTEXT_REFERENCE_MAX_BYTES), sha256: sha256Schema })).max(1),
  wholeContextTokens: z.literal('unknown'),
});
function validateSeed(value: Omit<z.infer<typeof automationExecutionSeedBaseSchema>, 'question'>, questionBytes: number, ctx: z.RefinementCtx) {
  if (value.referenceBytes !== value.references.reduce((sum, ref) => sum + ref.bytes, 0)
    || value.inputBytes < questionBytes + value.referenceBytes
    || value.references.some(ref => ref.automationId !== value.automationId || ref.runId === value.runId)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid automation input provenance or byte accounting' });
  }
}
/** Full authored question lives in a run-owned E2EE artifact, never the bounded signed creation envelope. */
export const automationExecutionSeedSchema = automationExecutionSeedBaseSchema.superRefine((value, ctx) => validateSeed(value, bytes(value.question), ctx));
export type AutomationExecutionSeed = z.infer<typeof automationExecutionSeedSchema>;
export const automationExecutionSeedManifestSchema = automationExecutionSeedBaseSchema.omit({ question: true }).extend({
  questionBytes: z.number().int().min(1).max(AUTOMATION_CONTEXT_INPUT_MAX_BYTES), seedSha256: sha256Schema,
}).superRefine((value, ctx) => validateSeed(value, value.questionBytes, ctx));
export type AutomationExecutionSeedManifest = z.infer<typeof automationExecutionSeedManifestSchema>;
export const automationExecutionSeedArtifactSchema = z.strictObject({ type: z.literal('automation-execution-seed'), seed: automationExecutionSeedSchema });
export function automationExecutionSeedLocalId(runId: string): string {
  automationExecutionSessionId(runId);
  return `automation-seed:${runId}`;
}

export function automationExecutionEvidenceLocalId(runId: string, eventId: string): string {
  automationExecutionSessionId(runId);
  return `automation-evidence:${runId}:${eventIdSchema.parse(eventId)}`;
}

export type AutomationExecutionAnswer =
  | { status: 'pending' | 'failed' | 'cancelled' }
  | { status: 'unconfirmed'; reason: string }
  | { status: 'completed'; answer: string; turnId: string; sourceEventId: string };

/** Validate after owner-authorized retrieval and E2EE decryption, using the original creation manifest. */
export async function readAutomationExecutionRecord(input: {
  identity: Pick<AutomationExecutionSeed, 'automationId' | 'runId' | 'generation' | 'revision' | 'displaySessionId'>;
  metadata: unknown;
  seedMessage: { seq: number; localId: string | null; content: unknown } | null;
  messages: Array<{ seq: number; localId: string | null; content: unknown }>;
  complete: boolean;
}): Promise<{ status: 'unconfirmed'; reason: string } | {
  status: 'verified'; seed: AutomationExecutionSeed; answer: AutomationExecutionAnswer;
}> {
  if (!input.complete) return { status: 'unconfirmed', reason: 'incomplete-pages' };
  const metadata = z.object({ automationExecutionSeedManifest: automationExecutionSeedManifestSchema }).safeParse(input.metadata);
  const artifact = automationExecutionSeedArtifactSchema.safeParse(input.seedMessage?.content);
  if (!metadata.success || !artifact.success || input.seedMessage?.seq !== 1
    || input.seedMessage.localId !== automationExecutionSeedLocalId(input.identity.runId)) {
    return { status: 'unconfirmed', reason: 'invalid-seed-artifact' };
  }
  const seed = artifact.data.seed, manifest = metadata.data.automationExecutionSeedManifest;
  for (const key of ['automationId', 'runId', 'generation', 'revision', 'displaySessionId'] as const) {
    if (seed[key] !== input.identity[key]) return { status: 'unconfirmed', reason: 'seed-identity-conflict' };
  }
  const { question, ...seedFields } = seed;
  const { questionBytes, seedSha256, ...manifestFields } = manifest;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(seed)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes(question) !== questionBytes || hash !== seedSha256 || JSON.stringify(seedFields) !== JSON.stringify(manifestFields)) {
    return { status: 'unconfirmed', reason: 'seed-manifest-conflict' };
  }
  return { status: 'verified', seed, answer: readAutomationExecutionAnswer({ ...input, runId: input.identity.runId }) };
}

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

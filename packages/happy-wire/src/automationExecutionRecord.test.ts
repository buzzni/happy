import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createEnvelope, type SessionEnvelope } from './sessionProtocol';
import { automationExecutionSeedSchema, automationExecutionSeedManifestSchema, automationExecutionSeedArtifactSchema,
  readAutomationExecutionAnswer, readAutomationExecutionRecord } from './automationExecutionRecord';

const seed = () => ({ version: 1, automationId: 'a1', runId: 'r1', generation: 1, revision: 1,
  displaySessionId: 'manual', question: '원래 질문', inputBytes: 100, referenceBytes: 0,
  inputSha256: 'a'.repeat(64), references: [], wholeContextTokens: 'unknown' });
const row = (seq: number, ev: SessionEnvelope['ev'], turn = 'turn-A') => {
  const envelope = createEnvelope('agent', ev, { turn });
  return { seq, localId: `automation-evidence:r1:${envelope.id}`, content: { role: 'session', content: envelope } };
};
const read = (messages: ReturnType<typeof row>[], complete = true) => readAutomationExecutionAnswer({ runId: 'r1', messages, complete });

function record() {
  const full = automationExecutionSeedSchema.parse(seed());
  const { question, ...fields } = full;
  return { identity: { automationId: 'a1', runId: 'r1', generation: 1, revision: 1, displaySessionId: 'manual' },
    metadata: { automationExecutionSeedManifest: { ...fields, questionBytes: new TextEncoder().encode(question).length,
      seedSha256: createHash('sha256').update(JSON.stringify(full)).digest('hex') } },
    seedMessage: { seq: 1, localId: 'automation-seed:r1', content: { type: 'automation-execution-seed', seed: full } },
    messages: [row(2, { t: 'turn-start' }), row(3, { t: 'final-answer', text: 'full answer' }), row(4, { t: 'turn-end', status: 'completed' })], complete: true };
}

it('verifies the immutable question and provenance before returning the full completed answer', async () => {
  const input = record();
  expect(await readAutomationExecutionRecord(input)).toMatchObject({ status: 'verified', seed: seed(), answer: { status: 'completed', answer: 'full answer' } });
  input.messages = [];
  expect(await readAutomationExecutionRecord(input)).toMatchObject({ status: 'verified', answer: { status: 'pending' } });
});

it('refuses changed question bytes, manifest fields or source identity even when individual schemas are valid', async () => {
  for (const edit of [
    (value: ReturnType<typeof record>) => { value.seedMessage.content.seed.question = 'changed question'; },
    (value: ReturnType<typeof record>) => { value.metadata.automationExecutionSeedManifest.questionBytes++; },
    (value: ReturnType<typeof record>) => { value.metadata.automationExecutionSeedManifest.inputBytes++; },
    (value: ReturnType<typeof record>) => { value.identity.revision++; },
    (value: ReturnType<typeof record>) => { value.identity.automationId = 'different-automation'; },
    (value: ReturnType<typeof record>) => { value.identity.displaySessionId = 'different-display'; },
  ]) {
    const input = record(); edit(input);
    expect(await readAutomationExecutionRecord(input)).toMatchObject({ status: 'unconfirmed' });
  }
});

it('refuses missing, malformed or misattributed seed artifacts and incomplete evidence pages', async () => {
  for (const seedMessage of [null, { ...record().seedMessage, seq: 2 }, { ...record().seedMessage, localId: 'automation-seed:r2' },
    { ...record().seedMessage, content: { ...record().seedMessage.content, assembledPrompt: 'recursive input' } }]) {
    expect(await readAutomationExecutionRecord({ ...record(), seedMessage })).toMatchObject({ status: 'unconfirmed' });
  }
  expect(await readAutomationExecutionRecord({ ...record(), complete: false })).toEqual({ status: 'unconfirmed', reason: 'incomplete-pages' });
});

it('validates the bounded authored question without claiming whole native token measurement', () => {
  expect(automationExecutionSeedSchema.parse(seed())).toEqual(seed());
  for (const changed of [{ wholeContextTokens: 32_000 }, { question: '가'.repeat(30_000) }, { inputBytes: 65_537 },
    { referenceBytes: 16_385 }, { inputBytes: 1 }, { assembledPrompt: 'recursive history' }, { displaySessionId: 'automation-run:other' }]) {
    expect(automationExecutionSeedSchema.safeParse({ ...seed(), ...changed }).success).toBe(false);
  }
});

it('validates reference provenance and exact byte accounting', () => {
  const reference = { kind: 'previous-result', automationId: 'a1', runId: 'r0', revision: 2, bytes: 20, sha256: 'b'.repeat(64) };
  const value = { ...seed(), referenceBytes: 20, references: [reference] };
  expect(automationExecutionSeedSchema.safeParse(value).success).toBe(true);
  for (const references of [[reference, reference], [{ ...reference, runId: 'r1' }], [{ ...reference, automationId: 'other' }],
    [{ ...reference, bytes: 19 }], [{ ...reference, sha256: '' }]]) {
    expect(automationExecutionSeedSchema.safeParse({ ...value, references }).success).toBe(false);
  }
});

it('keeps the raw question in a separate bounded artifact and only its digest in creation metadata', () => {
  const full = automationExecutionSeedSchema.parse(seed());
  const { question, ...fields } = full;
  const manifest = { ...fields, questionBytes: new TextEncoder().encode(question).length, seedSha256: 'c'.repeat(64) };
  expect(automationExecutionSeedManifestSchema.parse(manifest)).toEqual(manifest);
  expect(automationExecutionSeedManifestSchema.safeParse({ ...manifest, question }).success).toBe(false);
  expect(automationExecutionSeedArtifactSchema.parse({ type: 'automation-execution-seed', seed: full })).toHaveProperty('seed.question', question);
  expect(automationExecutionSeedArtifactSchema.safeParse({ type: 'automation-execution-seed', seed: { ...full, assembledPrompt: 'recursive history' } }).success).toBe(false);
});

it('requires a matching completed turn and keeps the full final answer', () => {
  const answer = 'full answer '.repeat(500);
  const events = [row(1, { t: 'turn-start' }), row(2, { t: 'final-answer', text: 'clarification' }),
    row(3, { t: 'final-answer', text: answer }), row(4, { t: 'turn-end', status: 'completed' })];
  expect(read(events.slice(0, 3))).toEqual({ status: 'pending' });
  expect(read(events)).toMatchObject({ status: 'completed', answer, turnId: 'turn-A', sourceEventId: events[2].content.content.id });
  expect(read(events.slice().reverse())).toEqual(read(events));
  expect(read(events, false)).toEqual({ status: 'unconfirmed', reason: 'incomplete-pages' });
});

it.each(['failed', 'cancelled'] as const)('does not deliver a final candidate after %s', status => {
  expect(read([row(1, { t: 'turn-start' }), row(2, { t: 'final-answer', text: 'candidate' }),
    row(3, { t: 'turn-end', status })])).toEqual({ status });
});

it('does not infer a final answer from commentary or a missing boundary', () => {
  expect(read([row(1, { t: 'turn-start' }), row(2, { t: 'turn-end', status: 'completed' })]))
    .toEqual({ status: 'unconfirmed', reason: 'missing-final-answer' });
  for (const events of [[row(1, { t: 'final-answer', text: 'no start' })],
    [row(1, { t: 'turn-start' }), row(2, { t: 'final-answer', text: 'wrong turn' }, 'turn-B')],
    [row(1, { t: 'turn-start' }), row(2, { t: 'text', text: 'commentary' })]]) {
    expect(read(events).status).toBe('unconfirmed');
  }
});

it('deduplicates identical source events but refuses conflicting redelivery', () => {
  const events = [row(1, { t: 'turn-start' }), row(2, { t: 'final-answer', text: 'answer' }), row(3, { t: 'turn-end', status: 'completed' })];
  expect(read([...events, { ...events[1], seq: 4 }])).toEqual(read(events));
  const conflict = structuredClone(events[1]);
  conflict.content.content.ev = { t: 'final-answer', text: 'changed answer' };
  expect(read([...events, { ...conflict, seq: 4 }])).toEqual({ status: 'unconfirmed', reason: 'conflicting-source-event' });
});

it('refuses another run, a subagent, malformed rows and conflicting sequence identities', () => {
  const start = row(1, { t: 'turn-start' });
  for (const invalid of [{ ...start, localId: start.localId.replace(':r1:', ':r2:') }, { ...start, seq: 0 },
    { ...start, content: { ...start.content, content: { ...start.content.content, id: '../invalid' } } },
    { ...start, content: { ...start.content, content: { ...start.content.content, subagent: start.content.content.id } } }]) {
    expect(read([invalid]).status).toBe('unconfirmed');
  }
  expect(read([start, row(1, { t: 'turn-end', status: 'completed' })]).status).toBe('unconfirmed');
});

it('does not reuse an earlier completed answer while a later turn is still pending', () => {
  expect(read([row(1, { t: 'turn-start' }), row(2, { t: 'final-answer', text: 'first' }),
    row(3, { t: 'turn-end', status: 'completed' }), row(4, { t: 'turn-start' }, 'turn-B')]))
    .toEqual({ status: 'pending' });
});

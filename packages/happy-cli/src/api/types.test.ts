import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './types';
import { applySessionModelPinTurn } from '@/utils/sessionModelPin';

describe('MessageMetaSchema', () => {
  it('preserves an explicit Saycode system prompt policy', () => {
    expect(MessageMetaSchema.parse({ saycodeSystemPromptEnabled: false }))
      .toEqual({ saycodeSystemPromptEnabled: false });
  });

  it('preserves per-block Saycode prompt overrides', () => {
    const input = {
      saycodeSystemPromptEnabled: false,
      saycodePromptBlocks: {
        agentOrchestration: false,
        coAuthoredCredit: true,
        workerDelegation: false,
      },
    };
    expect(MessageMetaSchema.parse(input)).toEqual(input);
  });
});

describe('MessageMetaSchema saycodePromptBlocks resilience', () => {
  // safeParse failure in apiSession.routeIncomingMessage does not surface an error —
  // the message stops being routed as a user message at all. An optional preference
  // field must never be able to drop the user's message.
  it('accepts null as a reset, like every other override field in this schema', () => {
    expect(MessageMetaSchema.safeParse({ saycodePromptBlocks: null }).success).toBe(true);
  });

  it('never fails the whole message on a malformed block map', () => {
    const parsed = MessageMetaSchema.safeParse({
      permissionMode: 'default',
      saycodePromptBlocks: { coAuthoredCredit: 'yes-please' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.permissionMode).toBe('default');
  });
});

describe('MessageMetaSchema modelSource', () => {
  // Clients that auto-route a Default session send a concrete model they did not
  // pin. Without this marker the CLI cannot tell that choice apart from a user
  // pin, and publishing it back as the session's active pin would freeze the
  // session on whatever the router last picked.
  it('preserves an explicit auto marker', () => {
    expect(MessageMetaSchema.parse({ model: 'claude-sonnet-5', modelSource: 'auto' }))
      .toEqual({ model: 'claude-sonnet-5', modelSource: 'auto' });
  });

  it('preserves an explicit user marker', () => {
    expect(MessageMetaSchema.parse({ modelSource: 'user' }))
      .toEqual({ modelSource: 'user' });
  });

  // Absent marker means "user pin" so that desktop/web, which never sends the
  // field, keeps working unchanged.
  it('leaves the marker undefined when the client omits it', () => {
    expect(MessageMetaSchema.parse({ model: 'claude-opus-5' }).modelSource).toBeUndefined();
  });

  // Same hazard as saycodePromptBlocks: a safeParse failure in
  // apiSession.routeIncomingMessage stops routing the message as a user message
  // entirely. An unknown marker must remain non-pinnable, never drop the turn.
  it('never fails the whole message on an unknown marker', () => {
    const parsed = MessageMetaSchema.safeParse({
      permissionMode: 'default',
      model: 'claude-opus-5',
      modelSource: 'router-v2',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.permissionMode).toBe('default');
    expect(parsed.success && parsed.data.model).toBe('claude-opus-5');
    expect(parsed.success && parsed.data.modelSource).toBe('auto');
  });
});

describe('model provenance through schema and pin publication', () => {
  it.each(['router-v2', null, 42, {}])('does not publish an unknown present marker (%j)', (modelSource) => {
    const meta = MessageMetaSchema.parse({ model: 'routed-model', effort: 'high', modelSource });
    const existing = { model: 'user-model', effort: 'low' };
    expect(applySessionModelPinTurn({
      pin: existing,
      published: existing,
      turn: { specifiesModel: true, model: meta.model!, specifiesEffort: true, effort: meta.effort!, source: meta.modelSource },
    })).toEqual({ pin: existing, patch: null });
  });

  it('still publishes legacy user choices with an omitted marker', () => {
    const meta = MessageMetaSchema.parse({ model: 'user-model' });
    expect(applySessionModelPinTurn({
      pin: {}, published: {},
      turn: { specifiesModel: true, model: meta.model!, specifiesEffort: false, source: meta.modelSource },
    }).patch).toEqual({ currentModelCode: 'user-model', currentThoughtLevelCode: null });
  });
});

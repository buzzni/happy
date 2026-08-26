import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './types';

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

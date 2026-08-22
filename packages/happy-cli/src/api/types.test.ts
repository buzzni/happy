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
      saycodePromptBlocks: { coAuthoredCredit: true, workerDelegation: false },
    };
    expect(MessageMetaSchema.parse(input)).toEqual(input);
  });
});

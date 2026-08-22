import { describe, expect, it } from 'vitest';
import {
  MessageMetaSchema,
  resolveSaycodeSystemPromptEnabled,
} from './messageMeta';

describe('Saycode system prompt message metadata', () => {
  it('accepts an explicit enabled state', () => {
    expect(MessageMetaSchema.parse({ saycodeSystemPromptEnabled: false }))
      .toEqual({ saycodeSystemPromptEnabled: false });
  });

  it('keeps legacy messages enabled when the field is absent', () => {
    expect(resolveSaycodeSystemPromptEnabled({})).toBe(true);
  });

  it('uses the explicit message value when present', () => {
    expect(resolveSaycodeSystemPromptEnabled({ saycodeSystemPromptEnabled: false })).toBe(false);
  });
});

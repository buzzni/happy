import { describe, expect, it } from 'vitest';
import {
  stripClientTurnPromptBlocks,
  stripSaycodeOwnedPromptBlocks,
  wrapClientTurnPrompt,
  wrapSaycodeOwnedPrompt,
} from './promptProvenance';

describe('Saycode-owned prompt provenance', () => {
  it('wraps a product-owned block so it can be removed later', () => {
    expect(wrapSaycodeOwnedPrompt('  PRODUCT PROMPT  ')).toBe([
      '<!-- saycode:owned-prompt -->',
      'PRODUCT PROMPT',
      '<!-- saycode:owned-prompt -->',
    ].join('\n'));
  });

  it('removes only Saycode-owned blocks and preserves user context', () => {
    expect(stripSaycodeOwnedPromptBlocks([
      'CUSTOM USER PROMPT',
      '',
      '<!-- saycode:owned-prompt -->',
      'PRODUCT PROMPT',
      '<!-- saycode:owned-prompt -->',
      '',
      'PROJECT CONTEXT',
    ].join('\n'))).toBe('CUSTOM USER PROMPT\n\nPROJECT CONTEXT');
  });

  it('removes multiple owned blocks composed around preserved context', () => {
    expect(stripSaycodeOwnedPromptBlocks([
      'CUSTOM USER PROMPT',
      '',
      wrapSaycodeOwnedPrompt('PRODUCT PROMPT A'),
      '',
      'PROJECT CONTEXT',
      '',
      wrapSaycodeOwnedPrompt('PRODUCT PROMPT B'),
      '',
      'PERSONAL MEMORY',
    ].join('\n'))).toBe([
      'CUSTOM USER PROMPT',
      'PROJECT CONTEXT',
      'PERSONAL MEMORY',
    ].join('\n\n'));
  });
});

describe('client-turn prompt provenance', () => {
  it('wraps a client-local block separately from account-owned prompts', () => {
    expect(wrapClientTurnPrompt('  DESKTOP PREVIEW PROMPT  ')).toBe([
      '<!-- saycode:client-turn-prompt -->',
      'DESKTOP PREVIEW PROMPT',
      '<!-- saycode:client-turn-prompt -->',
    ].join('\n'));
  });

  it('removes stale client-turn blocks without clearing user context', () => {
    expect(stripClientTurnPromptBlocks([
      'CUSTOM USER PROMPT',
      '',
      '<!-- saycode:client-turn-prompt -->',
      'DESKTOP PREVIEW PROMPT',
      '<!-- saycode:client-turn-prompt -->',
      '',
      'PROJECT CONTEXT',
    ].join('\n'))).toBe('CUSTOM USER PROMPT\n\nPROJECT CONTEXT');
  });
});

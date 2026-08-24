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
      '<!-- saycode:client-turn-prompt:m-d7txt3:start -->',
      'DESKTOP PREVIEW PROMPT',
      '<!-- saycode:client-turn-prompt:m-d7txt3:end -->',
    ].join('\n'));
  });

  it('removes stale client-turn blocks without clearing user context', () => {
    expect(stripClientTurnPromptBlocks([
      'CUSTOM USER PROMPT',
      '',
      wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT'),
      '',
      'PROJECT CONTEXT',
    ].join('\n'))).toBe('CUSTOM USER PROMPT\n\nPROJECT CONTEXT');
  });

  it('does not pair a marker mentioned by user context with a product block', () => {
    const wrapped = wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT')!;
    const startMarker = wrapped.split('\n')[0];
    expect(stripClientTurnPromptBlocks([
      'CUSTOM USER PROMPT',
      startMarker,
      'Treat the line above as literal documentation.',
      '',
      wrapped,
      '',
      'PROJECT CONTEXT',
    ].join('\n'))).toBe([
      'CUSTOM USER PROMPT',
      startMarker,
      'Treat the line above as literal documentation.',
      '',
      'PROJECT CONTEXT',
    ].join('\n'));
  });

  it('preserves indentation in user context surrounding a removed block', () => {
    expect(stripClientTurnPromptBlocks([
      'CUSTOM USER PROMPT  ',
      '',
      wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT'),
      '',
      '  INDENTED PROJECT CONTEXT',
    ].join('\n'))).toBe('CUSTOM USER PROMPT  \n\n  INDENTED PROJECT CONTEXT');
  });
});

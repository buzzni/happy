import { describe, expect, it } from 'vitest';
import {
  PROMPT_BLOCK_PROVENANCE,
  resolveInitialSaycodeAppendSystemPrompt,
  resolveSaycodeAppendSystemPromptForMessage,
} from './promptProvenance';

describe('prompt provenance inventory', () => {
  it('classifies every current Claude, Codex, and client-composed block', () => {
    expect(PROMPT_BLOCK_PROVENANCE).toEqual({
      'claude:title': 'always-on',
      'claude:co-authored-credit': 'saycode',
      'claude:orchestrator': 'selected-feature',
      'claude:worker-delegation': 'saycode',
      'claude:connector-guidance': 'operational',
      'claude:ax-base': 'saycode',
      'claude:ax-step-guide': 'selected-feature',
      'claude:ax-dynamic-context': 'selected-feature',
      'codex:title': 'always-on',
      'codex:connector-guidance': 'operational',
      'client:append-system-prompt': 'client-composed',
    });
  });
});

describe('resolveSaycodeAppendSystemPromptForMessage', () => {
  it('removes owned blocks without clearing user prompt state', () => {
    expect(resolveSaycodeAppendSystemPromptForMessage({
      current: [
        'CUSTOM USER PROMPT',
        '',
        '<!-- saycode:owned-prompt -->',
        'SAYCODE OPTIONS PROMPT',
        '<!-- saycode:owned-prompt -->',
      ].join('\n'),
      hasIncoming: false,
      saycodeSystemPromptEnabled: false,
    })).toBe('CUSTOM USER PROMPT');
  });

  it('keeps the legacy enabled behavior when the policy field is absent', () => {
    expect(resolveSaycodeAppendSystemPromptForMessage({
      current: '<!-- saycode:owned-prompt -->\nPRODUCT PROMPT\n<!-- saycode:owned-prompt -->',
      hasIncoming: false,
      saycodeSystemPromptEnabled: undefined,
    })).toContain('PRODUCT PROMPT');
  });
});

describe('resolveInitialSaycodeAppendSystemPrompt', () => {
  it('removes owned blocks from a recovered OFF prompt without clearing user context', () => {
    expect(resolveInitialSaycodeAppendSystemPrompt({
      appendSystemPrompt: [
        'USER PROJECT CONTEXT',
        '',
        '<!-- saycode:owned-prompt -->',
        'SAYCODE RECOVERY PROMPT',
        '<!-- saycode:owned-prompt -->',
      ].join('\n'),
      saycodeSystemPromptEnabled: false,
    })).toBe('USER PROJECT CONTEXT');
  });
});

import { describe, expect, it } from 'vitest';
import {
  PROMPT_BLOCK_PROVENANCE,
  SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS,
  isSaycodePromptBlockEnabled,
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

describe('isSaycodePromptBlockEnabled', () => {
  it('falls back to the legacy on/off value when no per-block override exists', () => {
    expect(isSaycodePromptBlockEnabled('workerDelegation', undefined, false)).toBe(false);
    expect(isSaycodePromptBlockEnabled('workerDelegation', undefined, true)).toBe(true);
    expect(isSaycodePromptBlockEnabled('workerDelegation', undefined, undefined)).toBe(true);
  });

  it('lets a per-block override win over the legacy value in either direction', () => {
    expect(isSaycodePromptBlockEnabled('coAuthoredCredit', { coAuthoredCredit: true }, false)).toBe(true);
    expect(isSaycodePromptBlockEnabled('axBase', { axBase: false }, true)).toBe(false);
  });

  it('ignores overrides for other blocks', () => {
    expect(isSaycodePromptBlockEnabled('axBase', { workerDelegation: false }, true)).toBe(true);
  });
});

describe('toggle catalog stays in sync with the provenance inventory', () => {
  // These two lists are what a settings UI reads: PROMPT_BLOCK_PROVENANCE says which
  // blocks are Saycode-owned, SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS says which of those
  // have a toggle. Drift means a block silently loses (or fakes) a user control — the
  // same doc/code mismatch that had 'claude:title' classified as toggleable.
  it('gives every Saycode-owned block exactly one toggle', () => {
    const ownedIds = Object.entries(PROMPT_BLOCK_PROVENANCE)
      .filter(([, provenance]) => provenance === 'saycode')
      .map(([id]) => id)
      .sort();
    const toggledIds = Object.values(SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS).sort();

    expect(toggledIds).toEqual(ownedIds);
  });

  it('never exposes a toggle for an always-on block', () => {
    for (const id of Object.values(SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS)) {
      expect(PROMPT_BLOCK_PROVENANCE[id]).not.toBe('always-on');
    }
  });
});

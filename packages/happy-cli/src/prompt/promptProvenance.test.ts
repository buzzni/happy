import { describe, expect, it } from 'vitest';
import { wrapClientTurnPrompt } from '@slopus/happy-wire';
import {
  PROMPT_BLOCK_PROVENANCE,
  SAYCODE_MASTER_PROMPT_PROVENANCE_IDS,
  SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS,
  isSaycodePromptBlockEnabled,
  resolveInitialSaycodeAppendSystemPrompt,
  resolveSaycodeAppendSystemPromptForMessage,
} from './promptProvenance';

describe('prompt provenance inventory', () => {
  it('classifies every current provider and client-composed block', () => {
    expect(PROMPT_BLOCK_PROVENANCE).toEqual({
      'common:agent-orchestration': 'saycode',
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
      'gemini:title': 'always-on',
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

  it('keeps an incoming client-turn block for that turn while enforcing master off', () => {
    expect(resolveSaycodeAppendSystemPromptForMessage({
      current: undefined,
      incoming: [
        'CUSTOM USER PROMPT',
        '',
        '<!-- saycode:owned-prompt -->',
        'DISABLED PRODUCT PROMPT',
        '<!-- saycode:owned-prompt -->',
        '',
        wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT'),
      ].join('\n'),
      hasIncoming: true,
      saycodeSystemPromptEnabled: false,
    })).toBe([
      'CUSTOM USER PROMPT',
      '',
      wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT'),
    ].join('\n'));
  });

  it.each([true, false])('removes a cached client-turn block under master=%s when the next client omits append prompt', (saycodeSystemPromptEnabled) => {
    expect(resolveSaycodeAppendSystemPromptForMessage({
      current: [
        'CUSTOM USER PROMPT',
        '',
        wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT'),
      ].join('\n'),
      hasIncoming: false,
      saycodeSystemPromptEnabled,
    })).toBe('CUSTOM USER PROMPT');
  });

  it('preserves user text that resembles a client-turn boundary', () => {
    const wrapped = wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT')!;
    const documentedStartMarker = wrapped.split('\n')[0];
    expect(resolveSaycodeAppendSystemPromptForMessage({
      current: [
        'CUSTOM USER PROMPT',
        documentedStartMarker,
        'Treat the line above as literal documentation.',
        '',
        wrapped,
        '',
        'PROJECT CONTEXT',
      ].join('\n'),
      hasIncoming: false,
      saycodeSystemPromptEnabled: false,
    })).toBe([
      'CUSTOM USER PROMPT',
      documentedStartMarker,
      'Treat the line above as literal documentation.',
      '',
      'PROJECT CONTEXT',
    ].join('\n'));
  });

  it('keeps a field-absent user prompt byte-for-byte when no client block is cached', () => {
    expect(resolveSaycodeAppendSystemPromptForMessage({
      current: '  USER PROJECT CONTEXT  ',
      hasIncoming: false,
      saycodeSystemPromptEnabled: true,
    })).toBe('  USER PROJECT CONTEXT  ');
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
  it('keeps default-on delegation blocks enabled when the master is off', () => {
    expect(isSaycodePromptBlockEnabled('agentOrchestration', undefined, false)).toBe(true);
    expect(isSaycodePromptBlockEnabled('workerDelegation', undefined, false)).toBe(true);
  });

  it('allows an explicit override to disable a default-on delegation block', () => {
    expect(isSaycodePromptBlockEnabled(
      'agentOrchestration',
      { agentOrchestration: false },
      true,
    )).toBe(false);
  });

  it('falls back to the legacy on/off value when no per-block override exists', () => {
    expect(isSaycodePromptBlockEnabled('coAuthoredCredit', undefined, false)).toBe(false);
    expect(isSaycodePromptBlockEnabled('coAuthoredCredit', undefined, true)).toBe(true);
    expect(isSaycodePromptBlockEnabled('coAuthoredCredit', undefined, undefined)).toBe(true);
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
  it('gives every Saycode-owned block either one toggle or an explicit master-only gate', () => {
    const ownedIds = Object.entries(PROMPT_BLOCK_PROVENANCE)
      .filter(([, provenance]) => provenance === 'saycode')
      .map(([id]) => id)
      .sort();
    const controlledIds = [
      ...Object.values(SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS),
      ...SAYCODE_MASTER_PROMPT_PROVENANCE_IDS,
    ].sort();

    expect(controlledIds).toEqual(ownedIds);
  });

  it('never exposes a toggle for an always-on block', () => {
    for (const id of Object.values(SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS)) {
      expect(PROMPT_BLOCK_PROVENANCE[id]).not.toBe('always-on');
    }
  });
});

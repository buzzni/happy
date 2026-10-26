import { describe, expect, it } from 'vitest';
import { wrapClientTurnPrompt } from '@slopus/happy-wire';
import {
  PROMPT_BLOCK_PROVENANCE,
  SAYCODE_MASTER_PROMPT_PROVENANCE_IDS,
  SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS,
  isSaycodePromptBlockEnabled,
  resolveInitialSaycodeAppendSystemPrompt,
  resolveMessagePromptBlocks,
  withoutTurnScopedBlocks,
  resolveSaycodeAppendSystemPromptForMessage,
  splitClientTurnPromptBlocks,
} from './promptProvenance';

describe('prompt provenance inventory', () => {
  it('classifies every current provider and client-composed block', () => {
    expect(PROMPT_BLOCK_PROVENANCE).toEqual({
      'common:agent-orchestration': 'saycode',
      'common:api-gateway': 'saycode',
      'common:next-steps': 'saycode',
      'claude:title': 'always-on',
      'claude:co-authored-credit': 'saycode',
      'claude:orchestrator': 'selected-feature',
      'claude:worker-delegation': 'saycode',
      'claude:connector-guidance': 'saycode',
      'claude:ax-base': 'saycode',
      'claude:ax-step-guide': 'selected-feature',
      'claude:ax-dynamic-context': 'selected-feature',
      'codex:title': 'always-on',
      'codex:connector-guidance': 'saycode',
      'common:checkpoint-guidance': 'saycode',
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

describe('splitClientTurnPromptBlocks', () => {
  it('separates this turn\'s client blocks from the context that stays for the thread', () => {
    const preview = wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT')!;
    const guide = wrapClientTurnPrompt('DESKTOP GUIDE PROMPT')!;
    expect(splitClientTurnPromptBlocks(['USER CONTEXT', '', preview, '', 'PROJECT CONTEXT', '', guide].join('\n'))).toEqual({
      standing: 'USER CONTEXT\n\nPROJECT CONTEXT',
      turn: `${preview}\n\n${guide}`,
    });
  });

  it('leaves marker-like user text in the standing context', () => {
    const wrapped = wrapClientTurnPrompt('DESKTOP PREVIEW PROMPT')!;
    const forged = `${wrapped.split('\n')[0]}\nNOT A REAL BLOCK\n${wrapped.split('\n')[2]}`;
    expect(splitClientTurnPromptBlocks(`USER CONTEXT\n${forged}`)).toEqual({ standing: `USER CONTEXT\n${forged}`, turn: undefined });
  });

  it('has no turn part without a client block', () => {
    expect(splitClientTurnPromptBlocks('USER CONTEXT')).toEqual({ standing: 'USER CONTEXT', turn: undefined });
    expect(splitClientTurnPromptBlocks(undefined)).toEqual({ standing: undefined, turn: undefined });
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

// specs/saycode-security-hardening D1 — Saycode prompts are all on or all off.
describe('isSaycodePromptBlockEnabled', () => {
  const blocks = ['agentOrchestration', 'workerDelegation', 'coAuthoredCredit', 'axBase'] as const;

  it('turns every Saycode block off when the master is off, delegation included', () => {
    for (const block of blocks) expect(isSaycodePromptBlockEnabled(block, undefined, false)).toBe(false);
  });

  it('turns every Saycode block on when the master is on or absent', () => {
    for (const block of blocks) {
      expect(isSaycodePromptBlockEnabled(block, undefined, true)).toBe(true);
      expect(isSaycodePromptBlockEnabled(block, undefined, undefined)).toBe(true);
    }
  });

  it('ignores per-block overrides an older client still sends', () => {
    expect(isSaycodePromptBlockEnabled('agentOrchestration', { agentOrchestration: true }, false)).toBe(false);
    expect(isSaycodePromptBlockEnabled('coAuthoredCredit', { coAuthoredCredit: true }, false)).toBe(false);
    expect(isSaycodePromptBlockEnabled('axBase', { axBase: false }, true)).toBe(true);
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

// specs/desktop-next-steps-card — `nextSteps` is "this turn's client draws the card".
describe('nextSteps turn-card block', () => {
  it('is off unless the turn asks for it, and the master switch still wins', () => {
    expect(isSaycodePromptBlockEnabled('nextSteps', undefined, undefined)).toBe(false);
    expect(isSaycodePromptBlockEnabled('nextSteps', {}, true)).toBe(false);
    expect(isSaycodePromptBlockEnabled('nextSteps', { nextSteps: true }, undefined)).toBe(true);
    expect(isSaycodePromptBlockEnabled('nextSteps', { nextSteps: true }, false)).toBe(false);
  });

  it('holds for its own message only: a later client that omits the field (mobile app) gets no card', () => {
    const desktop = resolveMessagePromptBlocks({ axBase: false }, { saycodePromptBlocks: { axBase: false, nextSteps: true } });
    expect(desktop.turn).toEqual({ axBase: false, nextSteps: true });
    expect(desktop.standing).toEqual({ axBase: false });

    const mobile = resolveMessagePromptBlocks(desktop.standing, {});
    expect(mobile.turn).toEqual({ axBase: false });
    expect(isSaycodePromptBlockEnabled('nextSteps', mobile.turn, true)).toBe(false);
  });

  it('an older client that never sends the key gets no card (old Desktop, Slack channel)', () => {
    const turn = resolveMessagePromptBlocks(undefined, { saycodePromptBlocks: { agentOrchestration: true } });
    expect(turn.turn).toEqual({ agentOrchestration: true });
    expect(isSaycodePromptBlockEnabled('nextSteps', turn.turn, true)).toBe(false);
  });

  it('a message that carries only nextSteps leaves the standing overrides as they were', () => {
    const turn = resolveMessagePromptBlocks({ coAuthoredCredit: false }, { saycodePromptBlocks: { nextSteps: true } });
    expect(turn.standing).toEqual({ coAuthoredCredit: false });
    expect(turn.turn).toEqual({ coAuthoredCredit: false, nextSteps: true });
  });

  it('keeps the old reset and replace rules for the other overrides', () => {
    expect(resolveMessagePromptBlocks({ axBase: false }, { saycodePromptBlocks: null }).standing).toBeUndefined();
    expect(resolveMessagePromptBlocks({ axBase: false }, { saycodePromptBlocks: { workerDelegation: false, nextSteps: false } }))
      .toEqual({ standing: { workerDelegation: false }, turn: { workerDelegation: false } });
  });

  it('never lets a standing value (initial env, cache) carry the turn-scoped key', () => {
    expect(withoutTurnScopedBlocks({ axBase: true, nextSteps: true })).toEqual({ axBase: true });
    expect(resolveMessagePromptBlocks({ nextSteps: true }, undefined).turn).toEqual({});
  });
});

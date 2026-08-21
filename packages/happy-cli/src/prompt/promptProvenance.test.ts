import { describe, expect, it } from 'vitest';
import { PROMPT_BLOCK_PROVENANCE } from './promptProvenance';

describe('prompt provenance inventory', () => {
  it('classifies every current Claude, Codex, and client-composed block', () => {
    expect(PROMPT_BLOCK_PROVENANCE).toEqual({
      'claude:title': 'saycode',
      'claude:co-authored-credit': 'saycode',
      'claude:orchestrator': 'selected-feature',
      'claude:worker-delegation': 'saycode',
      'claude:connector-guidance': 'operational',
      'claude:ax-base': 'saycode',
      'claude:ax-step-guide': 'selected-feature',
      'claude:ax-dynamic-context': 'selected-feature',
      'codex:title': 'saycode',
      'codex:connector-guidance': 'operational',
      'client:append-system-prompt': 'client-composed',
    });
  });
});

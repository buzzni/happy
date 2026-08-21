import { describe, expect, it } from 'vitest';
import { buildClaudeSystemPromptOptions } from './claudePrompt';

describe('buildClaudeSystemPromptOptions', () => {
  const input = {
    customSystemPrompt: 'USER CUSTOM',
    appendSystemPrompt: 'CLIENT APPEND',
    saycodeSystemPrompt: 'SAYCODE BASE',
    orchestratorPrompt: 'ORCHESTRATOR',
    workerDelegationPrompt: 'WORKER DELEGATION',
    connectorGuidance: 'CONNECTOR FACTS',
  };

  it('preserves the legacy prompt byte-for-byte when enabled or absent', () => {
    const expected = {
      customSystemPrompt: 'USER CUSTOM\n\nSAYCODE BASE',
      appendSystemPrompt: 'CLIENT APPEND\n\nSAYCODE BASE\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS',
    };

    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: true })).toEqual(expected);
    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: undefined })).toEqual(expected);
  });

  it('removes only Saycode-owned blocks when disabled', () => {
    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: false })).toEqual({
      customSystemPrompt: 'USER CUSTOM',
      appendSystemPrompt: 'CLIENT APPEND\n\nORCHESTRATOR\n\nCONNECTOR FACTS',
    });
  });
});

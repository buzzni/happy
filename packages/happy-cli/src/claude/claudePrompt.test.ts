import { describe, expect, it } from 'vitest';
import { buildClaudeSystemPromptOptions } from './claudePrompt';

describe('buildClaudeSystemPromptOptions', () => {
  const input = {
    customSystemPrompt: 'USER CUSTOM',
    appendSystemPrompt: 'CLIENT APPEND',
    chatTitlePrompt: 'CHAT TITLE',
    saycodeSystemPrompt: 'SAYCODE BASE',
    agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
    orchestratorPrompt: 'ORCHESTRATOR',
    workerDelegationPrompt: 'WORKER DELEGATION',
    connectorGuidance: 'CONNECTOR FACTS',
  };

  it('preserves the legacy prompt byte-for-byte when enabled or absent', () => {
    const expected = {
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE\n\nSAYCODE BASE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nSAYCODE BASE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS',
    };

    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: true })).toEqual(expected);
    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: undefined })).toEqual(expected);
  });

  it('removes only Saycode-owned blocks when disabled, keeping the chat title instruction', () => {
    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: false })).toEqual({
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS',
    });
  });
});

describe('buildClaudeSystemPromptOptions with per-block overrides', () => {
  const input = {
    customSystemPrompt: 'USER CUSTOM',
    appendSystemPrompt: 'CLIENT APPEND',
    chatTitlePrompt: 'CHAT TITLE',
    saycodeSystemPrompt: 'SAYCODE BASE',
    agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
    orchestratorPrompt: 'ORCHESTRATOR',
    workerDelegationPrompt: 'WORKER DELEGATION',
    connectorGuidance: 'CONNECTOR FACTS',
  };

  it('keeps only the overridden-on block when the legacy value is off', () => {
    expect(buildClaudeSystemPromptOptions({
      ...input,
      saycodeSystemPromptEnabled: false,
      saycodePromptBlocks: { coAuthoredCredit: true },
    })).toEqual({
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE\n\nSAYCODE BASE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nSAYCODE BASE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS',
    });
  });

  it('removes child-session routing only when its block is explicitly off', () => {
    expect(buildClaudeSystemPromptOptions({
      ...input,
      saycodeSystemPromptEnabled: false,
      saycodePromptBlocks: { agentOrchestration: false },
    }).appendSystemPrompt).toBe(
      'CLIENT APPEND\n\nCHAT TITLE\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS',
    );
  });

  it('drops only the overridden-off block when the legacy value is on', () => {
    expect(buildClaudeSystemPromptOptions({
      ...input,
      saycodeSystemPromptEnabled: true,
      saycodePromptBlocks: { workerDelegation: false },
    })).toEqual({
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE\n\nSAYCODE BASE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nSAYCODE BASE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nCONNECTOR FACTS',
    });
  });
});

import { SAYCODE_API_GATEWAY_PROMPT } from '@/prompt/saycodeApiGatewayPrompt';
import { NEXT_STEPS_PROMPT } from '@/prompt/nextStepsPrompt';
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

  it('preserves existing blocks and adds gateway guidance when enabled or absent', () => {
    const expected = {
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE\n\nSAYCODE BASE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nSAYCODE BASE\n\nAGENT ORCHESTRATION: happy agent spawn\n\nORCHESTRATOR\n\nWORKER DELEGATION\n\nCONNECTOR FACTS' + '\n\n' + SAYCODE_API_GATEWAY_PROMPT,
    };

    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: true })).toEqual(expected);
    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: undefined })).toEqual(expected);
  });

  it('keeps only the chat title and the user-selected orchestrator when disabled', () => {
    expect(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: false })).toEqual({
      customSystemPrompt: 'USER CUSTOM\n\nCHAT TITLE',
      appendSystemPrompt: 'CLIENT APPEND\n\nCHAT TITLE\n\nORCHESTRATOR',
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

  it('lets the master switch alone decide, whatever an older client overrides', () => {
    expect(buildClaudeSystemPromptOptions({
      ...input,
      saycodeSystemPromptEnabled: false,
      saycodePromptBlocks: { coAuthoredCredit: true, agentOrchestration: true, workerDelegation: true },
    })).toEqual(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: false }));
    expect(buildClaudeSystemPromptOptions({
      ...input,
      saycodeSystemPromptEnabled: true,
      saycodePromptBlocks: { workerDelegation: false, agentOrchestration: false },
    })).toEqual(buildClaudeSystemPromptOptions({ ...input, saycodeSystemPromptEnabled: true }));
  });
});


describe('Saycode API gateway system guidance', () => {
  it.each([true, undefined])('discovers API suffixes through system instructions (master=%s)', (enabled) => {
    const result = buildClaudeSystemPromptOptions({
      saycodeSystemPrompt: '', appendSystemPrompt: 'PROJECT API CONTRACT',
      saycodeSystemPromptEnabled: enabled,
    });
    expect(result.appendSystemPrompt).toContain('{NAME}_SAYCODE_API_URL');
    expect(result.appendSystemPrompt).toContain('registered API contract');
    expect(result.appendSystemPrompt).toContain('PROJECT API CONTRACT');
    expect(result.appendSystemPrompt?.match(/<saycode-api-gateway>/g)).toHaveLength(1);
  });

  it('respects master OFF without losing project context', () => {
    expect(buildClaudeSystemPromptOptions({
      saycodeSystemPrompt: '', appendSystemPrompt: 'PROJECT API CONTRACT',
      saycodeSystemPromptEnabled: false,
    }).appendSystemPrompt).toBe('PROJECT API CONTRACT');
  });
});


it('includes active checkpoint facts with client instructions and leaves inactive guidance absent', () => {
  const active = buildClaudeSystemPromptOptions({ saycodeSystemPrompt: '', appendSystemPrompt: 'USER CONTEXT', checkpointGuidance: 'ACTIVE CHECKPOINT FACTS' });
  expect(active.appendSystemPrompt).toContain('ACTIVE CHECKPOINT FACTS'); expect(active.appendSystemPrompt).toContain('USER CONTEXT');
  const custom = buildClaudeSystemPromptOptions({ saycodeSystemPrompt: '', customSystemPrompt: 'USER CUSTOM', checkpointGuidance: 'ACTIVE CHECKPOINT FACTS' });
  expect(custom.customSystemPrompt).toBe('USER CUSTOM\n\nACTIVE CHECKPOINT FACTS');
  expect(buildClaudeSystemPromptOptions({ saycodeSystemPrompt: '', checkpointGuidance: '' }).appendSystemPrompt).not.toContain('CHECKPOINT');
  expect(buildClaudeSystemPromptOptions({ saycodeSystemPrompt: '', appendSystemPrompt: 'USER CONTEXT', checkpointGuidance: 'ACTIVE CHECKPOINT FACTS', saycodeSystemPromptEnabled: false }).appendSystemPrompt).toBe('USER CONTEXT');
});

describe('next-steps card guidance', () => {
  const build = (extra: Partial<Parameters<typeof buildClaudeSystemPromptOptions>[0]>) =>
    buildClaudeSystemPromptOptions({ saycodeSystemPrompt: '', appendSystemPrompt: 'USER', nextStepsPrompt: NEXT_STEPS_PROMPT, ...extra }).appendSystemPrompt;

  it('rides only on a turn whose client draws the card, under the master switch', () => {
    expect(build({ saycodePromptBlocks: { nextSteps: true } })).toContain('mcp__happy__next_steps');
    expect(build({ saycodePromptBlocks: { nextSteps: true } })).not.toContain('update_plan');
    // Older Desktop, mobile app, channel turn: no block, so the model keeps its question in the body.
    expect(build({})).not.toContain('next_steps');
    expect(build({ saycodePromptBlocks: { nextSteps: true }, saycodeSystemPromptEnabled: false })).toBe('USER');
  });
});

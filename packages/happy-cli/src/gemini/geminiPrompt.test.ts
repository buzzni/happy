import { describe, expect, it } from 'vitest';

import { CHANGE_TITLE_INSTRUCTION } from './constants';
import { buildGeminiTurnPrompt, hashGeminiMode } from './geminiPrompt';

describe('buildGeminiTurnPrompt', () => {
  it('keeps the chat title instruction on every new session', () => {
    const prompt = buildGeminiTurnPrompt({
      userText: 'inspect the repository',
      appendSystemPrompt: 'CUSTOM USER PROMPT',
      isNewSession: true,
    });

    expect(prompt).toContain('CUSTOM USER PROMPT');
    expect(prompt).toContain('inspect the repository');
    expect(prompt).toContain('happy__change_title');
  });

  it('preserves the legacy title instruction', () => {
    const prompt = buildGeminiTurnPrompt({
      userText: 'inspect the repository',
      appendSystemPrompt: 'CLIENT APPEND',
      isNewSession: true,
    });

    expect(prompt).toContain('CLIENT APPEND');
    expect(prompt).toContain('inspect the repository');
    expect(prompt).toContain('happy__change_title');
  });

  it('keeps the chat title instruction when no append prompt exists', () => {
    expect(buildGeminiTurnPrompt({
      userText: 'plain first turn',
      isNewSession: true,
    })).toBe(`plain first turn\n\n${CHANGE_TITLE_INSTRUCTION}`);
  });

  it('does not repeat session instructions on a continuing ACP session', () => {
    expect(buildGeminiTurnPrompt({
      userText: 'continue',
      appendSystemPrompt: 'CLIENT APPEND',
      isNewSession: false,
    })).toBe('continue');
  });

  it('keeps child-session orchestration on when the master is off unless its block is explicitly off', () => {
    const base = {
      userText: 'delegate this',
      agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
      saycodeSystemPromptEnabled: false,
      isNewSession: true,
    };

    expect(buildGeminiTurnPrompt(base)).toContain('happy agent spawn');
    expect(buildGeminiTurnPrompt({
      ...base,
      saycodePromptBlocks: { agentOrchestration: false },
    })).not.toContain('happy agent spawn');
  });

  it('places prior conversation between client context and the current user turn', () => {
    const prompt = buildGeminiTurnPrompt({
      userText: 'current turn',
      appendSystemPrompt: 'CLIENT APPEND',
      previousConversationContext: '[PREVIOUS]\nUser: earlier turn\n[/PREVIOUS]\n',
      isNewSession: true,
    });

    expect(prompt).toBe(
      `CLIENT APPEND\n\n[PREVIOUS]\nUser: earlier turn\n[/PREVIOUS]\n\ncurrent turn\n\n${CHANGE_TITLE_INSTRUCTION}`,
    );
    expect(prompt.match(/current turn/g)).toHaveLength(1);
  });
});

describe('hashGeminiMode', () => {
  const base = {
    permissionMode: 'default' as const,
    model: 'gemini-2.5-pro',
    saycodePromptBlocks: undefined,
  };

  it('restarts the ACP session when effective client context changes', () => {
    const enabled = hashGeminiMode({ ...base, appendSystemPrompt: 'A', saycodeSystemPromptEnabled: true });

    expect(hashGeminiMode({ ...base, appendSystemPrompt: 'B', saycodeSystemPromptEnabled: true }))
      .not.toBe(enabled);
  });

  it('does not restart when only the unrelated master switch changes', () => {
    expect(hashGeminiMode({ ...base, appendSystemPrompt: 'A', saycodeSystemPromptEnabled: true }))
      .toBe(hashGeminiMode({ ...base, appendSystemPrompt: 'A', saycodeSystemPromptEnabled: false }));
  });

  it('treats an absent policy as the legacy enabled policy', () => {
    expect(hashGeminiMode({ ...base, appendSystemPrompt: 'A' }))
      .toBe(hashGeminiMode({ ...base, appendSystemPrompt: 'A', saycodeSystemPromptEnabled: true }));
  });

  it('restarts the ACP session when child orchestration is explicitly toggled', () => {
    expect(hashGeminiMode({ ...base, saycodePromptBlocks: { agentOrchestration: true } }))
      .not.toBe(hashGeminiMode({ ...base, saycodePromptBlocks: { agentOrchestration: false } }));
  });

  it('does not restart for an explicit value equal to the default-on orchestration policy', () => {
    expect(hashGeminiMode(base))
      .toBe(hashGeminiMode({ ...base, saycodePromptBlocks: { agentOrchestration: true } }));
  });
});

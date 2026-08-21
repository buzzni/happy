import { describe, expect, it } from 'vitest';

import { buildGeminiTurnPrompt, hashGeminiMode } from './geminiPrompt';

describe('buildGeminiTurnPrompt', () => {
  it('keeps client-owned context but omits the Saycode title instruction when disabled', () => {
    const prompt = buildGeminiTurnPrompt({
      userText: 'inspect the repository',
      appendSystemPrompt: 'CUSTOM USER PROMPT',
      saycodeSystemPromptEnabled: false,
      isNewSession: true,
    });

    expect(prompt).toContain('CUSTOM USER PROMPT');
    expect(prompt).toContain('inspect the repository');
    expect(prompt).not.toContain('change_title');
    expect(prompt).not.toContain('happy__change_title');
  });

  it.each([true, undefined])('preserves the legacy title instruction when enabled is %s', (enabled) => {
    const prompt = buildGeminiTurnPrompt({
      userText: 'inspect the repository',
      appendSystemPrompt: 'CLIENT APPEND',
      saycodeSystemPromptEnabled: enabled,
      isNewSession: true,
    });

    expect(prompt).toContain('CLIENT APPEND');
    expect(prompt).toContain('inspect the repository');
    expect(prompt).toContain('happy__change_title');
  });

  it('preserves the legacy plain first turn when no append prompt exists', () => {
    expect(buildGeminiTurnPrompt({
      userText: 'plain first turn',
      saycodeSystemPromptEnabled: true,
      isNewSession: true,
    })).toBe('plain first turn');
  });

  it('does not repeat session instructions on a continuing ACP session', () => {
    expect(buildGeminiTurnPrompt({
      userText: 'continue',
      appendSystemPrompt: 'CLIENT APPEND',
      saycodeSystemPromptEnabled: true,
      isNewSession: false,
    })).toBe('continue');
  });

  it('places prior conversation between client context and the current user turn', () => {
    const prompt = buildGeminiTurnPrompt({
      userText: 'current turn',
      appendSystemPrompt: 'CLIENT APPEND',
      previousConversationContext: '[PREVIOUS]\nUser: earlier turn\n[/PREVIOUS]\n',
      saycodeSystemPromptEnabled: false,
      isNewSession: true,
    });

    expect(prompt).toBe('CLIENT APPEND\n\n[PREVIOUS]\nUser: earlier turn\n[/PREVIOUS]\n\ncurrent turn');
    expect(prompt.match(/current turn/g)).toHaveLength(1);
  });
});

describe('hashGeminiMode', () => {
  const base = { permissionMode: 'default' as const, model: 'gemini-2.5-pro' };

  it('restarts the ACP session when prompt policy or client context changes', () => {
    const enabled = hashGeminiMode({ ...base, appendSystemPrompt: 'A', saycodeSystemPromptEnabled: true });

    expect(hashGeminiMode({ ...base, appendSystemPrompt: 'A', saycodeSystemPromptEnabled: false }))
      .not.toBe(enabled);
    expect(hashGeminiMode({ ...base, appendSystemPrompt: 'B', saycodeSystemPromptEnabled: true }))
      .not.toBe(enabled);
  });

  it('treats an absent policy as the legacy enabled policy', () => {
    expect(hashGeminiMode({ ...base, appendSystemPrompt: 'A' }))
      .toBe(hashGeminiMode({ ...base, appendSystemPrompt: 'A', saycodeSystemPromptEnabled: true }));
  });
});

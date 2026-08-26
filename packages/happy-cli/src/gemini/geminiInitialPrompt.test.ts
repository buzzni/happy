import { describe, expect, it, vi } from 'vitest';

import {
  deliverGeminiInitialPrompt,
  prepareGeminiInitialPrompt,
  prepareGeminiSessionStart,
} from './geminiInitialPrompt';

describe('Gemini recovered initial prompt', () => {
  it('consumes the prompt, local id, append prompt, and explicit policy exactly once', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_PROMPT: 'recover this turn',
      HAPPY_INITIAL_PROMPT_LOCAL_ID: 'local-1',
      HAPPY_INITIAL_APPEND_SYSTEM_PROMPT: [
        'USER PROJECT CONTEXT',
        '',
        '<!-- saycode:owned-prompt -->',
        'SAYCODE RECOVERY PROMPT',
        '<!-- saycode:owned-prompt -->',
      ].join('\n'),
      HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED: 'false',
    };

    expect(prepareGeminiInitialPrompt(env)).toEqual({
      prompt: 'recover this turn',
      localId: 'local-1',
      appendSystemPrompt: 'USER PROJECT CONTEXT',
      saycodeSystemPromptEnabled: false,
    });
    expect(env).not.toHaveProperty('HAPPY_INITIAL_PROMPT');
    expect(env).not.toHaveProperty('HAPPY_INITIAL_PROMPT_LOCAL_ID');
    expect(env).not.toHaveProperty('HAPPY_INITIAL_APPEND_SYSTEM_PROMPT');
    expect(env).not.toHaveProperty('HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED');
  });

  it('carries the daemon model seed into the first Gemini mode and consumes spawn selections once', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_MODEL: ' gemini-3.1-pro-preview ',
      HAPPY_INITIAL_EFFORT: 'high',
    };

    expect(prepareGeminiInitialPrompt(env)).toEqual({
      prompt: null,
      model: 'gemini-3.1-pro-preview',
    });
    expect(env).not.toHaveProperty('HAPPY_INITIAL_MODEL');
    expect(env).not.toHaveProperty('HAPPY_INITIAL_EFFORT');
  });

  it('publishes and queues the recovered user turn only once', () => {
    const prepared = prepareGeminiInitialPrompt({
      HAPPY_INITIAL_PROMPT: 'recover this turn',
      HAPPY_INITIAL_PROMPT_LOCAL_ID: 'local-1',
      HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED: 'false',
    });
    const sendSessionMessage = vi.fn();
    const pushPrompt = vi.fn();

    expect(deliverGeminiInitialPrompt({ prepared, sendSessionMessage, pushPrompt })).toBe(true);
    expect(sendSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        ev: { t: 'text', text: 'recover this turn' },
      }),
      'local-1',
    );
    expect(pushPrompt).toHaveBeenCalledWith('recover this turn');

    expect(deliverGeminiInitialPrompt({ prepared, sendSessionMessage, pushPrompt })).toBe(false);
    expect(sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(pushPrompt).toHaveBeenCalledTimes(1);
  });

  it('delivers the recovered turn before reporting session startup', async () => {
    const order: string[] = [];
    const prepared = prepareGeminiInitialPrompt({
      HAPPY_INITIAL_PROMPT: 'recover this turn',
    });

    await prepareGeminiSessionStart({
      prepared,
      sendSessionMessage: () => order.push('server-message'),
      pushPrompt: () => order.push('backend-queue'),
      reportStarted: async () => { order.push('daemon-report'); },
    });

    expect(order).toEqual(['server-message', 'backend-queue', 'daemon-report']);
  });
});

describe('HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS hygiene', () => {
  it('carries the block seed into the first Gemini mode and consumes it once', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: '{"workerDelegation":false}',
    };
    expect(prepareGeminiInitialPrompt(env).saycodePromptBlocks).toEqual({
      workerDelegation: false,
    });
    expect(env).not.toHaveProperty('HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS');
  });
});

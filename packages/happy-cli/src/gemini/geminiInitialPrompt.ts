import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

import {
  consumePendingInitialAppendSystemPrompt,
  consumePendingInitialPrompt,
  consumePendingInitialPromptLocalId,
  consumePendingInitialSaycodeSystemPromptEnabled,
} from '@/utils/initialPrompt';

export type PreparedGeminiInitialPrompt = {
  prompt: string | null;
  localId?: string;
  appendSystemPrompt?: string;
  saycodeSystemPromptEnabled?: boolean;
};

export function prepareGeminiInitialPrompt(
  env: NodeJS.ProcessEnv,
): PreparedGeminiInitialPrompt {
  const prompt = consumePendingInitialPrompt(env);
  const localId = consumePendingInitialPromptLocalId(env);
  const appendSystemPrompt = consumePendingInitialAppendSystemPrompt(env);
  const saycodeSystemPromptEnabled =
    consumePendingInitialSaycodeSystemPromptEnabled(env);

  return {
    prompt,
    ...(prompt && localId ? { localId } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    ...(saycodeSystemPromptEnabled !== undefined
      ? { saycodeSystemPromptEnabled }
      : {}),
  };
}

export function deliverGeminiInitialPrompt(input: {
  prepared: PreparedGeminiInitialPrompt;
  sendSessionMessage: (envelope: SessionEnvelope, localId?: string) => void;
  pushPrompt: (prompt: string) => void;
}): boolean {
  const prompt = input.prepared.prompt;
  input.prepared.prompt = null;
  if (!prompt) return false;

  input.sendSessionMessage(
    createEnvelope('user', { t: 'text', text: prompt }),
    input.prepared.localId,
  );
  input.pushPrompt(prompt);
  return true;
}

export async function prepareGeminiSessionStart(input: {
  prepared: PreparedGeminiInitialPrompt;
  sendSessionMessage: (envelope: SessionEnvelope, localId?: string) => void;
  pushPrompt: (prompt: string) => void;
  reportStarted?: () => Promise<void>;
}): Promise<boolean> {
  const delivered = deliverGeminiInitialPrompt(input);
  await input.reportStarted?.();
  return delivered;
}

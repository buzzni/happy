import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

import {
  consumePendingInitialAppendSystemPrompt,
  consumePendingInitialEffort,
  consumePendingInitialModel,
  consumePendingInitialPrompt,
  consumePendingInitialPromptLocalId,
  consumePendingInitialSaycodePromptBlocks,
  consumePendingInitialSaycodeSystemPromptEnabled,
} from '@/utils/initialPrompt';
import { resolveInitialSaycodeAppendSystemPrompt } from '@/prompt/promptProvenance';
import type { SaycodePromptBlockOverrides } from '@/prompt/promptProvenance';

export type PreparedGeminiInitialPrompt = {
  prompt: string | null;
  model?: string;
  localId?: string;
  appendSystemPrompt?: string;
  saycodeSystemPromptEnabled?: boolean;
  saycodePromptBlocks?: SaycodePromptBlockOverrides;
};

export function prepareGeminiInitialPrompt(
  env: NodeJS.ProcessEnv,
): PreparedGeminiInitialPrompt {
  const prompt = consumePendingInitialPrompt(env);
  const model = consumePendingInitialModel(env);
  // Gemini has no effort control, but every spawn seed is consume-once so it
  // cannot leak into tools or children launched by this session.
  consumePendingInitialEffort(env);
  const localId = consumePendingInitialPromptLocalId(env);
  const saycodeSystemPromptEnabled =
    consumePendingInitialSaycodeSystemPromptEnabled(env);
  const saycodePromptBlocks = consumePendingInitialSaycodePromptBlocks(env);
  const appendSystemPrompt = resolveInitialSaycodeAppendSystemPrompt({
    appendSystemPrompt: consumePendingInitialAppendSystemPrompt(env),
    saycodeSystemPromptEnabled,
  });

  return {
    prompt,
    ...(model ? { model } : {}),
    ...(prompt && localId ? { localId } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    ...(saycodeSystemPromptEnabled !== undefined
      ? { saycodeSystemPromptEnabled }
      : {}),
    ...(saycodePromptBlocks ? { saycodePromptBlocks } : {}),
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

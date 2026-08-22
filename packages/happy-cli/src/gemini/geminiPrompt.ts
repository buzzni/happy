import { hashObject } from '@/utils/deterministicJson';
import { CHANGE_TITLE_INSTRUCTION } from './constants';
import type { GeminiMode } from './types';

export function buildGeminiTurnPrompt(input: {
  userText: string;
  appendSystemPrompt?: string;
  previousConversationContext?: string;
  isNewSession: boolean;
}): string {
  if (!input.isNewSession) return input.userText;

  return [
    input.appendSystemPrompt,
    input.previousConversationContext?.trim(),
    input.userText,
    input.appendSystemPrompt ? CHANGE_TITLE_INSTRUCTION : undefined,
  ].filter((block): block is string => Boolean(block)).join('\n\n');
}

export function hashGeminiMode(mode: GeminiMode): string {
  return hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
    appendSystemPrompt: mode.appendSystemPrompt,
    saycodeSystemPromptEnabled: mode.saycodeSystemPromptEnabled !== false,
  });
}

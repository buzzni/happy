import { hashObject } from '@/utils/deterministicJson';
import { CHANGE_TITLE_INSTRUCTION } from './constants';
import type { GeminiMode } from './types';
import { isSaycodePromptBlockEnabled } from '@/prompt/promptProvenance';

export function buildGeminiTurnPrompt(input: {
  userText: string;
  appendSystemPrompt?: string;
  previousConversationContext?: string;
  agentOrchestrationPrompt?: string;
  saycodeSystemPromptEnabled?: boolean;
  saycodePromptBlocks?: GeminiMode['saycodePromptBlocks'];
  isNewSession: boolean;
}): string {
  if (!input.isNewSession) return input.userText;

  const agentOrchestrationPrompt = isSaycodePromptBlockEnabled(
    'agentOrchestration',
    input.saycodePromptBlocks,
    input.saycodeSystemPromptEnabled,
  ) ? input.agentOrchestrationPrompt : undefined;
  return [
    input.appendSystemPrompt,
    agentOrchestrationPrompt,
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
    agentOrchestrationEnabled: isSaycodePromptBlockEnabled(
      'agentOrchestration',
      mode.saycodePromptBlocks,
      mode.saycodeSystemPromptEnabled,
    ),
  });
}

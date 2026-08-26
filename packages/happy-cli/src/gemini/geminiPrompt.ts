import { isSaycodePromptBlockEnabled } from '@/prompt/promptProvenance';
import { hashObject } from '@/utils/deterministicJson';
import { CHANGE_TITLE_INSTRUCTION } from './constants';
import type { GeminiMode } from './types';

export function buildGeminiTurnPrompt(input: {
  userText: string;
  appendSystemPrompt?: string;
  previousConversationContext?: string;
  agentOrchestrationPrompt?: string;
  saycodeSystemPromptEnabled?: boolean;
  saycodePromptBlocks?: GeminiMode['saycodePromptBlocks'];
  isNewSession: boolean;
  hasTitle: boolean;
}): string {
  const agentOrchestrationPrompt = isSaycodePromptBlockEnabled(
    'agentOrchestration',
    input.saycodePromptBlocks,
    input.saycodeSystemPromptEnabled,
  ) ? input.agentOrchestrationPrompt : undefined;
  return [
    input.isNewSession ? input.appendSystemPrompt : undefined,
    input.isNewSession ? agentOrchestrationPrompt : undefined,
    input.isNewSession ? input.previousConversationContext?.trim() : undefined,
    input.userText,
    input.hasTitle ? undefined : CHANGE_TITLE_INSTRUCTION,
  ].filter((block): block is string => Boolean(block)).join('\n\n');
}

export function hashGeminiMode(mode: GeminiMode): string {
  return hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
    appendSystemPrompt: mode.appendSystemPrompt,
    agentOrchestrationEnabled: isSaycodePromptBlockEnabled(
      'agentOrchestration',
      mode.saycodePromptBlocks,
      mode.saycodeSystemPromptEnabled,
    ),
  });
}

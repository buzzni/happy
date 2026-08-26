/**
 * Gemini Types
 *
 * Centralized type definitions for Gemini integration.
 */

import type { PermissionMode } from '@/api/types';
import type { SaycodePromptBlockOverrides } from '@/prompt/promptProvenance';

/**
 * Mode configuration for Gemini messages
 */
export interface GeminiMode {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage?: string; // Original user message without system prompt
  appendSystemPrompt?: string;
  saycodeSystemPromptEnabled?: boolean;
  /** Required snapshot property; undefined means default-on/inherit semantics. */
  saycodePromptBlocks: SaycodePromptBlockOverrides | undefined;
}

/**
 * Codex message payload for sending messages to mobile app
 */
export interface CodexMessagePayload {
  type: 'message';
  message: string;
  id: string;
  options?: string[];
}

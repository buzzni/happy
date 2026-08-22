import { stripSaycodeOwnedPromptBlocks } from '@slopus/happy-wire';

export type PromptProvenance =
  | 'saycode'
  | 'selected-feature'
  | 'operational'
  | 'client-composed';

export const PROMPT_BLOCK_PROVENANCE = {
  'claude:title': 'saycode',
  'claude:co-authored-credit': 'saycode',
  'claude:orchestrator': 'selected-feature',
  'claude:worker-delegation': 'saycode',
  'claude:connector-guidance': 'operational',
  'claude:ax-base': 'saycode',
  'claude:ax-step-guide': 'selected-feature',
  'claude:ax-dynamic-context': 'selected-feature',
  'codex:title': 'saycode',
  'codex:connector-guidance': 'operational',
  'client:append-system-prompt': 'client-composed',
} as const satisfies Record<string, PromptProvenance>;

export type PromptBlockId = keyof typeof PROMPT_BLOCK_PROVENANCE;

export function resolveInitialSaycodeAppendSystemPrompt(input: {
  appendSystemPrompt: string | undefined;
  saycodeSystemPromptEnabled: boolean | undefined;
}): string | undefined {
  return resolveSaycodeAppendSystemPromptForMessage({
    current: undefined,
    incoming: input.appendSystemPrompt,
    hasIncoming: true,
    saycodeSystemPromptEnabled: input.saycodeSystemPromptEnabled,
  });
}

export function resolveSaycodeAppendSystemPromptForMessage(input: {
  current: string | undefined;
  incoming?: string | null;
  hasIncoming: boolean;
  saycodeSystemPromptEnabled: boolean | undefined;
}): string | undefined {
  const resolved = input.hasIncoming ? input.incoming || undefined : input.current;
  return input.saycodeSystemPromptEnabled === false
    ? stripSaycodeOwnedPromptBlocks(resolved)
    : resolved;
}

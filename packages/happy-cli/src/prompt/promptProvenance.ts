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

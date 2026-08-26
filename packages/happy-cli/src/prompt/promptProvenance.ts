import {
  stripClientTurnPromptBlocks,
  stripSaycodeOwnedPromptBlocks,
} from '@slopus/happy-wire';

export type PromptProvenance =
  | 'saycode'
  | 'always-on'
  | 'selected-feature'
  | 'operational'
  | 'client-composed';

/**
 * `always-on` blocks are product plumbing, not Saycode-owned behavioral
 * guidance: `saycodeSystemPromptEnabled: false` never removes them. The chat
 * title instruction is the only current member — every client's chat list
 * depends on the `change_title` tool actually being called, and that tool
 * stays registered even when Saycode prompts are off (see claudePrompt.ts,
 * codexPrompt.ts, and geminiPrompt.ts). Settings UI should render `always-on`
 * blocks as non-toggleable and say so, rather than omitting them from the list.
 */
export const PROMPT_BLOCK_PROVENANCE = {
  'common:agent-orchestration': 'saycode',
  'claude:title': 'always-on',
  'claude:co-authored-credit': 'saycode',
  'claude:orchestrator': 'selected-feature',
  'claude:worker-delegation': 'saycode',
  'claude:connector-guidance': 'operational',
  'claude:ax-base': 'saycode',
  'claude:ax-step-guide': 'selected-feature',
  'claude:ax-dynamic-context': 'selected-feature',
  'codex:title': 'always-on',
  'codex:connector-guidance': 'operational',
  'gemini:title': 'always-on',
  'client:append-system-prompt': 'client-composed',
} as const satisfies Record<string, PromptProvenance>;

/** Saycode-owned blocks controlled only by the existing master prompt switch. */
export const SAYCODE_MASTER_PROMPT_PROVENANCE_IDS = [] as const satisfies readonly PromptBlockId[];

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
  // A client-local block is valid only while that client supplies appendSystemPrompt.
  // Another client may omit the field to preserve user/project context; remove just
  // the stale local block instead of clearing the whole cached prompt.
  const currentClientPrompt = input.hasIncoming
    ? resolved
    : stripClientTurnPromptBlocks(resolved);
  return input.saycodeSystemPromptEnabled === false
    ? stripSaycodeOwnedPromptBlocks(currentClientPrompt)
    : currentClientPrompt;
}

/**
 * Individually toggleable Saycode-owned prompt blocks. Provider title blocks
 * are deliberately excluded — they are `always-on` (see
 * PROMPT_BLOCK_PROVENANCE) and never represented as a preference here.
 */
export type SaycodePromptBlockName =
  | 'agentOrchestration'
  | 'coAuthoredCredit'
  | 'workerDelegation'
  | 'axBase';

export type SaycodePromptBlockOverrides = Partial<Record<SaycodePromptBlockName, boolean>>;

/**
 * Ties each toggle to its entry in {@link PROMPT_BLOCK_PROVENANCE}. Without this link
 * the two catalogs drift: a settings UI reads the provenance map to decide what is
 * Saycode-owned, but the toggles live in a separate union, so a new owned block can
 * silently ship with no user control (or a toggle can outlive its block). The
 * `satisfies` clause catches a missing/misspelled id at compile time; the companion
 * test catches an owned block that never got a toggle.
 */
export const SAYCODE_PROMPT_BLOCK_PROVENANCE_IDS = {
  agentOrchestration: 'common:agent-orchestration',
  coAuthoredCredit: 'claude:co-authored-credit',
  workerDelegation: 'claude:worker-delegation',
  axBase: 'claude:ax-base',
} as const satisfies Record<SaycodePromptBlockName, PromptBlockId>;

/**
 * Resolves whether one Saycode-owned block should render, given an optional
 * per-block override and the legacy on/off value. A per-block override always
 * wins. Delegation blocks are product capabilities and default on independently
 * from the master switch; the remaining blocks inherit the legacy value.
 * Missing legacy value defaults to enabled, matching the existing wire
 * compatibility rule for older clients/runtimes.
 */
export function isSaycodePromptBlockEnabled(
  blockName: SaycodePromptBlockName,
  overrides: SaycodePromptBlockOverrides | undefined,
  saycodeSystemPromptEnabled: boolean | undefined,
): boolean {
  const override = overrides?.[blockName];
  if (override !== undefined) return override;
  if (blockName === 'agentOrchestration' || blockName === 'workerDelegation') return true;
  return saycodeSystemPromptEnabled !== false;
}

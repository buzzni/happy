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
  'common:api-gateway': 'saycode',
  'common:next-steps': 'saycode',
  'claude:title': 'always-on',
  'claude:co-authored-credit': 'saycode',
  'claude:orchestrator': 'selected-feature',
  'claude:worker-delegation': 'saycode',
  'claude:connector-guidance': 'saycode',
  'claude:ax-base': 'saycode',
  'claude:ax-step-guide': 'selected-feature',
  'claude:ax-dynamic-context': 'selected-feature',
  'codex:title': 'always-on',
  'codex:connector-guidance': 'saycode',
  'common:checkpoint-guidance': 'saycode',
  'gemini:title': 'always-on',
  'client:append-system-prompt': 'client-composed',
} as const satisfies Record<string, PromptProvenance>;

/** Saycode-owned blocks controlled only by the existing master prompt switch. */
export const SAYCODE_MASTER_PROMPT_PROVENANCE_IDS = [
  'common:api-gateway',
  'claude:connector-guidance',
  'codex:connector-guidance',
  'common:checkpoint-guidance',
] as const satisfies readonly PromptBlockId[];

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

const CLIENT_TURN_BLOCK_CANDIDATE = /^<!-- saycode:client-turn-prompt:([a-z0-9]+-[a-z0-9]+):start -->\n[\s\S]*?\n<!-- saycode:client-turn-prompt:\1:end -->$/gm;

/**
 * Splits a client append prompt into the context that stays for the thread and the
 * client-turn blocks valid for this turn only. A candidate counts only when the wire
 * validator would remove it on its own, so marker-like user text stays standing.
 */
export function splitClientTurnPromptBlocks(prompt: string | undefined): { standing: string | undefined; turn: string | undefined } {
  if (!prompt) return { standing: prompt, turn: undefined };
  const blocks = [...prompt.matchAll(CLIENT_TURN_BLOCK_CANDIDATE)]
    .map((match) => match[0])
    .filter((block) => stripClientTurnPromptBlocks(block) === undefined);
  return {
    standing: stripClientTurnPromptBlocks(prompt),
    turn: blocks.length > 0 ? blocks.join('\n\n') : undefined,
  };
}

/**
 * Saycode-owned prompt block names on the wire. Only `nextSteps` still changes
 * rendering; the others follow the master switch. Provider title blocks
 * are deliberately excluded — they are `always-on` (see
 * PROMPT_BLOCK_PROVENANCE) and never represented as a preference here.
 */
export type SaycodePromptBlockName =
  | 'agentOrchestration'
  | 'coAuthoredCredit'
  | 'workerDelegation'
  | 'axBase'
  | 'nextSteps';

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
  nextSteps: 'common:next-steps',
} as const satisfies Record<SaycodePromptBlockName, PromptBlockId>;

/**
 * Resolves whether one Saycode-owned block should render. Saycode prompts are
 * all on or all off (aplus-dev-studio specs/saycode-security-hardening D1):
 * only the master value decides, and per-block overrides an older client still
 * sends are ignored. Missing master value defaults to enabled, matching the
 * existing wire compatibility rule for older clients/runtimes.
 */
export function isSaycodePromptBlockEnabled(
  blockName: SaycodePromptBlockName,
  overrides: SaycodePromptBlockOverrides | undefined,
  saycodeSystemPromptEnabled: boolean | undefined,
): boolean {
  const override = overrides?.[blockName];
  // A client capability, not a preference: on only when this turn's client said it
  // draws the card, and still under the master switch (specs/desktop-next-steps-card).
  if (blockName === 'nextSteps') return override === true && saycodeSystemPromptEnabled !== false;
  return saycodeSystemPromptEnabled !== false;
}

/**
 * Splits one user message's `saycodePromptBlocks` into the overrides that persist for the
 * session and the ones that hold for this turn only.
 *
 * `nextSteps` says "the client that sent this turn draws the next-steps card"
 * (specs/desktop-next-steps-card). Unlike a preference it must not outlive its message:
 * a client that omits the field keeps the other overrides, and if the request stuck, a
 * phone that never draws the card would inherit Desktop's "yes" and the agent would put
 * its question where the phone cannot show it. A message whose only override is
 * `nextSteps` therefore also leaves the standing overrides untouched — the same as before
 * that key existed, when such a client sent no field at all.
 */
export function resolveMessagePromptBlocks(
  current: SaycodePromptBlockOverrides | undefined,
  meta: { saycodePromptBlocks?: SaycodePromptBlockOverrides | null } | undefined,
): { standing: SaycodePromptBlockOverrides | undefined; turn: SaycodePromptBlockOverrides | undefined } {
  const standing = standingPromptBlocks(current, meta);
  const turnCards = meta?.saycodePromptBlocks?.nextSteps === true;
  return { standing, turn: turnCards ? { ...standing, nextSteps: true } : standing };
}

function standingPromptBlocks(
  current: SaycodePromptBlockOverrides | undefined,
  meta: { saycodePromptBlocks?: SaycodePromptBlockOverrides | null } | undefined,
): SaycodePromptBlockOverrides | undefined {
  const kept = withoutTurnScopedBlocks(current);
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'saycodePromptBlocks')) return kept;
  const incoming = meta.saycodePromptBlocks;
  if (!incoming) return undefined;
  const keys = Object.keys(incoming);
  if (keys.length > 0 && keys.every((key) => key === 'nextSteps')) return kept;
  return withoutTurnScopedBlocks(incoming);
}

/** Drops `nextSteps` from a standing value (an initial env value or a pre-split cache). */
export function withoutTurnScopedBlocks(
  blocks: SaycodePromptBlockOverrides | undefined,
): SaycodePromptBlockOverrides | undefined {
  if (!blocks || !('nextSteps' in blocks)) return blocks;
  const { nextSteps: _turnScoped, ...rest } = blocks;
  return rest;
}

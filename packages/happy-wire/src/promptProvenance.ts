const SAYCODE_PROMPT_SENTINEL = '<!-- saycode:owned-prompt -->';
const CLIENT_TURN_PROMPT_SENTINEL = '<!-- saycode:client-turn-prompt -->';

function wrapPromptBlock(prompt: string, sentinel: string): string | undefined {
  const normalized = prompt.trim();
  if (!normalized) return undefined;
  return `${sentinel}\n${normalized}\n${sentinel}`;
}

function stripPromptBlocks(prompt: string | undefined, sentinel: string): string | undefined {
  if (!prompt) return prompt;
  const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const remaining = prompt
    .replace(new RegExp(`\\n*${escaped}\\n[\\s\\S]*?\\n${escaped}\\n*`, 'g'), '\n\n')
    .trim();
  return remaining || undefined;
}

export function wrapSaycodeOwnedPrompt(prompt: string): string | undefined {
  return wrapPromptBlock(prompt, SAYCODE_PROMPT_SENTINEL);
}

export function stripSaycodeOwnedPromptBlocks(prompt: string | undefined): string | undefined {
  return stripPromptBlocks(prompt, SAYCODE_PROMPT_SENTINEL);
}

/** Marks a client-local instruction that is valid only while that client keeps sending it. */
export function wrapClientTurnPrompt(prompt: string): string | undefined {
  return wrapPromptBlock(prompt, CLIENT_TURN_PROMPT_SENTINEL);
}

/** Removes client-local instructions cached from a previous client's turn. */
export function stripClientTurnPromptBlocks(prompt: string | undefined): string | undefined {
  return stripPromptBlocks(prompt, CLIENT_TURN_PROMPT_SENTINEL);
}

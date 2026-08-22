const SAYCODE_PROMPT_SENTINEL = '<!-- saycode:owned-prompt -->';

export function wrapSaycodeOwnedPrompt(prompt: string): string | undefined {
  const normalized = prompt.trim();
  if (!normalized) return undefined;
  return `${SAYCODE_PROMPT_SENTINEL}\n${normalized}\n${SAYCODE_PROMPT_SENTINEL}`;
}

export function stripSaycodeOwnedPromptBlocks(prompt: string | undefined): string | undefined {
  if (!prompt) return prompt;
  const escaped = SAYCODE_PROMPT_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const remaining = prompt
    .replace(new RegExp(`\\n*${escaped}\\n[\\s\\S]*?\\n${escaped}\\n*`, 'g'), '\n\n')
    .trim();
  return remaining || undefined;
}

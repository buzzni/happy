const SAYCODE_PROMPT_SENTINEL = '<!-- saycode:owned-prompt -->';
const CLIENT_TURN_PROMPT_START_RE = /^<!-- saycode:client-turn-prompt:([a-z0-9]+-[a-z0-9]+):start -->$/gm;

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

function clientTurnPromptToken(prompt: string): string {
  // This is a deterministic integrity checksum, not an authentication boundary.
  // It prevents marker-like user text from becoming a removal delimiter.
  let hash = 0x811c9dc5;
  for (let index = 0; index < prompt.length; index += 1) {
    hash ^= prompt.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prompt.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function clientTurnPromptStart(token: string): string {
  return `<!-- saycode:client-turn-prompt:${token}:start -->`;
}

function clientTurnPromptEnd(token: string): string {
  return `<!-- saycode:client-turn-prompt:${token}:end -->`;
}

export function wrapSaycodeOwnedPrompt(prompt: string): string | undefined {
  return wrapPromptBlock(prompt, SAYCODE_PROMPT_SENTINEL);
}

export function stripSaycodeOwnedPromptBlocks(prompt: string | undefined): string | undefined {
  return stripPromptBlocks(prompt, SAYCODE_PROMPT_SENTINEL);
}

/** Marks a client-local instruction that is valid only while that client keeps sending it. */
export function wrapClientTurnPrompt(prompt: string): string | undefined {
  const normalized = prompt.trim();
  if (!normalized) return undefined;
  const token = clientTurnPromptToken(normalized);
  return `${clientTurnPromptStart(token)}\n${normalized}\n${clientTurnPromptEnd(token)}`;
}

/** Removes client-local instructions cached from a previous client's turn. */
export function stripClientTurnPromptBlocks(prompt: string | undefined): string | undefined {
  if (!prompt) return prompt;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of prompt.matchAll(CLIENT_TURN_PROMPT_START_RE)) {
    const token = match[1];
    const start = match.index;
    const contentStart = start + match[0].length + 1;
    if (prompt[start + match[0].length] !== '\n') continue;

    const endMarker = `\n${clientTurnPromptEnd(token)}`;
    const markerStart = prompt.indexOf(endMarker, contentStart);
    if (markerStart === -1) continue;
    const content = prompt.slice(contentStart, markerStart);
    if (clientTurnPromptToken(content) !== token) continue;
    ranges.push({ start, end: markerStart + endMarker.length });
  }

  if (ranges.length === 0) return prompt.trim() || undefined;

  const mergedRanges: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    let start = range.start;
    let end = range.end;
    while (start > 0 && prompt[start - 1] === '\n') start -= 1;
    while (end < prompt.length && prompt[end] === '\n') end += 1;
    const previous = mergedRanges.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      mergedRanges.push({ start, end });
    }
  }

  let remaining = prompt;
  for (let index = mergedRanges.length - 1; index >= 0; index -= 1) {
    const { start, end } = mergedRanges[index];
    const before = remaining.slice(0, start);
    const after = remaining.slice(end);
    remaining = `${before}${before && after ? '\n\n' : ''}${after}`;
  }
  return remaining.trim() || undefined;
}

const LEGACY_SAYCODE_PROMPT_SENTINEL = '<!-- saycode:owned-prompt -->';

type PromptEnvelopeName = 'owned-prompt' | 'client-turn-prompt';
type PromptRange = { start: number; end: number };

function promptToken(prompt: string): string {
  // This is a deterministic integrity checksum, not an authentication boundary.
  // It prevents marker-like user text from becoming a removal delimiter.
  let hash = 0x811c9dc5;
  for (let index = 0; index < prompt.length; index += 1) {
    hash ^= prompt.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prompt.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function promptEnvelopeBoundary(
  name: PromptEnvelopeName,
  token: string,
  boundary: 'start' | 'end',
): string {
  return `<!-- saycode:${name}:${token}:${boundary} -->`;
}

function wrapPromptEnvelope(prompt: string, name: PromptEnvelopeName): string | undefined {
  const normalized = prompt.trim();
  if (!normalized) return undefined;
  const token = promptToken(normalized);
  return [
    promptEnvelopeBoundary(name, token, 'start'),
    normalized,
    promptEnvelopeBoundary(name, token, 'end'),
  ].join('\n');
}

function validatedPromptRanges(prompt: string, name: PromptEnvelopeName): PromptRange[] {
  const startPattern = new RegExp(
    `^<!-- saycode:${name}:([a-z0-9]+-[a-z0-9]+):start -->$`,
    'gm',
  );
  const ranges: PromptRange[] = [];
  for (const match of prompt.matchAll(startPattern)) {
    const token = match[1];
    const start = match.index;
    const contentStart = start + match[0].length + 1;
    if (prompt[start + match[0].length] !== '\n') continue;

    const endMarker = `\n${promptEnvelopeBoundary(name, token, 'end')}`;
    const markerStart = prompt.indexOf(endMarker, contentStart);
    if (markerStart === -1) continue;
    const content = prompt.slice(contentStart, markerStart);
    if (promptToken(content) !== token) continue;
    ranges.push({ start, end: markerStart + endMarker.length });
  }
  return ranges;
}

function removePromptRanges(prompt: string, ranges: PromptRange[]): string | undefined {
  if (ranges.length === 0) return prompt;

  const mergedRanges: PromptRange[] = [];
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
  return remaining.trim() ? remaining : undefined;
}

function stripValidatedPromptEnvelopes(
  prompt: string | undefined,
  name: PromptEnvelopeName,
): string | undefined {
  if (!prompt) return prompt;
  return removePromptRanges(prompt, validatedPromptRanges(prompt, name));
}

function stripLegacySaycodeOwnedPromptBlocks(prompt: string | undefined): string | undefined {
  if (!prompt) return prompt;
  const escaped = LEGACY_SAYCODE_PROMPT_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}\\n[\\s\\S]*?\\n${escaped}`, 'g');
  const ranges = [...prompt.matchAll(pattern)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
  return removePromptRanges(prompt, ranges);
}

export function wrapSaycodeOwnedPrompt(prompt: string): string | undefined {
  return wrapPromptEnvelope(prompt, 'owned-prompt');
}

export function stripSaycodeOwnedPromptBlocks(prompt: string | undefined): string | undefined {
  const current = stripValidatedPromptEnvelopes(prompt, 'owned-prompt');
  // COMPAT(legacy-owned-prompt-sentinel): 2026-08에 추가, 모든 지원 client가
  // checksummed owned-prompt envelope를 발신하는 최소 버전으로 올라간 뒤 제거.
  return stripLegacySaycodeOwnedPromptBlocks(current);
}

/** Marks a client-local instruction that is valid only while that client keeps sending it. */
export function wrapClientTurnPrompt(prompt: string): string | undefined {
  return wrapPromptEnvelope(prompt, 'client-turn-prompt');
}

/** Removes client-local instructions cached from a previous client's turn. */
export function stripClientTurnPromptBlocks(prompt: string | undefined): string | undefined {
  return stripValidatedPromptEnvelopes(prompt, 'client-turn-prompt');
}

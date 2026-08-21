function joinPromptBlocks(blocks: Array<string | undefined>): string | undefined {
  const prompt = blocks.filter((block): block is string => Boolean(block)).join('\n\n');
  return prompt || undefined;
}

export function buildClaudeSystemPromptOptions({
  customSystemPrompt,
  appendSystemPrompt,
  saycodeSystemPrompt,
  orchestratorPrompt,
  workerDelegationPrompt,
  connectorGuidance,
  saycodeSystemPromptEnabled,
}: {
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  saycodeSystemPrompt: string;
  orchestratorPrompt?: string;
  workerDelegationPrompt?: string;
  connectorGuidance?: string;
  saycodeSystemPromptEnabled?: boolean;
}): { customSystemPrompt?: string; appendSystemPrompt?: string } {
  const isSaycodeEnabled = saycodeSystemPromptEnabled !== false;
  return {
    customSystemPrompt: customSystemPrompt
      ? joinPromptBlocks([customSystemPrompt, isSaycodeEnabled ? saycodeSystemPrompt : undefined])
      : undefined,
    appendSystemPrompt: joinPromptBlocks([
      appendSystemPrompt,
      isSaycodeEnabled ? saycodeSystemPrompt : undefined,
      orchestratorPrompt,
      isSaycodeEnabled ? workerDelegationPrompt : undefined,
      connectorGuidance,
    ]),
  };
}

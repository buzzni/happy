function joinPromptBlocks(blocks: Array<string | undefined>): string | undefined {
  const prompt = blocks.filter((block): block is string => Boolean(block)).join('\n\n');
  return prompt || undefined;
}

export function buildClaudeSystemPromptOptions({
  customSystemPrompt,
  appendSystemPrompt,
  chatTitlePrompt,
  saycodeSystemPrompt,
  orchestratorPrompt,
  workerDelegationPrompt,
  connectorGuidance,
  saycodeSystemPromptEnabled,
}: {
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  /**
   * Instruction that makes the agent call `mcp__happy__change_title`. It is not
   * Saycode-owned behavioral guidance — it is how every client's chat list gets
   * a name — so it survives `saycodeSystemPromptEnabled: false`. Removing it
   * left the `change_title` tool registered with nothing telling the model to
   * call it, and chats stayed untitled.
   */
  chatTitlePrompt?: string;
  saycodeSystemPrompt: string;
  orchestratorPrompt?: string;
  workerDelegationPrompt?: string;
  connectorGuidance?: string;
  saycodeSystemPromptEnabled?: boolean;
}): { customSystemPrompt?: string; appendSystemPrompt?: string } {
  const isSaycodeEnabled = saycodeSystemPromptEnabled !== false;
  return {
    customSystemPrompt: customSystemPrompt
      ? joinPromptBlocks([customSystemPrompt, chatTitlePrompt, isSaycodeEnabled ? saycodeSystemPrompt : undefined])
      : undefined,
    appendSystemPrompt: joinPromptBlocks([
      appendSystemPrompt,
      chatTitlePrompt,
      isSaycodeEnabled ? saycodeSystemPrompt : undefined,
      orchestratorPrompt,
      isSaycodeEnabled ? workerDelegationPrompt : undefined,
      connectorGuidance,
    ]),
  };
}

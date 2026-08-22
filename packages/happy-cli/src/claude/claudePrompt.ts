import { isSaycodePromptBlockEnabled, type SaycodePromptBlockOverrides } from '@/prompt/promptProvenance';

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
  saycodePromptBlocks,
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
  /** Co-Authored-By commit credits — gated per-block as 'coAuthoredCredit'. */
  saycodeSystemPrompt: string;
  orchestratorPrompt?: string;
  /** Gated per-block as 'workerDelegation'. */
  workerDelegationPrompt?: string;
  connectorGuidance?: string;
  saycodeSystemPromptEnabled?: boolean;
  /** Per-block overrides; a block with no override inherits saycodeSystemPromptEnabled. */
  saycodePromptBlocks?: SaycodePromptBlockOverrides;
}): { customSystemPrompt?: string; appendSystemPrompt?: string } {
  const isCoAuthoredCreditEnabled = isSaycodePromptBlockEnabled(
    'coAuthoredCredit', saycodePromptBlocks, saycodeSystemPromptEnabled,
  );
  const isWorkerDelegationEnabled = isSaycodePromptBlockEnabled(
    'workerDelegation', saycodePromptBlocks, saycodeSystemPromptEnabled,
  );
  return {
    customSystemPrompt: customSystemPrompt
      ? joinPromptBlocks([customSystemPrompt, chatTitlePrompt, isCoAuthoredCreditEnabled ? saycodeSystemPrompt : undefined])
      : undefined,
    appendSystemPrompt: joinPromptBlocks([
      appendSystemPrompt,
      chatTitlePrompt,
      isCoAuthoredCreditEnabled ? saycodeSystemPrompt : undefined,
      orchestratorPrompt,
      isWorkerDelegationEnabled ? workerDelegationPrompt : undefined,
      connectorGuidance,
    ]),
  };
}

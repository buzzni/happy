import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import {
    isSaycodePromptBlockEnabled,
    type SaycodePromptBlockOverrides,
} from '@/prompt/promptProvenance';
import { hashObject } from '@/utils/deterministicJson';

import type { ReasoningEffort } from './codexAppServerTypes';

export interface CodexEnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    /** Happy app instructions appended to the first Codex prompt for option chips. */
    appendSystemPrompt?: string;
    /** Explicit policy for Saycode-owned instructions. Missing preserves legacy enabled behavior. */
    saycodeSystemPromptEnabled?: boolean;
    /** Per-block overrides; default-on blocks do not inherit the master policy. */
    saycodePromptBlocks?: SaycodePromptBlockOverrides;
    /** Reasoning effort passed through to Codex's sendTurnAndWait. */
    effort?: ReasoningEffort;
}

export function hashCodexEnhancedMode(mode: CodexEnhancedMode): string {
    return hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        appendSystemPrompt: mode.appendSystemPrompt,
        saycodeSystemPromptEnabled: mode.saycodeSystemPromptEnabled,
        saycodePromptBlocks: mode.saycodePromptBlocks,
        effort: mode.effort,
    });
}

export function buildCodexDeveloperInstructions({
    connectorGuidance,
    agentOrchestrationPrompt,
    mode,
}: {
    connectorGuidance?: string;
    agentOrchestrationPrompt?: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt' | 'saycodeSystemPromptEnabled' | 'saycodePromptBlocks'>;
}): string | undefined {
    const blocks = [connectorGuidance];
    if (isSaycodePromptBlockEnabled(
        'agentOrchestration',
        mode.saycodePromptBlocks,
        mode.saycodeSystemPromptEnabled,
    )) {
        blocks.push(agentOrchestrationPrompt);
    }
    if (mode.saycodeSystemPromptEnabled !== undefined) {
        blocks.push(mode.appendSystemPrompt);
    }
    return blocks.filter((block): block is string => Boolean(block)).join('\n\n') || undefined;
}

export function buildCodexTurnPrompt(opts: {
    message: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt' | 'saycodeSystemPromptEnabled'>;
    includeAppendSystemPrompt: boolean;
    includeTitleInstruction: boolean;
}): string {
    const parts: string[] = [];

    if (opts.includeAppendSystemPrompt && opts.mode.appendSystemPrompt) {
        parts.push(opts.mode.appendSystemPrompt);
    }
    parts.push(opts.message);

    if (opts.includeTitleInstruction) {
        parts.push(CHANGE_TITLE_INSTRUCTION);
    }

    return parts.join('\n\n');
}

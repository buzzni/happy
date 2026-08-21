import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { hashObject } from '@/utils/deterministicJson';

import type { ReasoningEffort } from './codexAppServerTypes';

export interface CodexEnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    /** Happy app instructions appended to the first Codex prompt for option chips. */
    appendSystemPrompt?: string;
    /** Explicit policy for Saycode-owned instructions. Missing preserves legacy enabled behavior. */
    saycodeSystemPromptEnabled?: boolean;
    /** Reasoning effort passed through to Codex's sendTurnAndWait. */
    effort?: ReasoningEffort;
}

export function hashCodexEnhancedMode(mode: CodexEnhancedMode): string {
    return hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        appendSystemPrompt: mode.appendSystemPrompt,
        saycodeSystemPromptEnabled: mode.saycodeSystemPromptEnabled,
        effort: mode.effort,
    });
}

export function buildCodexDeveloperInstructions({
    connectorGuidance,
    mode,
}: {
    connectorGuidance?: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt' | 'saycodeSystemPromptEnabled'>;
}): string | undefined {
    const blocks = [connectorGuidance];
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

    if (opts.includeTitleInstruction && opts.mode.saycodeSystemPromptEnabled !== false) {
        parts.push(CHANGE_TITLE_INSTRUCTION);
    }

    return parts.join('\n\n');
}

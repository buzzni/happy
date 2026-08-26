import { describe, expect, it } from 'vitest';

import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import {
    buildCodexDeveloperInstructions,
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    isSupportedCodexReasoningEffort,
    resolveCodexSaycodePromptBlocks,
    type CodexEnhancedMode,
} from './codexPrompt';

describe('isSupportedCodexReasoningEffort', () => {
    it.each(['max', 'ultra'])('accepts the GPT-5.6 effort advertised by the spawn facade: %s', (effort) => {
        expect(isSupportedCodexReasoningEffort(effort)).toBe(true);
    });

    it('rejects an unknown effort instead of poisoning the next turn', () => {
        expect(isSupportedCodexReasoningEffort('maximum')).toBe(false);
    });
});

describe('resolveCodexSaycodePromptBlocks', () => {
    it('applies an explicit block override and preserves it on later absent turns', () => {
        const disabled = resolveCodexSaycodePromptBlocks(undefined, {
            saycodePromptBlocks: { agentOrchestration: false },
        });
        expect(disabled).toEqual({ agentOrchestration: false });
        expect(resolveCodexSaycodePromptBlocks(disabled, undefined)).toBe(disabled);
    });

    it('resets cached block overrides only for an explicit null', () => {
        expect(resolveCodexSaycodePromptBlocks(
            { agentOrchestration: false },
            { saycodePromptBlocks: null },
        )).toBeUndefined();
    });
});

describe('buildCodexDeveloperInstructions', () => {
    it('uses replaceable developer instructions for explicit-policy clients', () => {
        expect(buildCodexDeveloperInstructions({
            connectorGuidance: 'CONNECTOR FACTS',
            agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
            mode: {
                appendSystemPrompt: 'USER AND PROJECT CONTEXT',
                saycodeSystemPromptEnabled: false,
            },
        })).toBe('CONNECTOR FACTS\n\nAGENT ORCHESTRATION: happy agent spawn\n\nUSER AND PROJECT CONTEXT');
    });

    it('keeps legacy client append prompts in the original user-turn position', () => {
        expect(buildCodexDeveloperInstructions({
            connectorGuidance: 'CONNECTOR FACTS',
            agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
            mode: { appendSystemPrompt: 'LEGACY APPEND' },
        })).toBe('CONNECTOR FACTS\n\nAGENT ORCHESTRATION: happy agent spawn');
    });

    it('keeps default-on orchestration when Saycode prompts are off', () => {
        expect(buildCodexDeveloperInstructions({
            connectorGuidance: 'CONNECTOR FACTS',
            agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
            mode: { saycodeSystemPromptEnabled: false },
        })).toBe('CONNECTOR FACTS\n\nAGENT ORCHESTRATION: happy agent spawn');
    });

    it('does not inject orchestration when its block is explicitly off', () => {
        expect(buildCodexDeveloperInstructions({
            connectorGuidance: 'CONNECTOR FACTS',
            agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
            mode: {
                saycodeSystemPromptEnabled: true,
                saycodePromptBlocks: { agentOrchestration: false },
            },
        })).toBe('CONNECTOR FACTS');
    });
});

describe('buildCodexTurnPrompt', () => {
    it('prepends Happy append system prompt before the first Codex user message', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'pick an option',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: true,
            includeTitleInstruction: true,
        });

        expect(prompt).toBe(
            '<options><option>Yes</option></options>\n\n' +
            'pick an option\n\n' +
            CHANGE_TITLE_INSTRUCTION,
        );
    });

    it('keeps the title instruction when Saycode prompts are disabled', () => {
        expect(buildCodexTurnPrompt({
            message: 'hello',
            mode: {
                appendSystemPrompt: 'USER AND PROJECT CONTEXT',
                saycodeSystemPromptEnabled: false,
            },
            includeAppendSystemPrompt: true,
            includeTitleInstruction: true,
        })).toBe(`USER AND PROJECT CONTEXT\n\nhello\n\n${CHANGE_TITLE_INSTRUCTION}`);
    });

    it('preserves the existing first-turn title instruction when no append prompt is set', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'hello',
            mode: {},
            includeAppendSystemPrompt: true,
            includeTitleInstruction: true,
        });

        expect(prompt).toBe(`hello\n\n${CHANGE_TITLE_INSTRUCTION}`);
        expect(CHANGE_TITLE_INSTRUCTION).toContain('generate a concise chat session title');
        expect(CHANGE_TITLE_INSTRUCTION).toContain('once');
        expect(CHANGE_TITLE_INSTRUCTION).toContain('do not call this function again');
        expect(CHANGE_TITLE_INSTRUCTION).toContain('branchSlug');
    });

    it('does not inject Happy preamble on normal follow-up turns', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'continue',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: false,
            includeTitleInstruction: false,
        });

        expect(prompt).toBe('continue');
    });

    it('can re-inject Happy append prompt without title instruction after a thread reset', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'start fresh',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: true,
            includeTitleInstruction: false,
        });

        expect(prompt).toBe(
            '<options><option>Yes</option></options>\n\n' +
            'start fresh',
        );
    });

    it('keeps external-service guidance out of user messages on first and follow-up turns', () => {
        const first = buildCodexTurnPrompt({
            message: 'check KNOI',
            mode: {},
            includeAppendSystemPrompt: false,
            includeTitleInstruction: false,
        });
        const followUp = buildCodexTurnPrompt({
            message: 'continue',
            mode: {},
            includeAppendSystemPrompt: false,
            includeTitleInstruction: false,
        });

        expect(first).toBe('check KNOI');
        expect(followUp).toBe('continue');
    });
});

describe('hashCodexEnhancedMode', () => {
    it('separates queued Codex messages with different append system prompts', () => {
        const baseMode: CodexEnhancedMode = {
            permissionMode: 'default',
            model: 'gpt-5.5',
            effort: 'medium',
        };

        expect(hashCodexEnhancedMode({
            ...baseMode,
            appendSystemPrompt: 'options A',
        })).not.toBe(hashCodexEnhancedMode({
            ...baseMode,
            appendSystemPrompt: 'options B',
        }));
    });

    it('separates queued messages when the Saycode prompt policy changes', () => {
        const baseMode: CodexEnhancedMode = { permissionMode: 'default' };

        expect(hashCodexEnhancedMode({
            ...baseMode,
            saycodeSystemPromptEnabled: true,
        })).not.toBe(hashCodexEnhancedMode({
            ...baseMode,
            saycodeSystemPromptEnabled: false,
        }));
    });
});

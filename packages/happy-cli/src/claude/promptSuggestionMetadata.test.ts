import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { publishClaudePromptSuggestion, updateClaudePromptSuggestion } from './promptSuggestionMetadata';

describe('updateClaudePromptSuggestion', () => {
    const metadata: Metadata = {
        path: '/workspace',
        host: 'mac',
        homeDir: '/home/test',
        happyHomeDir: '/home/test/.happy',
        happyLibDir: '/happy/lib',
        happyToolsDir: '/happy/tools',
        summary: { text: 'Keep me', updatedAt: 10 },
    };

    it('stores a trimmed Claude suggestion without dropping other metadata', () => {
        expect(updateClaudePromptSuggestion(metadata, '  Run the tests  ', 123)).toEqual({
            ...metadata,
            promptSuggestion: {
                text: 'Run the tests',
                provider: 'claude',
                updatedAt: 123,
            },
        });
    });

    it('uses explicit null when the next user input invalidates the suggestion', () => {
        const withSuggestion = updateClaudePromptSuggestion(metadata, 'Run the tests', 123);

        expect(updateClaudePromptSuggestion(withSuggestion, null, 456)).toEqual({
            ...metadata,
            promptSuggestion: null,
        });
    });

    it('publishes set and clear changes through the session metadata updater', () => {
        let current: Metadata = metadata;
        const updateMetadata = vi.fn((handler: (value: Metadata) => Metadata) => {
            current = handler(current);
        });

        publishClaudePromptSuggestion(updateMetadata, 'Run the tests', 123);
        publishClaudePromptSuggestion(updateMetadata, null, 456);

        expect(updateMetadata).toHaveBeenCalledTimes(2);
        expect(current).toEqual({ ...metadata, promptSuggestion: null });
    });
});

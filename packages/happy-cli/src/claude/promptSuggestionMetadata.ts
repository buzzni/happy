import type { Metadata } from '@/api/types';

type MetadataUpdater = (handler: (metadata: Metadata) => Metadata) => void;

export function updateClaudePromptSuggestion(
    metadata: Metadata,
    suggestion: string | null,
    updatedAt: number = Date.now(),
): Metadata {
    const text = suggestion?.trim();
    return {
        ...metadata,
        promptSuggestion: text
            ? { text, provider: 'claude', updatedAt }
            : null,
    };
}

export function publishClaudePromptSuggestion(
    updateMetadata: MetadataUpdater,
    suggestion: string | null,
    updatedAt: number = Date.now(),
): void {
    updateMetadata((metadata) => updateClaudePromptSuggestion(metadata, suggestion, updatedAt));
}

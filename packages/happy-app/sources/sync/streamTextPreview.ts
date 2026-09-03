import type { AgentTextMessage } from './typesMessage';

export const STREAM_TEXT_MAX_CHUNK_CHARS = 16 * 1024;

export interface StreamTextPreviewBlock {
    blockIndex: number;
    sequence: number;
    text: string | null;
    createdAt: number;
}

export interface StreamTextPreviewState {
    turnId: string;
    blocks: Record<number, StreamTextPreviewBlock>;
}

export interface StreamTextChunk {
    turnId: string;
    blockIndex: number;
    sequence: number;
    delta: string;
}

export function applyStreamTextChunk(
    current: StreamTextPreviewState | undefined,
    chunk: StreamTextChunk,
    receivedAt: number,
): StreamTextPreviewState {
    const state = current?.turnId === chunk.turnId
        ? current
        : { turnId: chunk.turnId, blocks: {} };
    const block = state.blocks[chunk.blockIndex];
    if (block && chunk.sequence <= block.sequence) return state;

    const expectedSequence = block ? block.sequence + 1 : 0;
    const hasCompletePrefix = !block || block.text !== null;
    const text = chunk.sequence === expectedSequence && hasCompletePrefix
        ? `${block?.text ?? ''}${chunk.delta}`
        : null;

    return {
        ...state,
        blocks: {
            ...state.blocks,
            [chunk.blockIndex]: {
                blockIndex: chunk.blockIndex,
                sequence: chunk.sequence,
                text,
                createdAt: block?.createdAt ?? receivedAt,
            },
        },
    };
}

export function streamTextPreviewMessages(state: StreamTextPreviewState | undefined): AgentTextMessage[] {
    if (!state) return [];
    return Object.values(state.blocks)
        .filter((block): block is StreamTextPreviewBlock & { text: string } => typeof block.text === 'string' && block.text.length > 0)
        .sort((a, b) => b.blockIndex - a.blockIndex)
        .map((block) => ({
            kind: 'agent-text',
            id: `stream-text:${state.turnId}:${block.blockIndex}`,
            localId: null,
            createdAt: block.createdAt,
            text: block.text,
        }));
}

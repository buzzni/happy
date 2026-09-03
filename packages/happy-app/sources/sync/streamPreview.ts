import type { AgentTextMessage } from './typesMessage';
import type { ApiSessionStreamDelta } from './apiTypes';

type StreamBlock = {
    text: string;
    final: boolean;
};

export const SESSION_STREAM_PREVIEW_MAX_CHARS = 256 * 1_024;
export const SESSION_STREAM_PREVIEW_MAX_BLOCKS = 256;

export type SessionStreamPreviewState = {
    messageId: string;
    createdAt: number;
    blocks: Record<number, StreamBlock> | null;
};

/**
 * Applies one best-effort stream frame. A missing/out-of-order slice hides the
 * whole draft for that message so the UI never presents incomplete text as if
 * it were contiguous. The persisted message remains authoritative.
 */
export function reduceSessionStreamPreview(
    current: SessionStreamPreviewState | undefined,
    frame: ApiSessionStreamDelta,
    createdAt: number,
): SessionStreamPreviewState {
    if (!current || current.messageId !== frame.messageId) {
        if (frame.offset !== 0) {
            return { messageId: frame.messageId, createdAt, blocks: null };
        }
        if (frame.delta.length > SESSION_STREAM_PREVIEW_MAX_CHARS) {
            return { messageId: frame.messageId, createdAt, blocks: null };
        }
        return {
            messageId: frame.messageId,
            createdAt,
            blocks: {
                [frame.index]: { text: frame.delta, final: frame.final },
            },
        };
    }

    if (current.blocks === null) {
        return current;
    }

    const block = current.blocks[frame.index];
    if ((block?.text.length ?? 0) !== frame.offset || block?.final === true) {
        return { ...current, blocks: null };
    }

    const blockCount = Object.keys(current.blocks).length + (block ? 0 : 1);
    const characterCount = Object.values(current.blocks)
        .reduce((total, existingBlock) => total + existingBlock.text.length, frame.delta.length);
    if (
        blockCount > SESSION_STREAM_PREVIEW_MAX_BLOCKS
        || characterCount > SESSION_STREAM_PREVIEW_MAX_CHARS
    ) {
        return { ...current, blocks: null };
    }

    return {
        ...current,
        blocks: {
            ...current.blocks,
            [frame.index]: {
                text: (block?.text ?? '') + frame.delta,
                final: frame.final,
            },
        },
    };
}

export function buildSessionStreamPreviewMessage(
    preview: SessionStreamPreviewState | undefined,
): AgentTextMessage | null {
    if (!preview?.blocks) return null;
    const text = Object.entries(preview.blocks)
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([, block]) => block.text)
        .join('');
    if (text.length === 0) return null;
    return {
        kind: 'agent-text',
        id: `stream-preview:${preview.messageId}`,
        localId: null,
        createdAt: preview.createdAt,
        text,
    };
}

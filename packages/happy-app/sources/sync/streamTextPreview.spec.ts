import { describe, expect, it } from 'vitest';
import { applyStreamTextChunk, streamTextPreviewMessages } from './streamTextPreview';

describe('stream text previews', () => {
    it('assembles ordered chunks into one transient agent message', () => {
        const first = applyStreamTextChunk(undefined, {
            turnId: 'turn-1', blockIndex: 0, sequence: 0, delta: 'Hel',
        }, 100);
        const second = applyStreamTextChunk(first, {
            turnId: 'turn-1', blockIndex: 0, sequence: 1, delta: 'lo',
        }, 200);

        expect(streamTextPreviewMessages(second)).toEqual([{
            kind: 'agent-text',
            id: 'stream-text:turn-1:0',
            localId: null,
            createdAt: 100,
            text: 'Hello',
        }]);
    });

    it('hides a block after a volatile sequence gap instead of rendering corrupt text', () => {
        const first = applyStreamTextChunk(undefined, {
            turnId: 'turn-1', blockIndex: 0, sequence: 0, delta: 'Hel',
        }, 100);
        const gap = applyStreamTextChunk(first, {
            turnId: 'turn-1', blockIndex: 0, sequence: 2, delta: 'o',
        }, 200);

        expect(streamTextPreviewMessages(gap)).toEqual([]);
    });

    it('replaces previews from the previous turn', () => {
        const first = applyStreamTextChunk(undefined, {
            turnId: 'turn-1', blockIndex: 0, sequence: 0, delta: 'old',
        }, 100);
        const nextTurn = applyStreamTextChunk(first, {
            turnId: 'turn-2', blockIndex: 0, sequence: 0, delta: 'new',
        }, 200);

        expect(streamTextPreviewMessages(nextTurn).map((message) => message.text)).toEqual(['new']);
    });
});

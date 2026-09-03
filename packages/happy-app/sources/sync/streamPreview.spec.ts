import { describe, expect, it } from 'vitest';
import {
    ApiEphemeralUpdateSchema,
    ApiSessionStreamDeltaSchema,
    SESSION_STREAM_DELTA_MAX_CHARS,
} from './apiTypes';
import {
    buildSessionStreamPreviewMessage,
    reduceSessionStreamPreview,
    SESSION_STREAM_PREVIEW_MAX_BLOCKS,
    SESSION_STREAM_PREVIEW_MAX_CHARS,
} from './streamPreview';

describe('session stream preview', () => {
    it('accepts the server envelope and validates decrypted frame fields', () => {
        expect(ApiEphemeralUpdateSchema.safeParse({
            type: 'stream',
            id: 'session-1',
            time: 123,
            data: 'ciphertext',
        }).success).toBe(true);
        expect(ApiSessionStreamDeltaSchema.safeParse({
            messageId: 'message-1',
            index: 0,
            offset: -1,
            delta: 'text',
            final: false,
        }).success).toBe(false);
        expect(ApiSessionStreamDeltaSchema.safeParse({
            messageId: 'message-1',
            index: 0,
            offset: 0,
            delta: 'x'.repeat(SESSION_STREAM_DELTA_MAX_CHARS + 1),
            final: false,
        }).success).toBe(false);
    });

    it('assembles contiguous blocks into a transient agent message', () => {
        let preview = reduceSessionStreamPreview(undefined, {
            messageId: 'message-1', index: 0, offset: 0, delta: 'Hello', final: false,
        }, 123);
        preview = reduceSessionStreamPreview(preview, {
            messageId: 'message-1', index: 0, offset: 5, delta: ' world', final: true,
        }, 124);
        preview = reduceSessionStreamPreview(preview, {
            messageId: 'message-1', index: 2, offset: 0, delta: '!', final: true,
        }, 125);

        expect(buildSessionStreamPreviewMessage(preview)).toEqual({
            kind: 'agent-text',
            id: 'stream-preview:message-1',
            localId: null,
            createdAt: 123,
            text: 'Hello world!',
        });
    });

    it('hides a draft after a missing or out-of-order slice', () => {
        let preview = reduceSessionStreamPreview(undefined, {
            messageId: 'message-1', index: 0, offset: 0, delta: 'Hello', final: false,
        }, 123);
        preview = reduceSessionStreamPreview(preview, {
            messageId: 'message-1', index: 0, offset: 7, delta: 'world', final: false,
        }, 124);

        expect(buildSessionStreamPreviewMessage(preview)).toBeNull();
        preview = reduceSessionStreamPreview(preview, {
            messageId: 'message-1', index: 1, offset: 0, delta: 'late', final: true,
        }, 125);
        expect(buildSessionStreamPreviewMessage(preview)).toBeNull();
    });

    it('hides a draft when its accumulated text exceeds the preview limit', () => {
        let preview = reduceSessionStreamPreview(undefined, {
            messageId: 'message-1', index: 0, offset: 0, delta: '', final: false,
        }, 123);
        const delta = 'x'.repeat(SESSION_STREAM_DELTA_MAX_CHARS);
        for (let offset = 0; offset < SESSION_STREAM_PREVIEW_MAX_CHARS; offset += delta.length) {
            preview = reduceSessionStreamPreview(preview, {
                messageId: 'message-1', index: 0, offset, delta, final: false,
            }, 123);
        }

        expect(buildSessionStreamPreviewMessage(preview)?.text).toHaveLength(SESSION_STREAM_PREVIEW_MAX_CHARS);
        preview = reduceSessionStreamPreview(preview, {
            messageId: 'message-1',
            index: 0,
            offset: SESSION_STREAM_PREVIEW_MAX_CHARS,
            delta: 'x',
            final: false,
        }, 123);
        expect(buildSessionStreamPreviewMessage(preview)).toBeNull();
    });

    it('hides a draft when its block count exceeds the preview limit', () => {
        let preview = reduceSessionStreamPreview(undefined, {
            messageId: 'message-1', index: 0, offset: 0, delta: 'x', final: true,
        }, 123);
        for (let index = 1; index < SESSION_STREAM_PREVIEW_MAX_BLOCKS; index++) {
            preview = reduceSessionStreamPreview(preview, {
                messageId: 'message-1', index, offset: 0, delta: 'x', final: true,
            }, 123);
        }

        expect(buildSessionStreamPreviewMessage(preview)?.text).toHaveLength(SESSION_STREAM_PREVIEW_MAX_BLOCKS);
        preview = reduceSessionStreamPreview(preview, {
            messageId: 'message-1',
            index: SESSION_STREAM_PREVIEW_MAX_BLOCKS,
            offset: 0,
            delta: 'x',
            final: true,
        }, 123);
        expect(buildSessionStreamPreviewMessage(preview)).toBeNull();
    });
});

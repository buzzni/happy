import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventRouter } from '@/app/events/eventRouter';
import { sessionUpdateHandler } from './sessionUpdateHandler';

function createHarness(connectionType: 'session-scoped' | 'user-scoped' = 'session-scoped') {
    const handlers = new Map<string, (data: unknown) => void>();
    const socket = {
        data: { happyClient: 'cli-coding-session/test' },
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
            handlers.set(event, handler);
            return socket;
        }),
    };
    const connection = connectionType === 'session-scoped'
        ? { connectionType, userId: 'user-1', sessionId: 'session-1', socket }
        : { connectionType, userId: 'user-1', socket };

    sessionUpdateHandler('user-1', socket as never, connection as never);
    return { handlers, connection };
}

describe('sessionUpdateHandler stream preview', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('registers and relays a validated preview through the ephemeral session path', () => {
        const emit = vi.spyOn(eventRouter, 'emitEphemeral').mockImplementation(() => {});
        const { handlers, connection } = createHarness();
        const preview = {
            sid: 'session-1',
            turnId: 'turn-1',
            blockIndex: 0,
            sequence: 3,
            content: 'encrypted-delta',
        };

        expect(handlers.has('session-stream-text')).toBe(true);
        handlers.get('session-stream-text')!(preview);

        expect(emit).toHaveBeenCalledWith({
            userId: 'user-1',
            payload: {
                type: 'stream-text',
                sessionId: 'session-1',
                turnId: 'turn-1',
                blockIndex: 0,
                sequence: 3,
                content: 'encrypted-delta',
            },
            recipientFilter: { type: 'all-interested-in-session', sessionId: 'session-1' },
            skipSenderConnection: connection,
        });
    });

    it('rejects cross-session, non-session-scoped, and malformed previews', () => {
        const emit = vi.spyOn(eventRouter, 'emitEphemeral').mockImplementation(() => {});
        const sessionHarness = createHarness();
        const userHarness = createHarness('user-scoped');
        const valid = {
            sid: 'session-1',
            turnId: 'turn-1',
            blockIndex: 0,
            sequence: 0,
            content: 'encrypted-delta',
        };

        sessionHarness.handlers.get('session-stream-text')!({ ...valid, sid: 'session-2' });
        sessionHarness.handlers.get('session-stream-text')!({ ...valid, sequence: -1 });
        sessionHarness.handlers.get('session-stream-text')!({ ...valid, content: '' });
        userHarness.handlers.get('session-stream-text')!(valid);

        expect(emit).not.toHaveBeenCalled();
    });
});

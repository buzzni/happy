import { describe, it, expect, vi } from 'vitest';
import { Session } from './session';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { ApiSessionClient } from '@/api/apiSession';
import type { EnhancedMode } from './loop';

function createSession(overrides: { startingMode?: 'local' | 'remote' } = {}) {
    const keepAlive = vi.fn();
    const resetContextUsage = vi.fn();
    const client = { keepAlive, resetContextUsage, updateMetadata: vi.fn() } as unknown as ApiSessionClient;
    const onModeChange = vi.fn();
    const session = new Session({
        api: {} as any,
        client,
        path: '/tmp',
        logPath: '/tmp/log',
        sessionId: null,
        mcpServers: {},
        messageQueue: new MessageQueue2<EnhancedMode>(() => 'hash'),
        onModeChange,
        hookSettingsPath: '/tmp/settings.json',
        startingMode: overrides.startingMode,
    });
    return { session, keepAlive, resetContextUsage, onModeChange };
}

describe('Session mode', () => {
    it('reports the given startingMode on the very first keepalive', () => {
        const { session, keepAlive } = createSession({ startingMode: 'remote' });
        expect(session.mode).toBe('remote');
        expect(keepAlive).toHaveBeenCalledWith(false, 'remote');
        session.cleanup();
    });

    it('defaults to local when no startingMode is given', () => {
        const { session, keepAlive } = createSession();
        expect(session.mode).toBe('local');
        expect(keepAlive).toHaveBeenCalledWith(false, 'local');
        session.cleanup();
    });

    it('updates mode, sends keepalive, and notifies the callback on onModeChange', () => {
        const { session, keepAlive, onModeChange } = createSession({ startingMode: 'remote' });
        keepAlive.mockClear();

        session.onModeChange('local');

        expect(session.mode).toBe('local');
        expect(keepAlive).toHaveBeenCalledWith(false, 'local');
        expect(onModeChange).toHaveBeenCalledWith('local');
        session.cleanup();
    });
});

describe('Session context-usage resets (Saycode specs/desktop-chat-context-window-meter R6)', () => {
    it('resets when Claude reports a different session id, not on the first one or the same one again', () => {
        const { session, resetContextUsage } = createSession({ startingMode: 'remote' });
        session.onSessionFound('claude-a');
        session.onSessionFound('claude-a');
        expect(resetContextUsage).not.toHaveBeenCalled();

        session.onSessionFound('claude-b');
        expect(resetContextUsage).toHaveBeenCalledOnce();
        session.cleanup();
    });

    it('does not reset again for the new id that follows a /clear, which already reset', () => {
        const { session, resetContextUsage } = createSession({ startingMode: 'remote' });
        session.onSessionFound('claude-a');
        session.clearSessionId();
        session.onSessionFound('claude-b');
        expect(resetContextUsage).not.toHaveBeenCalled();
        session.cleanup();
    });

    it('takes the meter down before keepalive reports local mode', () => {
        const { session, keepAlive, resetContextUsage } = createSession({ startingMode: 'remote' });
        keepAlive.mockClear();
        session.onModeChange('local');
        expect(resetContextUsage).toHaveBeenCalledOnce();
        expect(resetContextUsage.mock.invocationCallOrder[0]).toBeLessThan(keepAlive.mock.invocationCallOrder[0]);

        session.onModeChange('remote');
        expect(resetContextUsage).toHaveBeenCalledOnce();
        session.cleanup();
    });
});

describe('Session lesson lifecycle', () => {
    it('cancels pending review on new input without forgetting completed responses', () => {
        const { session } = createSession();
        const signal = session.lessonReviewLifecycle.controller.signal;
        session.lessonReviewLifecycle.completedAssistantTurns = 2;
        session.cancelLessonReview();
        expect(signal.aborted).toBe(true);
        expect(session.lessonReviewLifecycle.completedAssistantTurns).toBe(2);
        session.cleanup();
    });
    it('clears prior-response history on conversation reset and cancels review on cleanup', () => {
        const { session } = createSession();
        session.lessonReviewLifecycle.completedAssistantTurns = 2;
        session.clearSessionId();
        expect(session.lessonReviewLifecycle.completedAssistantTurns).toBe(0);
        expect(session.lessonReviewLifecycle.controller.signal.aborted).toBe(true);
        session.lessonReviewLifecycle.controller = new AbortController();
        const signal = session.lessonReviewLifecycle.controller.signal;
        session.cleanup();
        expect(signal.aborted).toBe(true);
    });
});

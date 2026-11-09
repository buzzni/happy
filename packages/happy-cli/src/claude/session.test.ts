import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Session } from './session';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { ApiSessionClient } from '@/api/apiSession';
import type { EnhancedMode } from './loop';
import { isOrgEndpointConversation } from './utils/orgEndpointConversation';
import { getProjectPath } from './utils/path';

function createSession(overrides: { startingMode?: 'local' | 'remote' } = {}) {
    const keepAlive = vi.fn();
    const resetContextUsage = vi.fn();
    const hideContextUsage = vi.fn();
    const client = { keepAlive, resetContextUsage, hideContextUsage, updateMetadata: vi.fn() } as unknown as ApiSessionClient;
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
    return { session, keepAlive, resetContextUsage, hideContextUsage, onModeChange };
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

// aplus specs/org-llm-endpoints r3 — what continues a transcript finds the mark beside it (orgEndpointConversation).
describe('Session marks the conversations of an organization LLM endpoint session', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it('marks every Claude id it learns, with ids only, beside the transcript', () => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', mkdtempSync(join(tmpdir(), 'org-endpoint-session-mark-')));
        vi.stubEnv('HAPPY_AI_AUTH_SOURCE', 'org-endpoint');
        vi.stubEnv('HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING', 'binding-1:endpoint-1:target-a:3');
        const { session } = createSession({ startingMode: 'remote' });
        session.onSessionFound('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
        // A resume mints a new id for the same conversation.
        session.onSessionFound('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
        const projectDir = getProjectPath('/tmp');
        expect(isOrgEndpointConversation(projectDir, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')).toBe(true);
        expect(isOrgEndpointConversation(projectDir, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')).toBe(true);
        expect(JSON.parse(readFileSync(join(projectDir, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.org-endpoint'), 'utf8')))
            .toEqual({ version: 1, bindingId: 'binding-1', endpointId: 'endpoint-1' });
        session.cleanup();
    });

    it('marks nothing for any other session', () => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', mkdtempSync(join(tmpdir(), 'org-endpoint-session-mark-')));
        vi.stubEnv('HAPPY_AI_AUTH_SOURCE', 'org-bundle');
        const { session } = createSession({ startingMode: 'remote' });
        session.onSessionFound('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
        expect(isOrgEndpointConversation(getProjectPath('/tmp'), 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')).toBe(false);
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

    it('takes the meter down before keepalive reports local mode, without a reset', () => {
        const { session, keepAlive, resetContextUsage, hideContextUsage } = createSession({ startingMode: 'remote' });
        keepAlive.mockClear();
        session.onModeChange('local');
        expect(hideContextUsage).toHaveBeenCalledOnce();
        expect(hideContextUsage.mock.invocationCallOrder[0]).toBeLessThan(keepAlive.mock.invocationCallOrder[0]);
        // The same conversation continues in the terminal: its windows stay valid.
        expect(resetContextUsage).not.toHaveBeenCalled();

        session.onModeChange('remote');
        expect(hideContextUsage).toHaveBeenCalledOnce();
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

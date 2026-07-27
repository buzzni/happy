import { describe, it, expect, vi, afterEach } from 'vitest';
import { Session } from './session';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { ApiSessionClient } from '@/api/apiSession';
import type { EnhancedMode } from './loop';

function createSession(overrides: { startingMode?: 'local' | 'remote' } = {}) {
    const keepAlive = vi.fn();
    const client = { keepAlive } as unknown as ApiSessionClient;
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
    return { session, keepAlive, onModeChange };
}

describe('Session mode', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

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

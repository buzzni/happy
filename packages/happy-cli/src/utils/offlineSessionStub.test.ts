/** The offline session stub is a no-op for every session method a runner calls before reconnection. */
import { describe, expect, it } from 'vitest';
import { createOfflineSessionStub } from './offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('takes the Codex sub-agent mark as a no-op', () => {
        const session = createOfflineSessionStub('test');
        expect(session.markLaunchedBackgroundJob()).toBeUndefined();
    });
});

import { describe, it, expect } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import type { Session } from '../session';

/**
 * Minimal Session stand-in: reset() only touches the agent-state updater, and
 * the constructor only registers an RPC handler.
 */
function createSessionStub(): Session {
    return {
        client: {
            sessionId: 'session-under-test',
            rpcHandlerManager: { registerHandler: () => { } },
            updateAgentState: (updater: (state: any) => any) => { updater({}); },
            getMetadata: () => ({}),
        },
        api: { push: () => ({ sendSessionNotification: () => { } }) },
    } as unknown as Session;
}

describe('PermissionHandler.reset', () => {
    // The mode updater captures the Query object of the generation that set it,
    // and reset() runs when that generation is torn down.
    it('releases the mode updater captured from the finished query generation', () => {
        const handler = new PermissionHandler(createSessionStub());
        handler.setPermissionModeUpdater(async () => { });

        handler.reset();

        const internals = handler as unknown as { setPermissionModeCallback?: unknown };
        expect(internals.setPermissionModeCallback).toBeUndefined();
    });

    // Registered once outside the restart loop and bound to the launcher-scoped
    // message queue, so clearing it would silently stop releasing delayed
    // messages for every query after the first reset.
    it('keeps the permission-request callback that outlives query generations', () => {
        const handler = new PermissionHandler(createSessionStub());
        handler.setOnPermissionRequest(() => { });

        handler.reset();

        const internals = handler as unknown as { onPermissionRequestCallback?: unknown };
        expect(internals.onPermissionRequestCallback).toBeTypeOf('function');
    });
});

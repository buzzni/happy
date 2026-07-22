import { describe, it, expect } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import type { Session } from '../session';
import type { EnhancedMode } from '../loop';

function stubOptions() {
    return { signal: new AbortController().signal, toolUseID: 'tool-call-1' };
}

function stubMode(): EnhancedMode {
    return { permissionMode: 'yolo' };
}

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

describe('PermissionHandler.handleToolCall with yolo mode', () => {
    // runClaude.ts defaults the initial permission mode to 'yolo' when no
    // --dangerously-skip-permissions flag or explicit mode is supplied, and
    // handleModeChange forwards that raw value untouched. 'yolo' is Claude's
    // bypass-equivalent (see mapToClaudeMode), so tool calls must be
    // auto-allowed instead of falling through to an approval request.
    it('auto-allows a dangerous tool call once the mode is set to yolo', async () => {
        const handler = new PermissionHandler(createSessionStub());
        handler.handleModeChange('yolo');

        // If yolo falls through to the approval flow, handleToolCall's promise
        // never resolves (nothing sends a permission response), so race it
        // against a timeout sentinel instead of awaiting it directly.
        const timeout = new Promise<'TIMED_OUT'>((resolve) => setTimeout(() => resolve('TIMED_OUT'), 200));
        const result = await Promise.race([
            handler.handleToolCall('Write', { file_path: 'a.txt' }, stubMode(), stubOptions()),
            timeout,
        ]);

        expect(result).not.toBe('TIMED_OUT');
        expect((result as { behavior: string }).behavior).toBe('allow');
    });
});

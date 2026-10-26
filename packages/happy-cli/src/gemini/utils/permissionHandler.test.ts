import { describe, expect, it, vi } from 'vitest';
import { GeminiPermissionHandler } from './permissionHandler';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

function createSessionMock() {
    let state: Record<string, any> = {};

    return {
        session: {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                state = updater(state);
                return state;
            }),
        },
        getState: () => state,
    };
}

describe('GeminiPermissionHandler auto-approval records', () => {
    it('marks an always-allowed tool as approved by the runtime itself', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);

        await expect(handler.handleToolCall('change_title-1765385846663', 'other', { title: 'Greeting' }))
            .resolves.toEqual({ decision: 'approved' });
        expect(getState().completedRequests['change_title-1765385846663']).toMatchObject({
            status: 'approved',
            resolution: 'auto-approved',
        });
    });

    it('marks every tool approved in yolo mode', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);
        handler.setPermissionMode('yolo');

        await expect(handler.handleToolCall('call-1', 'shell', { command: 'pwd' }))
            .resolves.toEqual({ decision: 'approved_for_session' });
        expect(getState().completedRequests['call-1']).toMatchObject({
            status: 'approved',
            decision: 'approved_for_session',
            resolution: 'auto-approved',
        });
    });

    it('marks a read-only tool approved in safe-yolo mode and still asks for a write', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);
        handler.setPermissionMode('safe-yolo');

        await handler.handleToolCall('call-read', 'read_file', { path: 'a.ts' });
        expect(getState().completedRequests['call-read']).toMatchObject({ resolution: 'auto-approved' });

        const pending = handler.handleToolCall('call-write', 'write_file', { path: 'a.ts' });
        expect(getState().requests['call-write']).toBeDefined();
        expect(getState().completedRequests['call-write']).toBeUndefined();
        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
        expect(getState().completedRequests['call-write']).toMatchObject({ status: 'canceled', resolution: 'aborted' });
    });
});

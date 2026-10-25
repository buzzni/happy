/**
 * Every path a Claude permission request leaves by is recorded in the agent state, and a late
 * answer is told what happened (aplus-dev-studio specs/codexcli-approval-session-binding Phase 2,
 * tasks T14·T15·T16).
 */
import { describe, expect, it } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import { APPROVAL_TIMEOUT_ABORT_REASON } from '@/toolPolicy/policyGate';
import type { Session } from '../session';
import type { EnhancedMode } from '../loop';

type State = {
    requests?: Record<string, Record<string, unknown>>;
    completedRequests?: Record<string, Record<string, unknown>>;
};

function createStub() {
    const handlers = new Map<string, (message: any) => Promise<any>>();
    let agentState: State = {};
    const session = {
        client: {
            sessionId: 'session-under-test',
            rpcHandlerManager: { registerHandler: (name: string, fn: (message: any) => Promise<any>) => { handlers.set(name, fn); } },
            updateAgentState: (updater: (state: any) => any) => { agentState = updater(agentState); },
            getMetadata: () => ({}),
        },
        api: { push: () => ({ sendSessionNotification: () => { } }) },
    } as unknown as Session;
    return {
        session,
        answer: (message: unknown) => handlers.get('permission')!(message),
        state: () => agentState,
    };
}

const MODE: EnhancedMode = { permissionMode: 'default' };

function raise(handler: PermissionHandler, id: string, signal = new AbortController().signal) {
    const pending = handler.handleToolCall('Bash', { command: 'rm -rf build' }, MODE, { signal, toolUseID: id });
    pending.catch(() => { });
    return pending;
}

describe('PermissionHandler resolution records', () => {
    it('records an aborted request as canceled instead of leaving it waiting (T14)', async () => {
        const stub = createStub();
        const handler = new PermissionHandler(stub.session);
        const controller = new AbortController();
        const pending = raise(handler, 'toolu_1', controller.signal);

        controller.abort();

        await expect(pending).rejects.toThrow('Permission request aborted');
        expect(stub.state().requests).toEqual({});
        expect(stub.state().completedRequests?.toolu_1).toMatchObject({ status: 'canceled', resolution: 'aborted' });
    });

    it('records an answer as answered', async () => {
        const stub = createStub();
        const handler = new PermissionHandler(stub.session);
        const pending = raise(handler, 'toolu_1');

        await stub.answer({ id: 'toolu_1', approved: false, reason: 'no' });

        await pending;
        expect(stub.state().completedRequests?.toolu_1).toMatchObject({ status: 'denied', resolution: 'answered' });
    });

    it.each([
        ['runtime-restart'],
        ['generation-ended'],
        ['reset'],
        ['shutdown'],
    ] as const)('records a %s reset on every request it cancels (T15)', async (resolution) => {
        const stub = createStub();
        const handler = new PermissionHandler(stub.session);
        raise(handler, 'toolu_1');

        handler.reset('why', resolution);

        expect(stub.state().completedRequests?.toolu_1).toMatchObject({ status: 'canceled', reason: 'why', resolution });
    });

    it('records a policy approval that timed out as expired, and one whose hook went away as aborted', async () => {
        const policy = { reasonCode: 'first_app_use', ruleId: 'r', humanOnly: false, grantOffer: 'once' as const };
        const stub = createStub();
        const handler = new PermissionHandler(stub.session);
        const timedOut = new AbortController();
        const gone = new AbortController();
        const first = handler.requestPolicyApproval({ id: 'p1', toolName: 'mcp__x__y', args: {}, policy, signal: timedOut.signal });
        const second = handler.requestPolicyApproval({ id: 'p2', toolName: 'mcp__x__y', args: {}, policy, signal: gone.signal });

        timedOut.abort(APPROVAL_TIMEOUT_ABORT_REASON);
        gone.abort();

        await expect(first).rejects.toThrow();
        await expect(second).rejects.toThrow();
        expect(stub.state().completedRequests?.p1).toMatchObject({ status: 'canceled', reason: 'Tool policy approval withdrawn', resolution: 'expired' });
        expect(stub.state().completedRequests?.p2).toMatchObject({ status: 'canceled', resolution: 'aborted' });
        expect(await stub.answer({ id: 'p1', approved: true })).toEqual({ applied: false, reason: 'expired' });
    });

    it('still tells a late answer it was already answered after a reset (T16)', async () => {
        const stub = createStub();
        const handler = new PermissionHandler(stub.session);
        raise(handler, 'toolu_1');
        await stub.answer({ id: 'toolu_1', approved: true });

        handler.reset('Session switched to local mode', 'reset');

        expect(await stub.answer({ id: 'toolu_1', approved: true })).toEqual({ applied: false, reason: 'already-answered' });
    });

    it('answers a late answer to a reset request as unknown, which the client reads from the record', async () => {
        const stub = createStub();
        const handler = new PermissionHandler(stub.session);
        raise(handler, 'toolu_1');

        handler.reset('Previous CLI process exited before responding', 'runtime-restart');

        expect(await stub.answer({ id: 'toolu_1', approved: true })).toEqual({ applied: false, reason: 'unknown-request' });
    });
});

describe('PermissionHandler abort of a replaced raising', () => {
    it('still settles the older promise when a newer raising took its id', async () => {
        const stub = createStub();
        const handler = new PermissionHandler(stub.session);
        const first = new AbortController();
        const older = raise(handler, 'toolu_1', first.signal);
        const newer = raise(handler, 'toolu_1');

        first.abort();

        await expect(older).rejects.toThrow('Permission request aborted');
        // The newer raising is untouched and still answerable.
        expect(await stub.answer({ id: 'toolu_1', approved: true })).toEqual({ applied: true });
        await expect(newer).resolves.toMatchObject({ behavior: 'allow' });
    });
});

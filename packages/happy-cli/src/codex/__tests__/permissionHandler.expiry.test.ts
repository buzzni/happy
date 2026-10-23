/**
 * The unattended wait on Base handler prompts, through the Codex handler
 * (aplus-dev-studio specs/codexcli-approval-session-binding R10·Q2·Q6, tasks T21·T23).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexPermissionHandler } from '../utils/permissionHandler';
import { TurnAttendanceState, type TurnAttendance } from '@/api/turnAttendance';
import { APPROVAL_TIMEOUT_ABORT_REASON } from '@/toolPolicy/policyGate';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

const MINUTE = 60_000;
const START = 2_000_000;

function setup(attendance: TurnAttendance) {
    let state: Record<string, any> = {};
    const protocol: any[] = [];
    const session = {
        rpcHandlerManager: { registerHandler: vi.fn() },
        updateAgentState: vi.fn((updater: (s: Record<string, any>) => Record<string, any>) => { state = updater(state); return state; }),
        sendSessionProtocolMessage: vi.fn((envelope: unknown) => { protocol.push(envelope); }),
    };
    const turn = new TurnAttendanceState();
    turn.beginTurn(attendance);
    const handler = new CodexPermissionHandler(session as any);
    handler.setAttendance(turn);
    const answer = (message: unknown) => {
        const permission = session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'permission');
        return permission![1](message);
    };
    return { handler, turn, answer, state: () => state, protocol };
}

describe('Codex permission prompts in an unattended turn', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
    afterEach(() => { vi.useRealTimers(); });

    it('declines with an explicit denial, so the turn goes on instead of aborting', async () => {
        const t = setup('unattended');
        const pending = t.handler.handleToolCall('call-1', 'CodexBash', { command: ['ls'] });
        expect(t.state().requests['call-1']).toMatchObject({ expiresAt: START + 30 * MINUTE });

        await vi.advanceTimersByTimeAsync(30 * MINUTE);

        await expect(pending).resolves.toEqual({ decision: 'denied' });
        expect(t.state().requests).toEqual({});
        expect(t.state().completedRequests['call-1']).toMatchObject({ status: 'denied', decision: 'denied', resolution: 'expired' });
        await expect(t.answer({ id: 'call-1', approved: true })).resolves.toEqual({ applied: false, reason: 'expired' });
    });

    it('declines the next prompt of the same turn without waiting (Q6)', async () => {
        const t = setup('unattended');
        void t.handler.handleToolCall('call-1', 'CodexBash', {});
        await vi.advanceTimersByTimeAsync(30 * MINUTE);

        const second = t.handler.handleToolCall('call-2', 'request_user_input', { questions: [] });
        await Promise.resolve();

        await expect(second).resolves.toEqual({ decision: 'denied' });
        expect(t.state().requests['call-2']).toBeUndefined();
        expect(t.state().completedRequests['call-2']).toMatchObject({ tool: 'request_user_input', resolution: 'expired' });
    });

    it('withdraws a messenger wait it published, with the existing `aborted` reason (T23)', async () => {
        const t = setup('channel');
        void t.handler.handleToolCall('call-1', 'CodexBash', {}, {
            channelTurn: { turnId: 'turn-1', channelRequestId: 'req-1', runtimeId: 'rt' },
        });

        await vi.advanceTimersByTimeAsync(30 * MINUTE);

        const events = t.protocol.map((envelope) => envelope.ev);
        expect(events.map((ev) => ev.t)).toEqual(['channel-permission', 'channel-permission-withdrawn']);
        expect(events[1].reason).toBe('aborted');
    });

    it('puts no timer on a tool policy prompt, whose gate already gives up after 30 minutes', async () => {
        const t = setup('channel');
        const policy = { reasonCode: 'first_app_use', ruleId: 'r', humanOnly: false, grantOffer: 'once' as const };
        const controller = new AbortController();
        const answered = t.handler.requestPolicyApproval({ id: 'p1', toolName: 'mcp__x__y', args: {}, policy, signal: controller.signal });
        expect(t.state().requests.p1.expiresAt).toBeUndefined();

        await vi.advanceTimersByTimeAsync(60 * MINUTE);
        expect(t.state().requests.p1).toBeDefined();

        // The gate's own timeout: recorded as expired, and the messenger turn's wait is spent.
        controller.abort(APPROVAL_TIMEOUT_ABORT_REASON);
        await expect(answered).rejects.toThrow();
        expect(t.state().completedRequests.p1).toMatchObject({ resolution: 'expired' });
        expect(t.turn.budgetExhausted()).toBe(true);
    });

    it('lifts the wait when a person writes during it', async () => {
        const t = setup('unattended');
        void t.handler.handleToolCall('call-1', 'CodexBash', {});

        t.turn.inputArrived('human');
        await vi.advanceTimersByTimeAsync(120 * MINUTE);

        expect(t.state().requests['call-1']).toBeDefined();
        expect(t.state().requests['call-1'].expiresAt).toBeUndefined();
    });

    it('drops every timer on stop, reset and shutdown', async () => {
        for (const settle of ['abort', 'reset', 'shutdown'] as const) {
            const t = setup('unattended');
            const pending = t.handler.handleToolCall('call-1', 'CodexBash', {});
            void pending.catch(() => { });
            if (settle === 'abort') t.handler.abortAll();
            else if (settle === 'reset') t.handler.reset();
            else t.handler.closeForShutdown();
            expect(vi.getTimerCount()).toBe(0);
        }
    });
});

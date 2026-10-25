/**
 * The unattended wait on Claude permission prompts (aplus-dev-studio
 * specs/codexcli-approval-session-binding R10·R13·Q2·Q6, tasks T21·T22·T23).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import { TurnAttendanceState, unattendedExpiryMessage, type TurnAttendance } from '@/api/turnAttendance';
import type { Session } from '../session';
import type { EnhancedMode } from '../loop';

const MINUTE = 60_000;
const START = 1_000_000;

type State = {
    requests?: Record<string, Record<string, unknown>>;
    completedRequests?: Record<string, Record<string, unknown>>;
};

function setup(attendance: TurnAttendance) {
    const handlers = new Map<string, (message: any) => Promise<any>>();
    let agentState: State = {};
    const pushes: unknown[] = [];
    const session = {
        client: {
            sessionId: 'session-under-test',
            rpcHandlerManager: { registerHandler: (name: string, fn: (message: any) => Promise<any>) => { handlers.set(name, fn); } },
            updateAgentState: (updater: (state: any) => any) => { agentState = updater(agentState); },
            getMetadata: () => ({}),
        },
        api: { push: () => ({ sendSessionNotification: (n: unknown) => { pushes.push(n); } }) },
    } as unknown as Session;
    const state = new TurnAttendanceState();
    state.beginTurn(attendance);
    const handler = new PermissionHandler(session);
    handler.setAttendance(state);
    const raise = (id: string, tool = 'Bash') => {
        const pending = handler.handleToolCall(tool, { command: 'ls' }, { permissionMode: 'default' } as EnhancedMode, {
            signal: new AbortController().signal, toolUseID: id,
        });
        pending.catch(() => { });
        return pending;
    };
    return { handler, state, raise, answer: (m: unknown) => handlers.get('permission')!(m), agentState: () => agentState, pushes };
}

describe('Claude permission prompts in an unattended turn', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
    afterEach(() => { vi.useRealTimers(); });

    it('declines a prompt nobody answered within 30 minutes and keeps the turn going', async () => {
        const t = setup('unattended');
        const pending = t.raise('toolu_1');
        expect(t.agentState().requests?.toolu_1).toMatchObject({ createdAt: START, expiresAt: START + 30 * MINUTE });

        await vi.advanceTimersByTimeAsync(30 * MINUTE);

        await expect(pending).resolves.toEqual({ behavior: 'deny', message: unattendedExpiryMessage() });
        expect(t.agentState().requests).toEqual({});
        expect(t.agentState().completedRequests?.toolu_1).toMatchObject({ status: 'denied', resolution: 'expired', reason: unattendedExpiryMessage() });
        // Not a person's "stop": the turn is not ended by it (Q2).
        expect(t.handler.isAborted('toolu_1')).toBe(false);
        expect(await t.answer({ id: 'toolu_1', approved: true })).toEqual({ applied: false, reason: 'expired' });
    });

    it('lets an answer at 29:59 win (R13)', async () => {
        const t = setup('unattended');
        const pending = t.raise('toolu_1');
        await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);

        expect(await t.answer({ id: 'toolu_1', approved: true })).toEqual({ applied: true });
        await vi.advanceTimersByTimeAsync(10 * MINUTE);

        await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
        expect(t.agentState().completedRequests?.toolu_1).toMatchObject({ status: 'approved', resolution: 'answered' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('applies exactly one of an answer and the expiry landing on the same tick', async () => {
        const t = setup('unattended');
        const pending = t.raise('toolu_1');
        let lateAck: unknown;
        setTimeout(() => { void t.answer({ id: 'toolu_1', approved: true }).then((ack) => { lateAck = ack; }); }, 30 * MINUTE);

        await vi.advanceTimersByTimeAsync(30 * MINUTE);

        await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
        expect(lateAck).toEqual({ applied: false, reason: 'expired' });
        expect(t.agentState().completedRequests?.toolu_1).toMatchObject({ resolution: 'expired' });
    });

    it('declines the next prompt of the same turn at once, without a card or a push (Q6)', async () => {
        const t = setup('unattended');
        t.raise('toolu_1');
        await vi.advanceTimersByTimeAsync(30 * MINUTE);
        const pushesBefore = t.pushes.length;

        const second = t.raise('toolu_plan', 'ExitPlanMode');

        await expect(second).resolves.toMatchObject({ behavior: 'deny' });
        expect(t.agentState().requests?.toolu_plan).toBeUndefined();
        expect(t.agentState().completedRequests?.toolu_plan).toMatchObject({ tool: 'ExitPlanMode', status: 'denied', resolution: 'expired' });
        expect(t.pushes.length).toBe(pushesBefore);
    });

    it('waits without limit in an attended turn', async () => {
        const t = setup('attended');
        t.raise('toolu_1');
        expect(t.agentState().requests?.toolu_1?.expiresAt).toBeUndefined();

        await vi.advanceTimersByTimeAsync(120 * MINUTE);

        expect(t.agentState().requests?.toolu_1).toBeDefined();
    });

    it('lifts the wait when a person writes during it and takes the countdown off the card', async () => {
        const t = setup('unattended');
        t.raise('toolu_1');

        t.state.inputArrived('human');
        await vi.advanceTimersByTimeAsync(120 * MINUTE);

        expect(t.agentState().requests?.toolu_1).toBeDefined();
        expect(t.agentState().requests?.toolu_1?.expiresAt).toBeUndefined();
    });

    it('keeps the wait running for a daemon follow-up', async () => {
        const t = setup('unattended');
        const pending = t.raise('toolu_1');

        t.state.inputArrived('unattended');
        await vi.advanceTimersByTimeAsync(30 * MINUTE);

        await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('drops every timer on reset', async () => {
        const t = setup('unattended');
        t.raise('toolu_1');
        t.raise('toolu_2');

        t.handler.reset('Session switched to local mode', 'generation-ended');

        expect(vi.getTimerCount()).toBe(0);
        expect(t.agentState().completedRequests?.toolu_1).toMatchObject({ resolution: 'generation-ended' });
    });

    it('withdraws the messenger buttons with the existing `aborted` reason (T23)', async () => {
        const t = setup('channel');
        const withdrawn: string[] = [];
        t.handler.setChannelObservationPublisher({ raised: () => { }, withdrawn: (_o, reason) => { withdrawn.push(reason); } });
        t.raise('toolu_1');
        t.handler.bindChannelPermission({
            permissionId: 'toolu_1', toolName: 'Bash', instanceSeq: 1, turnId: 'turn-1', channelRequestId: 'req-1', runtimeId: 'rt',
        });

        await vi.advanceTimersByTimeAsync(30 * MINUTE);

        expect(withdrawn).toEqual(['aborted']);
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalExpiryTimers } from './approvalExpiry';
import { TurnAttendanceState } from '@/api/turnAttendance';

const MINUTE = 60_000;

describe('ApprovalExpiryTimers', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
    afterEach(() => { vi.useRealTimers(); });

    function setup(attendance: TurnAttendanceState | null) {
        const onReleased = vi.fn();
        const timers = new ApprovalExpiryTimers({ onReleased, timeoutMs: 30 * MINUTE });
        timers.setAttendance(attendance);
        return { timers, onReleased };
    }

    it('waits without limit when no attendance is wired or the turn is attended', () => {
        const expire = vi.fn();
        expect(setup(null).timers.arm('a', { policy: false }, expire)).toEqual({ kind: 'unlimited' });
        const attended = new TurnAttendanceState();
        attended.beginTurn('attended');
        expect(setup(attended).timers.arm('a', { policy: false }, expire)).toEqual({ kind: 'unlimited' });
        vi.advanceTimersByTime(60 * MINUTE);
        expect(expire).not.toHaveBeenCalled();
    });

    it('puts no second timer on a tool policy prompt (review #8)', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        expect(setup(state).timers.arm('p', { policy: true }, vi.fn())).toEqual({ kind: 'unlimited' });
    });

    it.each(['unattended', 'channel'] as const)('expires a %s prompt after 30 minutes, not a moment before', (kind) => {
        const state = new TurnAttendanceState();
        state.beginTurn(kind);
        const { timers } = setup(state);
        const expire = vi.fn();

        expect(timers.arm('a', { policy: false }, expire)).toEqual({ kind: 'timed', expiresAt: 1_000_000 + 30 * MINUTE });
        vi.advanceTimersByTime(30 * MINUTE - 1);
        expect(expire).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(expire).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not expire a prompt settled first, and leaks no timer', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        const { timers } = setup(state);
        const expire = vi.fn();
        timers.arm('a', { policy: false }, expire);

        vi.advanceTimersByTime(29 * MINUTE + 59_000);
        timers.clear('a');
        vi.advanceTimersByTime(10 * MINUTE);

        expect(expire).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(state.budgetExhausted()).toBe(false);
    });

    it('declines the next prompt of the same turn at once after one expired (Q6)', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        const { timers } = setup(state);
        timers.arm('a', { policy: false }, vi.fn());
        vi.advanceTimersByTime(30 * MINUTE);

        expect(timers.arm('b', { policy: false }, vi.fn())).toEqual({ kind: 'decline-now' });
        state.beginTurn('unattended');
        expect(timers.arm('c', { policy: false }, vi.fn())).toMatchObject({ kind: 'timed' });
    });

    it('lifts every running wait when a person arrives and says which ones', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        const { timers, onReleased } = setup(state);
        const expire = vi.fn();
        timers.arm('a', { policy: false }, expire);
        timers.arm('b', { policy: false }, expire);

        state.inputArrived('human');
        vi.advanceTimersByTime(60 * MINUTE);

        expect(expire).not.toHaveBeenCalled();
        expect(onReleased).toHaveBeenCalledWith(['a', 'b']);
        // The rest of the turn is attended now.
        expect(timers.arm('c', { policy: false }, expire)).toEqual({ kind: 'unlimited' });
    });

    it('keeps waits running for a daemon follow-up, a quality gate or a messenger relay', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        const { timers } = setup(state);
        const expire = vi.fn();
        timers.arm('a', { policy: false }, expire);

        state.inputArrived('unattended');
        state.inputArrived('automatic');
        vi.advanceTimersByTime(30 * MINUTE);

        expect(expire).toHaveBeenCalledTimes(1);
    });

    it('spends the budget for a timed-out policy prompt only in a waited-on turn', () => {
        const attended = new TurnAttendanceState();
        attended.beginTurn('attended');
        setup(attended).timers.spendBudget();
        expect(attended.budgetExhausted()).toBe(false);

        const channel = new TurnAttendanceState();
        channel.beginTurn('channel');
        setup(channel).timers.spendBudget();
        expect(channel.budgetExhausted()).toBe(true);
    });

    it('stops listening to a previous attendance', () => {
        const first = new TurnAttendanceState();
        first.beginTurn('unattended');
        const { timers, onReleased } = setup(first);
        timers.arm('a', { policy: false }, vi.fn());
        timers.setAttendance(new TurnAttendanceState());

        first.inputArrived('human');

        expect(onReleased).not.toHaveBeenCalled();
    });
});

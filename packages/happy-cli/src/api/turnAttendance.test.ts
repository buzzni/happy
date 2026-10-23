import { describe, expect, it, vi } from 'vitest';
import {
    consumeDelegatedAttendance,
    delegatedAttendanceFor,
    initialPromptAttendance,
    inputAttendanceFromMeta,
    turnAttendance,
    TurnAttendanceState,
    unattendedExpiryMessage,
    UNATTENDED_APPROVAL_TIMEOUT_MS,
} from './turnAttendance';
import { APPROVAL_TIMEOUT_MS } from '@/toolPolicy/policyGate';

describe('inputAttendanceFromMeta (spec R10a, plan §3.4)', () => {
    it.each([
        // Nobody is watching.
        [{ turnTrigger: 'schedule' }, 'unattended'],
        [{ turnTrigger: 'github-trigger' }, 'unattended'],
        [{ sentFrom: 'automation' }, 'unattended'],
        [{ delegatedAttendance: 'unattended' }, 'unattended'],
        // Inside a person's conversation, on their behalf.
        [{ turnTrigger: 'autopilot' }, 'automatic'],
        [{ turnTrigger: 'self-review' }, 'automatic'],
        [{ turnTrigger: 'pr-follow-through' }, 'automatic'],
        [{ turnTrigger: 'agent' }, 'automatic'],
        // A fan-out quality pipeline round or stage session a person started (desktop-turn-trigger-tags R2).
        [{ turnTrigger: 'automation' }, 'automatic'],
        [{ sentFrom: 'happy-agent' }, 'automatic'],
        [{ sentFrom: 'daemon', source: 'autonomous-quality-gate' }, 'automatic'],
        [{ sentFrom: 'daemon', source: 'agent-browser' }, 'automatic'],
        [{ delegatedAttendance: 'attended' }, 'automatic'],
        // A person.
        [{ turnTrigger: 'user' }, 'human'],
        [{ sentFrom: 'web' }, 'human'],
        [{ sentFrom: 'ios' }, 'human'],
        [{ sentFrom: 'daemon', source: 'byos-offline' }, 'human'],
        [{}, 'human'],
        [undefined, 'human'],
        [{ turnTrigger: 'something-new' }, 'human'],
        [{ delegatedAttendance: 'bogus', turnTrigger: 'schedule' }, 'unattended'],
    ] as const)('reads %j as %s', (meta, expected) => {
        expect(inputAttendanceFromMeta(meta)).toBe(expected);
    });

    it.each([
        // A fallback retry into an automation's own session whose source Desktop did not know.
        ['schedule', 'unattended'],
        ['github-trigger', 'unattended'],
        // A fan-out pipeline round or stage session: a person started the pipeline (I7 review H2).
        ['fanout', 'automatic'],
        ['user', 'automatic'],
        ['channel', 'automatic'],
        [undefined, 'automatic'],
        ['something-new', 'automatic'],
    ] as const)('reads an automation turn in a session started by %s as %s', (sessionSource, expected) => {
        expect(inputAttendanceFromMeta({ turnTrigger: 'automation' }, sessionSource)).toBe(expected);
    });

    it('lets the session source decide only an automation turn', () => {
        expect(inputAttendanceFromMeta({ turnTrigger: 'user' }, 'schedule')).toBe('human');
        expect(inputAttendanceFromMeta({}, 'schedule')).toBe('human');
        expect(inputAttendanceFromMeta({ turnTrigger: 'autopilot' }, 'github-trigger')).toBe('automatic');
        expect(inputAttendanceFromMeta({ turnTrigger: 'schedule' }, 'fanout')).toBe('unattended');
        expect(inputAttendanceFromMeta({ sentFrom: 'automation' }, 'fanout')).toBe('unattended');
    });

    it('lets a delegated parent decide over the turn trigger the child message also carries', () => {
        expect(inputAttendanceFromMeta({ turnTrigger: 'agent', delegatedAttendance: 'unattended' })).toBe('unattended');
        expect(inputAttendanceFromMeta({ turnTrigger: 'schedule', delegatedAttendance: 'attended' })).toBe('automatic');
    });

    it('reads only fields the message itself carries', () => {
        const inherited = Object.create({ turnTrigger: 'schedule' });
        expect(inputAttendanceFromMeta(inherited)).toBe('human');
    });
});

describe('turnAttendance', () => {
    it('is unattended for a run-once session whatever its meta', () => {
        expect(turnAttendance({ runOnce: true, allUnattended: false, channel: false })).toBe('unattended');
        expect(turnAttendance({ runOnce: true, allUnattended: false, channel: true })).toBe('unattended');
    });

    it('is channel for a messenger turn', () => {
        expect(turnAttendance({ runOnce: false, allUnattended: false, channel: true })).toBe('channel');
    });

    it('is unattended only when every batched input was', () => {
        expect(turnAttendance({ runOnce: false, allUnattended: true, channel: false })).toBe('unattended');
        expect(turnAttendance({ runOnce: false, allUnattended: false, channel: false })).toBe('attended');
    });
});

describe('TurnAttendanceState', () => {
    it('starts attended, or unattended for a run-once session', () => {
        expect(new TurnAttendanceState().current()).toBe('attended');
        expect(new TurnAttendanceState(true).current()).toBe('unattended');
    });

    it('lifts the wait only for a person', () => {
        const state = new TurnAttendanceState();
        const released = vi.fn();
        state.onRelease(released);
        state.beginTurn('unattended');

        state.inputArrived('automatic');
        state.inputArrived('unattended');
        expect(state.current()).toBe('unattended');
        expect(released).not.toHaveBeenCalled();

        state.inputArrived('human');
        expect(state.current()).toBe('attended');
        expect(released).toHaveBeenCalledTimes(1);

        state.inputArrived('human');
        expect(released).toHaveBeenCalledTimes(1);
    });

    it('lifts a messenger turn for a person at Desktop too', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('channel');
        state.inputArrived('human');
        expect(state.current()).toBe('attended');
    });

    it('classifies the batch that becomes the running turn', () => {
        const state = new TurnAttendanceState();
        expect(state.startTurn({ allUnattended: true, channel: false })).toBe('unattended');
        expect(state.startTurn({ allUnattended: false, channel: true })).toBe('channel');
        expect(state.startTurn({ channel: false })).toBe('attended');
        expect(new TurnAttendanceState(true).startTurn({ allUnattended: false, channel: false })).toBe('unattended');
    });

    it('gives each turn one wait budget', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        state.spendBudget();
        expect(state.budgetExhausted()).toBe(true);
        state.beginTurn('unattended');
        expect(state.budgetExhausted()).toBe(false);
    });

    it('keeps the policy gate unattended for a run-once session even after a person arrives (Q9)', () => {
        const once = new TurnAttendanceState(true);
        once.inputArrived('human');
        expect(once.policyUnattended()).toBe(true);

        const scheduled = new TurnAttendanceState();
        scheduled.beginTurn('unattended');
        expect(scheduled.policyUnattended()).toBe(true);
        scheduled.inputArrived('human');
        expect(scheduled.policyUnattended()).toBe(false);
        scheduled.beginTurn('channel');
        expect(scheduled.policyUnattended()).toBe(false);
        // A messenger turn whose wait ran out declines its next ask at once (Q6).
        scheduled.spendBudget();
        expect(scheduled.policyUnattended()).toBe(true);
    });

    it('keeps an unattended turn unattended across an automatic continuation', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        expect(state.continuationInput()).toBe('unattended');
        expect(state.startTurn({ allUnattended: true, channel: false })).toBe('unattended');
        state.beginTurn('attended');
        expect(state.continuationInput()).toBeUndefined();
    });

    it('carries a spent wait budget into the continuation of the same turn (Q6, I7 review #6)', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        state.spendBudget();
        state.continuationInput();
        state.startTurn({ allUnattended: true, channel: false });
        expect(state.budgetExhausted()).toBe(true);
        // A turn that is not a continuation gets its own budget.
        state.startTurn({ allUnattended: true, channel: false });
        expect(state.budgetExhausted()).toBe(false);
    });

    it('gives a continuation queued before any expiry the budget it had', () => {
        const state = new TurnAttendanceState();
        state.beginTurn('unattended');
        state.continuationInput();
        state.startTurn({ allUnattended: true, channel: false });
        expect(state.budgetExhausted()).toBe(false);
    });
});

describe('unattendedExpiryMessage (T22)', () => {
    it('shares the policy approval timeout', () => {
        expect(UNATTENDED_APPROVAL_TIMEOUT_MS).toBe(APPROVAL_TIMEOUT_MS);
    });

    it('tells the model not to work around the refusal and to report what it needed', () => {
        expect(unattendedExpiryMessage()).toBe(
            'No human responded within 30 minutes, so this request was declined automatically. '
            + 'Do not work around it with another command or tool for the same purpose. '
            + 'Finish what you can without it and report what you needed.',
        );
    });
});

describe('delegation (spec R12)', () => {
    it('hands an unattended or messenger parent\'s child an unattended turn, and a person\'s child an attended one', () => {
        expect(delegatedAttendanceFor('unattended')).toBe('unattended');
        expect(delegatedAttendanceFor('channel')).toBe('unattended');
        expect(delegatedAttendanceFor('attended')).toBe('attended');
    });

    it('reads the spawned child\'s value once and keeps it from its own children', () => {
        const env: NodeJS.ProcessEnv = { SAYCODE_DELEGATED_ATTENDANCE: 'unattended' };
        expect(consumeDelegatedAttendance(env)).toBe('unattended');
        expect(env.SAYCODE_DELEGATED_ATTENDANCE).toBeUndefined();
        expect(consumeDelegatedAttendance({ SAYCODE_DELEGATED_ATTENDANCE: 'whatever' })).toBeNull();
        expect(consumeDelegatedAttendance({})).toBeNull();
    });

    it('classifies the first prompt by it, and leaves it unmarked when nothing is known', () => {
        expect(initialPromptAttendance('unattended')).toBe('unattended');
        expect(initialPromptAttendance('attended')).toBe('automatic');
        expect(initialPromptAttendance(null)).toBeUndefined();
    });
});

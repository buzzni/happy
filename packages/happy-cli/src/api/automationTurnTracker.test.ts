import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';

import { AutomationTurnTracker, automationRunIdFromLocalKey, AUTOMATION_TURN_ANSWER_MAX_CHARS } from './automationTurnTracker';

const start = (turn: string): SessionEnvelope => createEnvelope('agent', { t: 'turn-start' }, { turn });
const cancelled = (runId: string) => ({ runId, status: 'cancelled', finalAnswer: null, silent: false });
const end = (turn: string, status: 'completed' | 'failed' | 'cancelled' = 'completed'): SessionEnvelope =>
    createEnvelope('agent', { t: 'turn-end', status }, { turn });

describe('automationRunIdFromLocalKey', () => {
    it('reads the run only from the key the daemon stamps on a scheduled prompt', () => {
        expect(automationRunIdFromLocalKey('happy-automation:run-1')).toBe('run-1');
        expect(automationRunIdFromLocalKey('happy-automation:')).toBeNull();
        expect(automationRunIdFromLocalKey('local-123')).toBeNull();
        expect(automationRunIdFromLocalKey(undefined)).toBeNull();
    });
});

describe('AutomationTurnTracker', () => {
    it('reports the turn that answered the scheduled prompt with its final answer', () => {
        const tracker = new AutomationTurnTracker();
        tracker.arm('run-1');
        expect(tracker.observe(start('t1'))).toBeNull();
        tracker.noteFinalAnswer('Three new issues today.');
        expect(tracker.observe(end('t1'))).toEqual({
            runId: 'run-1', status: 'completed', finalAnswer: 'Three new issues today.', silent: false,
        });
        // One answer per run.
        expect(tracker.observe(end('t1'))).toBeNull();
    });

    it('does not attribute the turn that was already running when the prompt arrived', () => {
        const tracker = new AutomationTurnTracker();
        tracker.observe(start('busy'));
        tracker.arm('run-1');
        tracker.noteFinalAnswer('the earlier request');
        expect(tracker.observe(end('busy'))).toBeNull();
        tracker.observe(start('t2'));
        tracker.noteFinalAnswer('the scheduled answer');
        expect(tracker.observe(end('t2'))?.finalAnswer).toBe('the scheduled answer');
    });

    it('reports a failed or cancelled turn without an answer', () => {
        const tracker = new AutomationTurnTracker();
        tracker.arm('run-1');
        tracker.observe(start('t1'));
        expect(tracker.observe(end('t1', 'failed'))).toEqual({ runId: 'run-1', status: 'failed', finalAnswer: null, silent: false });
    });

    it('marks a [SILENT] answer and never carries its text', () => {
        const tracker = new AutomationTurnTracker();
        tracker.arm('run-1');
        tracker.observe(start('t1'));
        tracker.noteFinalAnswer('Nothing changed.\n[SILENT]');
        expect(tracker.observe(end('t1'))).toEqual({ runId: 'run-1', status: 'completed', finalAnswer: null, silent: true });
    });

    it('cuts a long answer to the delivery limit', () => {
        const tracker = new AutomationTurnTracker();
        tracker.arm('run-1');
        tracker.observe(start('t1'));
        tracker.noteFinalAnswer('가'.repeat(AUTOMATION_TURN_ANSWER_MAX_CHARS + 50));
        const answer = tracker.observe(end('t1'))?.finalAnswer ?? '';
        expect(Array.from(answer)).toHaveLength(AUTOMATION_TURN_ANSWER_MAX_CHARS);
        expect(answer.endsWith('…')).toBe(true);
    });

    it('ignores subagent turns and answers outside the tracked turn', () => {
        const tracker = new AutomationTurnTracker();
        tracker.arm('run-1');
        tracker.noteFinalAnswer('before any turn');
        tracker.observe(createEnvelope('agent', { t: 'turn-start' }, { turn: 'sub', subagent: 'ckv0d1a2b0000z9zz9zz9zz9z' }));
        tracker.observe(start('t1'));
        expect(tracker.observe(end('t1'))).toEqual({ runId: 'run-1', status: 'completed', finalAnswer: null, silent: false });
    });

    it('sends neither of two scheduled prompts that queue up before either one starts — one turn may answer both', () => {
        const tracker = new AutomationTurnTracker();
        expect(tracker.arm('run-1')).toEqual([]);
        expect(tracker.arm('run-2')).toEqual([cancelled('run-1'), cancelled('run-2')]);
        tracker.observe(start('t1'));
        tracker.noteFinalAnswer('both answered together');
        expect(tracker.observe(end('t1'))).toBeNull();
    });

    it('does not take a turn that answers user input queued ahead of the scheduled prompt for the scheduled run', () => {
        const tracker = new AutomationTurnTracker();
        tracker.observe(start('busy'));
        expect(tracker.userInput()).toEqual([]);
        // The scheduled prompt waits behind the user's message; which turn answers it is unknowable.
        expect(tracker.arm('run-1')).toEqual([cancelled('run-1')]);
        tracker.observe(end('busy'));
        tracker.observe(start('t2'));
        tracker.noteFinalAnswer("the answer to the user's own message");
        expect(tracker.observe(end('t2'))).toBeNull();
    });

    it('drops the scheduled run when user input arrives before its turn starts, since both may go in one turn', () => {
        const tracker = new AutomationTurnTracker();
        tracker.observe(start('busy'));
        tracker.arm('run-1');
        expect(tracker.userInput()).toEqual([cancelled('run-1')]);
        tracker.observe(end('busy'));
        tracker.observe(start('t2'));
        expect(tracker.observe(end('t2'))).toBeNull();
    });

    it('tracks scheduled prompts again once the engine says no input is waiting', () => {
        const tracker = new AutomationTurnTracker();
        // Two messages answered in one turn: the tracker cannot tell the queue is empty by itself.
        tracker.userInput();
        tracker.userInput();
        tracker.observe(start('t1'));
        tracker.observe(end('t1'));
        expect(tracker.arm('run-1')).toEqual([cancelled('run-1')]);
        tracker.inputQueueEmpty();
        expect(tracker.arm('run-2')).toEqual([]);
        tracker.observe(start('t2'));
        tracker.noteFinalAnswer('the scheduled answer');
        expect(tracker.observe(end('t2'))?.runId).toBe('run-2');
    });

    it('tracks a scheduled prompt normally after earlier user input already started its own turn', () => {
        const tracker = new AutomationTurnTracker();
        tracker.userInput();
        tracker.observe(start('t1'));
        expect(tracker.arm('run-1')).toEqual([]);
        tracker.observe(end('t1'));
        tracker.observe(start('t2'));
        expect(tracker.observe(end('t2'))?.runId).toBe('run-1');
    });

    it('follows a failed turn into the automatic retry of a temporary API failure (H9a)', () => {
        const tracker = new AutomationTurnTracker();
        tracker.arm('run-1');
        tracker.observe(start('t1'));
        const failed = tracker.observe(end('t1', 'failed'))!;
        tracker.carry(failed);
        tracker.observe(start('t2'));
        tracker.noteFinalAnswer('Recovered.');
        expect(tracker.observe(end('t2'))).toEqual({ runId: 'run-1', status: 'completed', finalAnswer: 'Recovered.', silent: false });
    });

    it('settles a carried failure when the user or another scheduled prompt replaces the retry', () => {
        const tracker = new AutomationTurnTracker();
        tracker.arm('run-1');
        tracker.observe(start('t1'));
        tracker.carry(tracker.observe(end('t1', 'failed'))!);
        expect(tracker.userInput()).toEqual([{ runId: 'run-1', status: 'failed', finalAnswer: null, silent: false }]);
        expect(tracker.userInput()).toEqual([]);
        tracker.inputQueueEmpty();

        tracker.arm('run-2');
        tracker.observe(start('t2'));
        tracker.carry(tracker.observe(end('t2', 'failed'))!);
        expect(tracker.arm('run-3')).toEqual([{ runId: 'run-2', status: 'failed', finalAnswer: null, silent: false }]);
    });
});


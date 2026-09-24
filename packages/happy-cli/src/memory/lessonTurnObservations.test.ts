import { describe, expect, it } from 'vitest';
import { createLessonTurnObservations } from './lessonTurnObservations';

describe('verified lesson recovery evidence', () => {
    it('does not use an unknown or cancelled exit to verify recovery', () => {
        const observations = createLessonTurnObservations();
        observations.commandEnded({ command: 'npm test', cwd: '/a', exitCode: 1, status: 'completed' });
        observations.commandEnded({ command: 'npm test', cwd: '/a', exitCode: null, status: 'completed' });
        observations.commandEnded({ command: 'npm test', cwd: '/a', exitCode: 0, status: 'cancelled' });
        expect(observations.take().recoveredFailures).toEqual([]);
    });

    it('keeps parallel call identities and directories separate', () => {
        const observations = createLessonTurnObservations();
        observations.commandStarted({ callId: 'a', command: 'npm test', cwd: '/a' });
        observations.commandStarted({ callId: 'b', command: 'npm test', cwd: '/b' });
        observations.commandEnded({ callId: 'a', exitCode: 1, status: 'completed' });
        observations.commandEnded({ callId: 'b', exitCode: 0, status: 'completed' });
        expect(observations.take().recoveredFailures).toEqual([]);
    });

    it('pairs a recovery with its actual command completion', () => {
        const observations = createLessonTurnObservations();
        observations.commandEnded({ command: 'npm test', cwd: '/a', exitCode: 1, status: 'completed' });
        observations.commandStarted({ callId: 'check', command: 'npm test', cwd: '/a' });
        observations.commandStarted({ callId: 'other', command: 'npm --version', cwd: '/a' });
        observations.commandEnded({ callId: 'check', exitCode: 0, status: 'completed' });
        observations.commandEnded({ callId: 'other', exitCode: 0, status: 'completed' });
        expect(observations.take().recoveredFailures).toEqual(['npm test']);
    });

    it('does not invent a failure from two successful commands', () => {
        const observations = createLessonTurnObservations();
        observations.commandStarted('npm test');
        observations.commandEnded({ failed: false });
        observations.commandStarted('npm test');
        observations.commandEnded({ failed: false });
        expect(observations.take().recoveredFailures).toEqual([]);
    });

    it('does not treat an unrelated successful command as verification of a failure', () => {
        const observations = createLessonTurnObservations();
        observations.commandStarted('npm test');
        observations.commandEnded({ failed: true, detail: 'Regression assertion failed' });
        observations.commandStarted('npm --version');
        observations.commandEnded({ failed: false });
        expect(observations.take().recoveredFailures).toEqual([]);
    });

    it('retains an actual failed check followed by that check succeeding', () => {
        const observations = createLessonTurnObservations();
        observations.commandStarted('npm test');
        observations.commandEnded({ failed: true, detail: 'Regression assertion failed' });
        observations.commandStarted('npm test');
        observations.commandEnded({ failed: false });
        const result = observations.take();
        expect(result.recoveredFailures).toHaveLength(1);
        expect(result.recoveredFailures[0]).toContain('npm test');
        expect(observations.take().recoveredFailures).toEqual([]);
    });
});

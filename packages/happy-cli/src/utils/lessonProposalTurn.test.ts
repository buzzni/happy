import { logger } from '@/ui/logger';
import { describe, expect, it, vi } from 'vitest';
import { createLessonProposalTurn } from './lessonProposalTurn';
const tokenOf = (text: string) => text.match(/token="([^"]+)"/)![1];
describe('lesson proposal turn', () => {
    it('reports timeout without logging the turn or issuing a late token', async () => {
        vi.useFakeTimers();
        const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        try {
            const state = createLessonProposalTurn();
            let complete!: (value: { revision: number }) => void;
            const preparing = state.prepare('private-turn', () => new Promise(resolve => { complete = resolve; }));
            await vi.advanceTimersByTimeAsync(1000);
            expect(await preparing).toBe('');
            expect(log).toHaveBeenCalledWith('[lesson-review-prepare] timeout');
            complete({ revision: 1 });
            await Promise.resolve();
            expect(state.submit({ token: 'late', proposal: {} }).accepted).toBe(false);
            expect(JSON.stringify(log.mock.calls)).not.toContain('private-turn');
        } finally { log.mockRestore(); vi.useRealTimers(); }
    });
    it('consumes a current proposal once with its settings revision', () => {
        const state = createLessonProposalTurn();
        const token = tokenOf(state.begin('turn', 7));
        expect(state.submit({ token, proposal: { name: 'verified' } })).toEqual({ accepted: true });
        expect(state.submit({ token, proposal: {} }).accepted).toBe(false);
        expect(state.take('turn')).toEqual({ proposal: { name: 'verified' }, settingsRevision: 7 });
        expect(state.take('turn')).toEqual({});
    });
    it('rejects previous, cancelled and oversized submissions', () => {
        const state = createLessonProposalTurn();
        const old = tokenOf(state.begin('old', 1));
        const token = tokenOf(state.begin('new', 2));
        expect(state.submit({ token: old, proposal: {} }).accepted).toBe(false);
        expect(state.submit({ token, proposal: { text: 'x'.repeat(17000) } }).accepted).toBe(false);
        state.cancel();
        expect(state.submit({ token, proposal: {} }).accepted).toBe(false);
    });
    it('cannot reopen a cancelled turn when authorization arrives late', async () => {
        const state = createLessonProposalTurn();
        let resolve!: (value: { revision: number }) => void;
        const preparing = state.prepare('old', () => new Promise(done => { resolve = done; }));
        state.cancel();
        const current = tokenOf(state.begin('current', 2));
        resolve({ revision: 1 });
        expect(await preparing).toBe('');
        expect(state.submit({ token: current, proposal: {} }).accepted).toBe(true);
    });
    it('discards a mismatched completion instead of attaching it to the next turn', () => {
        const state = createLessonProposalTurn();
        const token = tokenOf(state.begin('turn', 1));
        state.submit({ token, proposal: {} });
        expect(state.take('different')).toEqual({});
        expect(state.take('turn')).toEqual({});
    });
});

// specs/host-lesson-matching-2026-10-18 P0: prefer revising an existing lesson
// over adding a near-duplicate, and name new lessons by task class.
describe('lesson proposal instruction', () => {
    const START = 'If this turn corrects an earlier mistake or verifies recovery from a failure, you may propose one reusable project lesson before finishing.';
    const END = 'Do not perform extra work just to generate a lesson.';
    it('keeps the boundaries stores strip the wrapper by, as one paragraph', () => {
        for (const lessonUpdates of [true, false]) {
            const text = createLessonProposalTurn().begin('t', 1, { lessonUpdates });
            expect(text.startsWith(START)).toBe(true);
            expect(text.endsWith(END)).toBe(true);
            expect(text).not.toContain('\n');
        }
    });
    it('asks to revise a lesson already in play and to name new lessons by task class', () => {
        const text = createLessonProposalTurn().begin('t', 1, { lessonUpdates: true });
        expect(text).toContain('updatesLesson');
        expect(text).toMatch(/PR or issue number/);
    });
    it('does not offer updatesLesson when the installed store cannot apply it', () => {
        const text = createLessonProposalTurn().begin('t', 1);
        expect(text).not.toContain('updatesLesson');
        expect(text).toMatch(/PR or issue number/);
    });
    it('carries the store capability from prepare into the instruction', async () => {
        const text = await createLessonProposalTurn().prepare('t', async () => ({ revision: 3, lessonUpdates: true }));
        expect(text).toContain('updatesLesson');
    });
});

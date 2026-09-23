import { describe, expect, it } from 'vitest';

import { LESSON_REVIEW_EVIDENCE_BYTE_LIMIT } from './lessonReviewGateway';
import { evaluateLessonTurn, lessonEvidenceKey, type LessonTurnRecord } from './lessonTurnEvidence';

function turn(overrides: Partial<LessonTurnRecord> = {}): LessonTurnRecord {
    return {
        sessionId: 's1',
        turnId: 't1',
        kind: 'foreground',
        endedNormally: true,
        hadPriorAssistantTurn: false,
        userMessages: ['add a retry to the fetch'],
        agentSummary: 'edited fetchUser and ran the tests',
        recoveredFailures: [],
        ...overrides,
    };
}

describe('evaluateLessonTurn', () => {
    it('refuses an aborted turn', () => {
        expect(evaluateLessonTurn(turn({ endedNormally: false }), 'p1'))
            .toEqual({ eligible: false, reason: 'aborted' });
    });

    it('refuses automation and review turns, which are not a person working', () => {
        expect(evaluateLessonTurn(turn({ kind: 'automation' }), 'p1'))
            .toEqual({ eligible: false, reason: 'automation' });
        expect(evaluateLessonTurn(turn({ kind: 'review' }), 'p1'))
            .toEqual({ eligible: false, reason: 'not-foreground' });
    });

    it('refuses a plain success, which teaches nothing new', () => {
        expect(evaluateLessonTurn(turn(), 'p1'))
            .toEqual({ eligible: false, reason: 'no-signal' });
    });

    it('does not read the opening request as a correction', () => {
        // "do not" in the request is the request, not the user turning the
        // agent around; treating it as one would review almost every turn.
        expect(evaluateLessonTurn(turn({ userMessages: ['do not use the cache here'] }), 'p1'))
            .toEqual({ eligible: false, reason: 'no-signal' });
    });

    it('accepts a later message that corrects the agent', () => {
        const decision = evaluateLessonTurn(
            turn({ userMessages: ['add a retry', 'no, revert that and use the existing helper'] }), 'p1',
        );
        expect(decision.eligible).toBe(true);
        expect(decision.eligible && decision.evidence.signal).toBe('user-correction');
    });

    it('accepts a correction that opens the next turn', () => {
        // The commonest shape: the user lets a turn finish, then says "no".
        const decision = evaluateLessonTurn(
            turn({ hadPriorAssistantTurn: true, userMessages: ['no, revert that'] }), 'p1',
        );
        expect(decision.eligible).toBe(true);
        expect(decision.eligible && decision.evidence.signal).toBe('user-correction');
    });

    it('still does not read the very first request of a session as a correction', () => {
        expect(evaluateLessonTurn(
            turn({ hadPriorAssistantTurn: false, userMessages: ['do not use the cache here'] }), 'p1',
        )).toEqual({ eligible: false, reason: 'no-signal' });
    });

    it('accepts a Korean correction', () => {
        const decision = evaluateLessonTurn(
            turn({ userMessages: ['재시도 붙여줘', '아니 그게 아니라 기존 헬퍼를 써'] }), 'p1',
        );
        expect(decision.eligible).toBe(true);
    });

    it('prefers a verified recovery over a correction when both are present', () => {
        const decision = evaluateLessonTurn(turn({
            userMessages: ['add a retry', 'no, not like that'],
            recoveredFailures: ['npm test failed: ECONNRESET'],
        }), 'p1');
        expect(decision.eligible && decision.evidence.signal).toBe('verified-recovery');
    });

    it('accepts a recovery with no correction at all', () => {
        const decision = evaluateLessonTurn(
            turn({ recoveredFailures: ['tsc: TS7016 missing declaration'] }), 'p1',
        );
        expect(decision.eligible && decision.evidence.signal).toBe('verified-recovery');
    });

    it('refuses a correction with nothing observed of what the agent did', () => {
        // Only the user's words. A review of that would describe a procedure
        // it never watched, so it costs nothing and is refused.
        expect(evaluateLessonTurn(turn({
            hadPriorAssistantTurn: true, userMessages: ['no, revert that'], agentSummary: '',
        }), 'p1')).toEqual({ eligible: false, reason: 'no-evidence' });
    });

    it('refuses a turn with nothing in it', () => {
        expect(evaluateLessonTurn(turn({ userMessages: [], agentSummary: '' }), 'p1'))
            .toEqual({ eligible: false, reason: 'empty' });
    });

    it('carries the failures and the summary into the transcript', () => {
        const decision = evaluateLessonTurn(
            turn({ recoveredFailures: ['build failed: out/ missing'] }), 'p1',
        );
        expect(decision.eligible && decision.evidence.transcript).toContain('build failed: out/ missing');
        expect(decision.eligible && decision.evidence.transcript).toContain('edited fetchUser');
    });

    it('bounds the transcript by the gateway\'s own byte budget', () => {
        const decision = evaluateLessonTurn(turn({
            recoveredFailures: [...Array(200)].map((_, index) => `failure ${index} ${'x'.repeat(500)}`),
        }), 'p1');
        expect(decision.eligible
            && Buffer.byteLength(decision.evidence.transcript, 'utf8'))
            .toBeLessThanOrEqual(LESSON_REVIEW_EVIDENCE_BYTE_LIMIT);
    });

    it('keeps Korean evidence inside the budget instead of overflowing it', () => {
        // Three bytes per character: a character-counted limit would produce a
        // transcript the gateway refuses outright as `evidence_budget`.
        const decision = evaluateLessonTurn(turn({
            recoveredFailures: [...Array(100)].map((_, i) => `실패 ${i} ${'가'.repeat(400)}`),
        }), 'p1');
        expect(decision.eligible).toBe(true);
        expect(decision.eligible
            && Buffer.byteLength(decision.evidence.transcript, 'utf8'))
            .toBeLessThanOrEqual(LESSON_REVIEW_EVIDENCE_BYTE_LIMIT);
    });
});

describe('lessonEvidenceKey', () => {
    it('is stable, so a restart re-observing one turn enqueues once', () => {
        const first = evaluateLessonTurn(turn({ recoveredFailures: ['boom'] }), 'p1');
        const second = evaluateLessonTurn(turn({ recoveredFailures: ['boom'] }), 'p1');
        expect(first.eligible && second.eligible
            && first.evidence.evidenceKey === second.evidence.evidenceKey).toBe(true);
    });

    it('separates two different turns in one session', () => {
        const a = evaluateLessonTurn(turn({ recoveredFailures: ['boom'] }), 'p1');
        const b = evaluateLessonTurn(turn({ recoveredFailures: ['different failure'] }), 'p1');
        expect(a.eligible && b.eligible
            && a.evidence.evidenceKey === b.evidence.evidenceKey).toBe(false);
    });

    it('separates the same content across projects and sessions', () => {
        const base = { sessionId: 's1', content: 'same' };
        expect(lessonEvidenceKey({ ...base, projectId: 'p1' }))
            .not.toBe(lessonEvidenceKey({ ...base, projectId: 'p2' }));
        expect(lessonEvidenceKey({ ...base, projectId: 'p1' }))
            .not.toBe(lessonEvidenceKey({ projectId: 'p1', sessionId: 's2', content: 'same' }));
    });
});

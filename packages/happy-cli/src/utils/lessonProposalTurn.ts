import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

/**
 * One paragraph whose first and last sentences stay fixed: CML strips the
 * wrapper from stored prompts by exactly those boundaries.
 *
 * The middle steers toward a small, class-level catalog (specs
 * host-lesson-matching-2026-10-18 P0): revise a lesson already in play before
 * adding one, and name new lessons by the kind of task, not the incident.
 */
function lessonProposalInstruction(token: string, lessonUpdates: boolean): string {
    return 'If this turn corrects an earlier mistake or verifies recovery from a failure, you may propose one reusable project lesson before finishing. '
        + 'Use mcp__happy__propose_lesson with token="' + token + '" and proposal containing name, trigger, steps (string[]), failureModes (string[]), scope, validation (string[]), reconsiderWhen, and optional validVersions (string[]). '
        + (lessonUpdates
            ? 'If a project lesson shown or read in this turn covers the same kind of task, revise that lesson instead of adding a new one: send its full revised text with updatesLesson {lessonId, revision} copied from the lesson block or mem-lesson-get. '
            : '')
        + 'Name a new lesson after the kind of task it governs (for example pr-conflict-resolution), never after a PR or issue number, an error string, a date or today\'s task; keep incident detail in a step or failure mode. '
        + 'Only describe procedures actually verified in this turn. Exclude secrets, copied rules, transient environment failures and one-off narratives. '
        + 'This only stages a candidate for human approval; it never approves a lesson. Skip this optional action if the user disallows tools or saving memory. Do not perform extra work just to generate a lesson.';
}

/** A proposal is untrusted, volatile data until its owning foreground turn ends normally. */
export function createLessonProposalTurn() {
    let epoch = 0;
    let active: { turnId: string; token: string; revision: number; proposal?: unknown } | null = null;
    const state = {
        /** `lessonUpdates`: the installed store can apply a proposal as a revision of an existing lesson. */
        begin(turnId: string, revision: number, options: { lessonUpdates?: boolean } = {}): string {
            active = { turnId, revision, token: randomUUID() };
            return lessonProposalInstruction(active.token, options.lessonUpdates === true);
        },
        submit(input: { token: string; proposal: unknown }): { accepted: boolean } {
            if (!active || input.token !== active.token || active.proposal !== undefined) return { accepted: false };
            try {
                if (!input.proposal || typeof input.proposal !== 'object' || Array.isArray(input.proposal)
                    || Buffer.byteLength(JSON.stringify(input.proposal), 'utf8') > 16_384) return { accepted: false };
                active.proposal = JSON.parse(JSON.stringify(input.proposal));
                return { accepted: true };
            } catch { return { accepted: false }; }
        },
        take(turnId: string): { proposal?: unknown; settingsRevision?: number } {
            const pending = active;
            active = null;
            return pending?.turnId === turnId && pending.proposal !== undefined
                ? { proposal: pending.proposal, settingsRevision: pending.revision } : {};
        },
        cancel(): void { active = null; epoch += 1; },
        async prepare(turnId: string, load: () => Promise<{ revision: number; lessonUpdates?: boolean } | null>): Promise<string> {
            state.cancel();
            const plannedEpoch = epoch;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { logger.debug('[lesson-review-prepare] timeout'); resolve(null); }, 1000); timer.unref?.(); });
            const prepared = await Promise.race([load().catch(() => null), timeout]);
            clearTimeout(timer);
            if (!prepared) return '';
            if (epoch !== plannedEpoch) {
                logger.debug('[lesson-review-prepare] cancelled');
                return '';
            }
            logger.debug('[lesson-review-prepare] ready');
            return state.begin(turnId, prepared.revision, { lessonUpdates: prepared.lessonUpdates });
        },
    };
    return state;
}
export type LessonProposalTurn = ReturnType<typeof createLessonProposalTurn>;

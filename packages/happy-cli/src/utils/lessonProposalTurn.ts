import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

/** A proposal is untrusted, volatile data until its owning foreground turn ends normally. */
export function createLessonProposalTurn() {
    let epoch = 0;
    let active: { turnId: string; token: string; revision: number; proposal?: unknown } | null = null;
    const state = {
        begin(turnId: string, revision: number): string {
            active = { turnId, revision, token: randomUUID() };
            return 'If this turn corrects an earlier mistake or verifies recovery from a failure, you may propose one reusable project lesson before finishing. '
                + 'Use mcp__happy__propose_lesson with token="' + active.token + '" and proposal containing name, trigger, steps (string[]), failureModes (string[]), scope, validation (string[]), reconsiderWhen, and optional validVersions (string[]). '
                + 'Only describe procedures actually verified in this turn. Exclude secrets, copied rules, transient environment failures and one-off narratives. '
                + 'This only stages a candidate for human approval; it never approves a lesson. Skip this optional action if the user disallows tools or saving memory. Do not perform extra work just to generate a lesson.';
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
        async prepare(turnId: string, load: () => Promise<{ revision: number } | null>): Promise<string> {
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
            return state.begin(turnId, prepared.revision);
        },
    };
    return state;
}
export type LessonProposalTurn = ReturnType<typeof createLessonProposalTurn>;

/** specs/desktop-next-steps-card — Codex's built-in plan reaches clients as a `plan` event. */
import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, sessionEventSchema } from '@slopus/happy-wire';
import { codexPlanEvent } from './codexPlanEvent';

describe('codexPlanEvent', () => {
    it('maps both app-server and legacy statuses to the wire statuses', () => {
        const ev = codexPlanEvent({ plan: [
            { step: 'Reproduce the bug', status: 'completed' },
            { step: 'Fix the parser', status: 'inProgress' },
            { step: 'Fix the renderer', status: 'in_progress' },
            { step: 'Run the tests', status: 'pending' },
        ] });
        expect(ev).toEqual({ t: 'plan', steps: [
            { text: 'Reproduce the bug', status: 'completed' },
            { text: 'Fix the parser', status: 'in_progress' },
            { text: 'Fix the renderer', status: 'in_progress' },
            { text: 'Run the tests', status: 'pending' },
        ] });
        expect(sessionEventSchema.safeParse(ev).success).toBe(true);
    });

    it('clips a list the wire cannot carry instead of dropping it', () => {
        const ev = codexPlanEvent({ plan: Array.from({ length: PLAN_LIMITS.steps + 5 }, (_, i) => ({ step: `${i} ${'x'.repeat(PLAN_LIMITS.text)}`, status: 'pending' })) });
        expect(ev?.steps).toHaveLength(PLAN_LIMITS.steps);
        expect(ev?.steps[0].text).toHaveLength(PLAN_LIMITS.text);
        expect(sessionEventSchema.safeParse(ev).success).toBe(true);
    });

    it('skips unreadable steps and yields nothing when none remain', () => {
        expect(codexPlanEvent({ plan: [{ step: '  ', status: 'pending' }, { step: 'x', status: 'blocked' }, null] })).toBeNull();
        expect(codexPlanEvent({})).toBeNull();
    });
});

it('carries an explicitly empty plan as a clear, not a malformed plan', () => {
    expect(codexPlanEvent({ plan: [] })).toEqual({ t: 'plan', steps: [] });
    expect(codexPlanEvent({ plan: [null] })).toBeNull();
});

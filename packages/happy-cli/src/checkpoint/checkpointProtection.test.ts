import { describe, expect, it } from 'vitest';
import { resolveExcludedPathDecision } from './checkpointProtection';

describe('resolveExcludedPathDecision', () => {
    it.each(['cancel', null] as const)(
        'blocks mutation and keeps protection when the decision is %s',
        (decision) => {
            expect(resolveExcludedPathDecision(decision)).toEqual({
                allowMutation: false,
                protection: { status: 'protected' },
            });
        },
    );

    it('allows mutation only after protection is explicitly disabled', () => {
        expect(resolveExcludedPathDecision('disable-protection')).toEqual({
            allowMutation: true,
            protection: {
                status: 'unavailable',
                reason: 'excluded-path',
            },
        });
    });
});

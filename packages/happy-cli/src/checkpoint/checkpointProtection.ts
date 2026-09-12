export type ExcludedPathDecision = 'cancel' | 'disable-protection' | null;

export type ExcludedPathDecisionResult =
    | { allowMutation: false; protection: { status: 'protected' } }
    | {
        allowMutation: true;
        protection: { status: 'unavailable'; reason: 'excluded-path' };
    };

export function resolveExcludedPathDecision(
    decision: ExcludedPathDecision,
): ExcludedPathDecisionResult {
    if (decision === 'disable-protection') {
        return {
            allowMutation: true,
            protection: { status: 'unavailable', reason: 'excluded-path' },
        };
    }

    return {
        allowMutation: false,
        protection: { status: 'protected' },
    };
}

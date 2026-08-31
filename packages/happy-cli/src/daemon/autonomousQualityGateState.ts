export type AutonomousQualityGateStage =
    | 'awaiting-completion'
    | 'verifying'
    | 'repairing'
    | 'unchanged-after-failure'
    | 'passed'
    | 'limit-reached';

export type AutonomousLimitReason =
    | 'max-continuations'
    | 'max-turns'
    | 'max-tokens'
    | 'timeout';

export interface AutonomousGateFailure {
    phase: string;
    exitCode: number | null;
    timedOut: boolean;
}

export interface AutonomousQualityGateState {
    stage: AutonomousQualityGateStage;
    attempt: number;
    lastFailure: AutonomousGateFailure | null;
    limitReason?: AutonomousLimitReason;
}

export type AutonomousQualityGateEvent =
    | { type: 'gate-started' }
    | { type: 'gate-passed' }
    | { type: 'gate-failed'; failure: AutonomousGateFailure }
    | { type: 'worktree-unchanged' }
    | { type: 'limit-reached'; reason: AutonomousLimitReason };

export function createAutonomousQualityGateState(): AutonomousQualityGateState {
    return { stage: 'awaiting-completion', attempt: 0, lastFailure: null };
}

export function reduceAutonomousQualityGateState(
    state: AutonomousQualityGateState,
    event: AutonomousQualityGateEvent,
): AutonomousQualityGateState {
    if (state.stage === 'passed' || state.stage === 'limit-reached') {
        return state;
    }
    if (event.type === 'limit-reached') {
        return { ...state, stage: 'limit-reached', limitReason: event.reason };
    }
    if (event.type === 'gate-started') {
        if (!['awaiting-completion', 'repairing', 'unchanged-after-failure'].includes(state.stage)) {
            return state;
        }
        return { ...state, stage: 'verifying', attempt: state.attempt + 1 };
    }
    if (state.stage === 'verifying' && event.type === 'gate-passed') {
        return { ...state, stage: 'passed' };
    }
    if (state.stage === 'verifying' && event.type === 'gate-failed') {
        return { ...state, stage: 'repairing', lastFailure: event.failure };
    }
    if (state.stage === 'repairing' && event.type === 'worktree-unchanged') {
        return { ...state, stage: 'unchanged-after-failure' };
    }
    return state;
}

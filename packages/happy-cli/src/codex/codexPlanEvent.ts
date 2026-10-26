/**
 * Saycode specs/desktop-next-steps-card — Codex keeps its task list with its built-in
 * `update_plan` tool. app-server reports it as `turn/plan/updated` (statuses `inProgress`),
 * the legacy event stream as `plan_update` (statuses `in_progress`); both arrive here as a
 * `plan_update` event. This turns it into the `plan` session event a client draws under the
 * latest message. A list the wire cannot carry is clipped rather than dropped: the list is
 * a progress view, and losing all of it for one long step would be worse.
 */
import { PLAN_LIMITS, type SessionEvent } from '@slopus/happy-wire';

type PlanStep = Extract<SessionEvent, { t: 'plan' }>['steps'][number];

const STATUS: Record<string, PlanStep['status']> = {
    pending: 'pending',
    in_progress: 'in_progress',
    inProgress: 'in_progress',
    completed: 'completed',
};

export function codexPlanEvent(msg: Record<string, unknown>, inputEvidence = false): Extract<SessionEvent, { t: 'plan' }> | null {
    if (!Array.isArray(msg.plan)) return null;
    const steps: PlanStep[] = [];
    for (const raw of msg.plan as Array<{ step?: unknown; status?: unknown } | null>) {
        const step = typeof raw?.step === 'string' ? raw.step.trim() : '';
        const status = typeof raw?.status === 'string' ? STATUS[raw.status] : undefined;
        if (!step || !status) continue;
        steps.push({ text: step.slice(0, PLAN_LIMITS.text), status });
        if (steps.length === PLAN_LIMITS.steps) break;
    }
    return steps.length > 0 || (inputEvidence && msg.plan.length === 0) ? { t: 'plan', steps } : null;
}

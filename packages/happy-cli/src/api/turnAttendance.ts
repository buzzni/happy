/**
 * Whether anyone can answer the current turn's permission prompts (aplus-dev-studio
 * specs/codexcli-approval-session-binding R10·R10a·R12, plan §3.4).
 *
 * This module is the single owner of that decision. Desktop, the daemon and the messenger host
 * only hand over the facts — each message's meta, whether the session runs once, whether the turn
 * came from a channel, what a delegating parent was — and the tool policy gate reads the result
 * instead of deciding for itself.
 *
 * Three answers:
 * - `unattended`: nobody is there (scheduled runs, GitHub triggers, a fallback retry into one of
 *   their sessions, a child delegated by an unattended or messenger parent). A prompt is declined
 *   after the wait.
 * - `channel`: a messenger turn. Its buttons die after five minutes, so the same wait applies.
 * - `attended`: a person sent it, or something acting inside a person's conversation (autopilot,
 *   self-review, PR follow-through, quality gate, browser attention, a fan-out pipeline a person
 *   started), or we cannot tell. No limit.
 *
 * Anything unknown waits: a wrong `attended` costs a stalled automation, a wrong `unattended`
 * declines a person's prompt behind their back.
 */

import { APPROVAL_TIMEOUT_MS } from '@/toolPolicy/policyGate';

export type TurnAttendance = 'unattended' | 'channel' | 'attended';

/**
 * What one queued input says about its sender.
 * - `unattended`: an input nobody watches; a batch made only of these is an unattended turn.
 * - `automatic`: sent by something on a person's behalf; it makes the turn attended but is not a
 *   person arriving, so it does not lift a running wait.
 * - `human`: a person, here and now; it lifts the current turn's wait.
 */
export type InputAttendance = 'unattended' | 'automatic' | 'human';

/** What a delegating parent passes to its child (R12). A messenger parent's child is `unattended`. */
export type DelegatedAttendance = 'unattended' | 'attended';

/** The wait shares the tool policy approval's value (spec Q1). */
export const UNATTENDED_APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_MS;

/** The variable a delegating parent's broker sets for the bundled agent CLI it runs (R12). */
export const DELEGATED_ATTENDANCE_ENV = 'SAYCODE_DELEGATED_ATTENDANCE';

/** Desktop `meta.turnTrigger` values sent by something nobody watches (Desktop domain/turnTrigger). */
const UNATTENDED_TURN_TRIGGERS: ReadonlySet<string> = new Set(['schedule', 'github-trigger']);
/** Sent on a person's behalf inside their conversation: attended, but not a person arriving. */
const AUTOMATIC_TURN_TRIGGERS: ReadonlySet<string> = new Set(['autopilot', 'self-review', 'pr-follow-through', 'agent']);
/**
 * Desktop writes `automation` for two things (desktop-turn-trigger-tags R2): the rounds and stage
 * sessions of a fan-out quality pipeline a person started, and a model fallback retry into an
 * automation's session whose source it did not know. Only the session's own recorded source tells
 * them apart: a scheduled or GitHub-triggered session is the retry; anything else waits.
 */
const AUTOMATION_SESSION_SOURCES: ReadonlySet<string> = new Set(['schedule', 'github-trigger']);
/** Daemon writers that act inside a person's conversation (plan §3.4). */
const AUTOMATIC_DAEMON_SOURCES: ReadonlySet<string> = new Set(['autonomous-quality-gate', 'agent-browser']);

export function parseDelegatedAttendance(value: unknown): DelegatedAttendance | null {
    return value === 'unattended' || value === 'attended' ? value : null;
}

/**
 * What a parent hands its child (R12): a messenger parent's child is unattended too — the buttons
 * reach the parent's conversation, never the child's.
 */
export function delegatedAttendanceFor(attendance: TurnAttendance): DelegatedAttendance {
    return attendance === 'attended' ? 'attended' : 'unattended';
}

/**
 * The parent's attendance a spawned child was started with, read once and removed so the child's
 * own children never inherit it. Absent (an older parent or CLI) means nothing is known: wait.
 */
export function consumeDelegatedAttendance(env: NodeJS.ProcessEnv): DelegatedAttendance | null {
    const value = parseDelegatedAttendance(env[DELEGATED_ATTENDANCE_ENV]);
    delete env[DELEGATED_ATTENDANCE_ENV];
    return value;
}

/** The attendance of a spawned child's first prompt, which arrives without message meta. */
export function initialPromptAttendance(delegated: DelegatedAttendance | null): InputAttendance | undefined {
    if (delegated === 'unattended') return 'unattended';
    if (delegated === 'attended') return 'automatic';
    return undefined;
}

/**
 * One input's sender, from its message meta and the receiving session's recorded `source`
 * (session metadata, aplus-dev-studio specs/session-source-metadata). Own-property reads only:
 * meta is decrypted JSON any client can write, and an inherited key must not pass for one it sent.
 */
export function inputAttendanceFromMeta(meta: unknown, sessionSource?: unknown): InputAttendance {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'human';
    const field = (key: string): unknown => (Object.hasOwn(meta, key) ? (meta as Record<string, unknown>)[key] : undefined);

    const delegated = parseDelegatedAttendance(field('delegatedAttendance'));
    if (delegated === 'unattended') return 'unattended';
    if (delegated === 'attended') return 'automatic';

    const turnTrigger = field('turnTrigger');
    if (typeof turnTrigger === 'string' && UNATTENDED_TURN_TRIGGERS.has(turnTrigger)) return 'unattended';
    if (typeof turnTrigger === 'string' && AUTOMATIC_TURN_TRIGGERS.has(turnTrigger)) return 'automatic';
    if (turnTrigger === 'automation') {
        return typeof sessionSource === 'string' && AUTOMATION_SESSION_SOURCES.has(sessionSource) ? 'unattended' : 'automatic';
    }

    const sentFrom = field('sentFrom');
    if (sentFrom === 'automation') return 'unattended';
    if (sentFrom === 'happy-agent') return 'automatic';
    if (sentFrom === 'daemon') {
        const source = field('source');
        // BYOS offline delivery re-seals a message a person typed elsewhere: that is a person.
        if (typeof source === 'string' && AUTOMATIC_DAEMON_SOURCES.has(source)) return 'automatic';
    }
    // `user`, another device, BYOS offline, no meta or a value this build does not know: a person.
    return 'human';
}

/** The inputs of one turn, after the queue batched them. */
export interface TurnInputs {
    /** The session runs one turn and exits (`exitAfterFirstTurn`): nobody is there, whatever the meta. */
    runOnce: boolean;
    /** Every input in the batch was `unattended`. A mixed batch has a person in it. */
    allUnattended: boolean;
    /** The batch answers a messenger request. */
    channel: boolean;
}

export function turnAttendance(inputs: TurnInputs): TurnAttendance {
    if (inputs.runOnce) return 'unattended';
    if (inputs.channel) return 'channel';
    return inputs.allUnattended ? 'unattended' : 'attended';
}

/**
 * The agent-facing reason for a declined unattended prompt (spec R10, tasks T22). English and
 * fixed: it is read by the model, and it must keep the model from trying the same thing another way.
 */
export function unattendedExpiryMessage(timeoutMs: number = UNATTENDED_APPROVAL_TIMEOUT_MS): string {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    return `No human responded within ${minutes} minutes, so this request was declined automatically. `
        + 'Do not work around it with another command or tool for the same purpose. '
        + 'Finish what you can without it and report what you needed.';
}

/**
 * The current turn's attendance, for one session process.
 *
 * Set when a turn starts, lifted to `attended` when a person's input arrives during it, and read
 * whenever a prompt is raised or the tool policy gate decides. It also holds the turn's wait budget
 * (spec Q6): after one prompt in a turn expires, every later prompt of the same turn is declined
 * without waiting, so a run cannot stall for 30 minutes per question.
 */
export class TurnAttendanceState {
    private attendance: TurnAttendance;
    private budgetSpent = false;
    /** The next started batch continues the current turn (an account switch, a capacity retry). */
    private continuationQueued = false;
    private readonly releaseListeners = new Set<() => void>();

    constructor(private readonly runOnce: boolean = false) {
        this.attendance = runOnce ? 'unattended' : 'attended';
    }

    current(): TurnAttendance {
        return this.attendance;
    }

    /** A new turn: its own classification and a fresh wait budget. */
    beginTurn(attendance: TurnAttendance): void {
        this.attendance = attendance;
        this.budgetSpent = false;
    }

    /**
     * A queued batch became the running turn. A continuation of the current turn keeps the wait
     * budget that turn already spent (spec Q6: one wait per turn, not per provider call).
     */
    startTurn(batch: { allUnattended?: boolean; channel: boolean }): TurnAttendance {
        const carriedBudget = this.continuationQueued && this.budgetSpent;
        this.continuationQueued = false;
        const attendance = turnAttendance({ runOnce: this.runOnce, allUnattended: batch.allUnattended === true, channel: batch.channel });
        this.beginTurn(attendance);
        if (carriedBudget) this.budgetSpent = true;
        return attendance;
    }

    /** The tool policy gate's "nobody to ask" (agent-tool-policy R3, spec Q9). */
    policyUnattended(): boolean {
        // A run-once session stays unattended for the gate, exactly as before Q9. A messenger turn
        // whose wait already ran out declines its next ask at once too (R10a, Q6).
        return this.runOnce || this.attendance === 'unattended' || (this.attendance === 'channel' && this.budgetSpent);
    }

    /**
     * What an automatic continuation of the current turn carries (an account switch, a capacity
     * retry), called as it is queued: an unattended turn stays unattended rather than becoming a
     * person's turn, and keeps the wait budget it spent.
     */
    continuationInput(): InputAttendance | undefined {
        this.continuationQueued = true;
        return this.attendance === 'attended' ? undefined : 'unattended';
    }

    /**
     * An input arrived for this session. A person's lifts the current turn's waits (R10); anything
     * else — a daemon follow-up, a quality gate, a messenger relay — leaves them running.
     */
    inputArrived(input: InputAttendance): void {
        if (input !== 'human' || this.attendance === 'attended') return;
        this.attendance = 'attended';
        for (const listener of [...this.releaseListeners]) {
            try { listener(); } catch { /* a listener must not stop the others */ }
        }
    }

    budgetExhausted(): boolean {
        return this.budgetSpent;
    }

    spendBudget(): void {
        this.budgetSpent = true;
    }

    /** Called when a person lifts the turn's waits. Returns the unsubscribe. */
    onRelease(listener: () => void): () => void {
        this.releaseListeners.add(listener);
        return () => { this.releaseListeners.delete(listener); };
    }
}

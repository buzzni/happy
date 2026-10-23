/**
 * The unattended wait on one permission handler's prompts (aplus-dev-studio
 * specs/codexcli-approval-session-binding R10·R13·R14, tasks T21).
 *
 * Shared by the Claude handler and the Base (Codex/Gemini/ACP) handler, which differ in how they
 * settle a prompt but not in when. The handler decides the outcome; this only says "wait this
 * long", "decline now" or "no limit", and fires once when the wait runs out.
 *
 * - A prompt raised in an `unattended` or `channel` turn waits {@link UNATTENDED_APPROVAL_TIMEOUT_MS}.
 * - A tool policy prompt gets no timer here: the policy gate already gives up on it after the same
 *   30 minutes, in every conversation (review #8).
 * - Once a prompt in a turn has expired, the next ones in that turn are declined at once (Q6).
 * - A person's input during the turn lifts every running wait (R10); the handler is told so it can
 *   take the countdown off the cards.
 * - The deadline is fixed when the prompt is raised and never moves (R14).
 */

import { UNATTENDED_APPROVAL_TIMEOUT_MS, type TurnAttendanceState } from '@/api/turnAttendance';

export type ApprovalWait =
    /** Nobody is waited for: an attended turn, a policy prompt, or no attendance wired. */
    | { kind: 'unlimited' }
    /** Declined until `expiresAt` (this process's clock), unless answered first. */
    | { kind: 'timed'; expiresAt: number }
    /** The turn already spent its wait: decline without raising a card. */
    | { kind: 'decline-now' };

export class ApprovalExpiryTimers {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private attendance: TurnAttendanceState | null = null;
    private unsubscribe: (() => void) | null = null;

    constructor(private readonly opts: {
        /** The ids whose wait was lifted by a person; the handler takes `expiresAt` off them. */
        onReleased: (ids: string[]) => void;
        timeoutMs?: number;
        now?: () => number;
    }) { }

    /** Which turn's attendance to read. A handler without one never expires anything. */
    setAttendance(attendance: TurnAttendanceState | null): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.attendance = attendance;
        if (attendance) {
            this.unsubscribe = attendance.onRelease(() => {
                const ids = [...this.timers.keys()];
                this.clearAll();
                if (ids.length > 0) this.opts.onReleased(ids);
            });
        }
    }

    /**
     * Decides the wait for a prompt being raised now and, when timed, starts it. `expire` runs at
     * most once, and only if the prompt was not settled first — every settle path calls `clear`.
     */
    arm(id: string, prompt: { policy: boolean }, expire: () => void): ApprovalWait {
        const attendance = this.attendance;
        if (!attendance || prompt.policy || attendance.current() === 'attended') return { kind: 'unlimited' };
        if (attendance.budgetExhausted()) return { kind: 'decline-now' };
        this.clear(id);
        const timeoutMs = this.opts.timeoutMs ?? UNATTENDED_APPROVAL_TIMEOUT_MS;
        const expiresAt = (this.opts.now ?? Date.now)() + timeoutMs;
        const timer = setTimeout(() => {
            if (this.timers.get(id) !== timer) return;
            this.timers.delete(id);
            attendance.spendBudget();
            expire();
        }, timeoutMs);
        this.timers.set(id, timer);
        return { kind: 'timed', expiresAt };
    }

    /** A policy prompt that timed out in a waited-on turn spends the turn's budget too (plan §3.4). */
    spendBudget(): void {
        const attendance = this.attendance;
        if (attendance && attendance.current() !== 'attended') attendance.spendBudget();
    }

    clear(id: string): void {
        const timer = this.timers.get(id);
        if (timer === undefined) return;
        clearTimeout(timer);
        this.timers.delete(id);
    }

    clearAll(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    has(id: string): boolean {
        return this.timers.has(id);
    }
}

/**
 * Which turn answered a scheduled prompt delivered into an existing conversation, and what it
 * answered (Saycode specs/_archive/automation-result-delivery — R4, plan D1).
 *
 * The daemon reports a conversation run as started the moment the prompt is accepted; the answer
 * comes later, inside this session. This tracker follows the session's own protocol envelopes:
 * the daemon's prompt arrives with `localKey: happy-automation:<runId>`, the first top-level turn
 * that opens after it is that run's turn, and its `turn-end` settles it. A turn that was already
 * open when the prompt arrived belongs to whatever came before.
 *
 * That holds only while the prompt is the next input to run. When other input is still waiting
 * ahead of it, or arrives before its turn opens, the next turn may answer that input instead, or
 * both at once (engines batch queued input). Which turn is the run's cannot be told from here, so
 * such a run is dropped as `cancelled` and nothing is sent for it: a missing result is better
 * than someone's own conversation reaching a messenger as the scheduled answer. The tracker counts
 * input that has not started a turn yet; batching makes that count high, never low, and the
 * engine resets it when it says nothing is waiting (`inputQueueEmpty`).
 *
 * A failed turn the engine is about to retry on its own (a temporary API failure, specs
 * claude-transient-retry) is not the run's outcome yet: the caller `carry`s it, and the retry's
 * turn settles the run instead. Input from anyone else replaces that retry, so it settles the
 * carried run as the failure it was.
 *
 * The answer is the engine's own authoritative final answer (the same evidence a messenger reply
 * uses), never "the last text" — positional rules ship running commentary. An engine that does
 * not hand one over reports the turn without an answer, and nothing is delivered for it.
 *
 * Only the cut answer leaves this module: a `[SILENT]` answer is reported as silent without its
 * text, and the rest is cut to the delivery limit before it goes anywhere.
 */

import type { SessionEnvelope, SessionTurnEndStatus } from '@slopus/happy-wire';

import { isSilentAutomationResponse } from '@/daemon/automations/automationDomain';

export const AUTOMATION_TURN_ANSWER_MAX_CHARS = 1_500;
const AUTOMATION_LOCAL_KEY_PREFIX = 'happy-automation:';

export interface AutomationTurnResult {
    runId: string;
    status: SessionTurnEndStatus;
    /** The final answer cut to the delivery limit; null when there was none or it was `[SILENT]`. */
    finalAnswer: string | null;
    silent: boolean;
}

/** The run a daemon-delivered scheduled prompt belongs to, from its local key. */
export function automationRunIdFromLocalKey(localKey: string | undefined): string | null {
    if (!localKey?.startsWith(AUTOMATION_LOCAL_KEY_PREFIX)) return null;
    return localKey.slice(AUTOMATION_LOCAL_KEY_PREFIX.length) || null;
}

function cutAnswer(text: string): string {
    const characters = Array.from(text.trim());
    if (characters.length <= AUTOMATION_TURN_ANSWER_MAX_CHARS) return characters.join('');
    return `${characters.slice(0, AUTOMATION_TURN_ANSWER_MAX_CHARS - 1).join('').trimEnd()}…`;
}

function dropped(runId: string): AutomationTurnResult {
    return { runId, status: 'cancelled', finalAnswer: null, silent: false };
}

export class AutomationTurnTracker {
    private openTurn: string | null = null;
    private armed: { runId: string; behindTurn: string | null; carried: boolean } | null = null;
    private active: { runId: string; turn: string; finalAnswer: string | null } | null = null;
    /** Input received that has not opened a turn yet — at least this many, never fewer. */
    private waitingInputs = 0;

    /** A scheduled prompt for `runId` reached the session. Returns the runs this settled. */
    arm(runId: string): AutomationTurnResult[] {
        const settled = this.anotherInput();
        const ahead = this.waitingInputs;
        this.waitingInputs += 1;
        if (ahead > 0) return [...settled, dropped(runId)];
        this.armed = { runId, behindTurn: this.openTurn, carried: false };
        return settled;
    }

    /** A failed run the engine retries by itself: the next turn answers it. */
    carry(failed: AutomationTurnResult): void {
        this.armed = { runId: failed.runId, behindTurn: this.openTurn, carried: true };
    }

    /** Someone else's input arrived. Returns the runs it settled. */
    userInput(): AutomationTurnResult[] {
        const settled = this.anotherInput();
        this.waitingInputs += 1;
        return settled;
    }

    /** The engine's own retry of a carried failure will not run after all: it settles as failed. */
    retryAbandoned(): AutomationTurnResult[] {
        return this.armed?.carried ? this.anotherInput() : [];
    }

    /** The engine has no input waiting: every input so far has had its turn. */
    inputQueueEmpty(): void {
        this.waitingInputs = 0;
    }

    /**
     * Input other than a waiting run's own prompt. A carried failure's retry is replaced, so it
     * settles as the failure it was; a prompt whose turn has not opened may now share it, so it is dropped.
     */
    private anotherInput(): AutomationTurnResult[] {
        const armed = this.armed;
        if (!armed) return [];
        this.armed = null;
        return [armed.carried ? { runId: armed.runId, status: 'failed', finalAnswer: null, silent: false } : dropped(armed.runId)];
    }

    /** The engine's final answer for the turn that is open now. */
    noteFinalAnswer(text: string): void {
        if (this.active && this.active.turn === this.openTurn) this.active.finalAnswer = text;
    }

    /** Feeds one outgoing envelope; returns the settled run when this envelope closed its turn. */
    observe(envelope: SessionEnvelope): AutomationTurnResult | null {
        if (envelope.role !== 'agent' || envelope.subagent || !envelope.turn) return null;
        const { ev, turn } = envelope;
        if (ev.t === 'turn-start') {
            this.openTurn = turn;
            if (this.waitingInputs > 0) this.waitingInputs -= 1;
            if (this.armed && turn !== this.armed.behindTurn) {
                this.active = { runId: this.armed.runId, turn, finalAnswer: null };
                this.armed = null;
            }
            return null;
        }
        if (ev.t !== 'turn-end') return null;
        if (turn === this.openTurn) this.openTurn = null;
        const active = this.active;
        if (!active || active.turn !== turn) return null;
        this.active = null;
        const answer = ev.status === 'completed' ? active.finalAnswer : null;
        const silent = isSilentAutomationResponse(answer);
        return {
            runId: active.runId,
            status: ev.status,
            finalAnswer: answer && !silent && answer.trim() ? cutAnswer(answer) : null,
            silent,
        };
    }
}

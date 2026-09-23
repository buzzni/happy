/**
 * Decides whether a turn that just ended is worth reviewing, and names it.
 *
 * Two judgements, kept apart from anything that spends money:
 *
 * **Eligibility.** A turn is a candidate only when it ended normally *and*
 * shows one of three things: the user corrected the agent, the agent recovered
 * from a failure it had actually verified, or the agent itself proposed a
 * lesson from work this host observed. A plain success teaches nothing new,
 * an abort teaches nothing at all, and an automation or review turn is not a
 * person working — those are excluded by rule rather than left to the model.
 *
 * **Identity.** The evidence key is derived from the project, the session and
 * the turn's own content digest. It is stable, so a retried or restarted turn
 * reserves and enqueues once; and it is content-bound, so two different turns
 * in one session are two candidates rather than one.
 *
 * Nothing here calls a provider. It produces a decision and a bounded
 * transcript; whether that transcript is ever sent is the worker's call, and
 * the worker refuses without a price, a budget and an identity.
 */
import { createHash } from 'node:crypto';

import { LESSON_REVIEW_EVIDENCE_BYTE_LIMIT } from './lessonReviewGateway';

/** Why a turn was not eligible. Each is an answer, not an error. */
export type LessonEvidenceRefusal =
    | 'aborted'
    | 'no-signal'
    | 'automation'
    | 'not-foreground'
    | 'empty'
    /** Nothing was observed of what the agent actually did. */
    | 'no-evidence';

export type LessonTurnKind = 'foreground' | 'automation' | 'review';

export interface LessonTurnRecord {
    sessionId: string;
    turnId: string;
    kind: LessonTurnKind;
    /** False when the turn was interrupted, stopped or errored out. */
    endedNormally: boolean;
    /**
     * Whether this session had already produced an assistant turn.
     *
     * Without it the commonest correction is invisible: the user lets a turn
     * finish, then opens the *next* turn with "no, not like that". That is the
     * first message of its turn, so a rule that only looks past the first
     * message would miss it — while still, correctly, not reading the very
     * first request of a session as a correction of nothing.
     */
    hadPriorAssistantTurn: boolean;
    /** The user messages of this turn, oldest first. */
    userMessages: readonly string[];
    /**
     * A compact, already-redacted trace of what the agent did.
     *
     * Collected from the provider's own events. Empty means this host observed
     * nothing, which is not the same as "the agent did nothing" — and a
     * candidate written from a question alone would be the model inventing a
     * procedure nobody performed.
     */
    agentSummary: string;
    /** Tool or command failures the turn observed and then stopped observing. */
    recoveredFailures: readonly string[];
}

export type LessonEvidence = {
    evidenceKey: string;
    /** What made this turn interesting; carried into the review prompt. */
    signal: 'user-correction' | 'verified-recovery' | 'agent-proposal';
    transcript: string;
};

export type LessonEvidenceDecision =
    | { eligible: true; evidence: LessonEvidence }
    | { eligible: false; reason: LessonEvidenceRefusal };

/**
 * Phrases that mark a user turning the agent around.
 *
 * Deliberately narrow and literal. A broad "is this a correction?" judgement
 * belongs to the reviewing model, and making it here with a loose pattern
 * would spend money on every turn that happened to contain the word "no".
 */
const CORRECTION_PATTERNS: readonly RegExp[] = [
    /\b(?:no|not|don't|do not|stop|undo|revert|wrong|incorrect|instead|actually)\b/i,
    /(?:아니|아냐|틀렸|그게 아니|하지\s*마|되돌려|다시\s*해)/,
];

const MAX_MESSAGE_CHARS = 800;

function clip(value: string, max: number): string {
    const trimmed = value.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Trims to the gateway's own byte budget, in UTF-8.
 *
 * Counting characters would be wrong in the direction that matters: Korean and
 * other non-Latin text is three bytes per character, so a 4,000-character
 * transcript is ~12,000 bytes and the gateway would refuse every one of them
 * as `evidence_budget`. The limit is imported rather than restated so the two
 * sides cannot drift.
 */
function clipToBytes(value: string, maxBytes: number): string {
    const trimmed = value.trim();
    if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) return trimmed;
    // Cut on a character boundary, never mid-sequence.
    const ellipsis = Buffer.byteLength('…', 'utf8');
    let end = 0;
    let bytes = 0;
    for (const character of trimmed) {
        const cost = Buffer.byteLength(character, 'utf8');
        if (bytes + cost > maxBytes - ellipsis) break;
        bytes += cost;
        end += character.length;
    }
    return `${trimmed.slice(0, end)}…`;
}

/**
 * A turn's identity.
 *
 * The content digest is what makes a restart idempotent: the same turn
 * re-observed produces the same key, so the budget ledger and CML's own
 * evidence-key uniqueness both see one candidate rather than two.
 */
export function lessonEvidenceKey(input: {
    projectId: string;
    sessionId: string;
    content: string;
}): string {
    const digest = createHash('sha256')
        .update(`${input.projectId}\n${input.sessionId}\n${input.content}`)
        .digest('hex')
        .slice(0, 32);
    return `turn:${digest}`;
}

export function evaluateLessonTurn(
    record: LessonTurnRecord,
    projectId: string,
    options: {
        /**
         * The foreground agent submitted a well-formed proposal this turn.
         *
         * The narrow patterns above miss most turns that teach something (the
         * agent verified a fix nobody had to correct), so every one of them was
         * refused as `no-signal` while the model was invited to propose each
         * turn. A proposal is its own signal; it still needs observed work
         * below, and still goes to approval before anything recalls it.
         */
        agentProposal?: boolean;
    } = {},
): LessonEvidenceDecision {
    // An abort says the user changed their mind, not that the agent learned
    // something. A review or automation turn is not a person working.
    if (!record.endedNormally) return { eligible: false, reason: 'aborted' };
    if (record.kind === 'automation') return { eligible: false, reason: 'automation' };
    if (record.kind !== 'foreground') return { eligible: false, reason: 'not-foreground' };

    const messages = record.userMessages.map((message) => message.trim()).filter(Boolean);
    const summary = record.agentSummary.trim();
    if (messages.length === 0 && !summary) return { eligible: false, reason: 'empty' };

    /*
     * A correction needs something to correct.
     *
     * Within a turn that is any message after the first. Across turns it is the
     * first message too, provided the session had already produced an assistant
     * turn — which is the commonest shape of all: the user lets a turn finish,
     * then opens the next one with "no, not like that". Only the very first
     * request of a session is excluded, because there is nothing behind it.
     */
    const correctable = record.hadPriorAssistantTurn ? messages : messages.slice(1);
    const corrected = correctable.some(
        (message) => CORRECTION_PATTERNS.some((pattern) => pattern.test(message)),
    );
    const recovered = record.recoveredFailures.length > 0;
    const proposed = options.agentProposal === true;
    if (!corrected && !recovered && !proposed) return { eligible: false, reason: 'no-signal' };
    /*
     * A signal is not evidence. With no observed actions and no observed
     * failures there is only the user's words, and a review of that can
     * describe a procedure but cannot have watched one — so it is refused
     * before it costs anything.
     */
    if (!summary && !recovered) return { eligible: false, reason: 'no-evidence' };

    const parts = [
        messages.length > 0 ? `## What the user asked\n${messages.map((m) => `- ${clip(m, MAX_MESSAGE_CHARS)}`).join('\n')}` : null,
        recovered
            ? `## Failures that were observed and then resolved\n${record.recoveredFailures.map((f) => `- ${clip(f, MAX_MESSAGE_CHARS)}`).join('\n')}`
            : null,
        summary ? `## What the agent did\n${clip(summary, MAX_MESSAGE_CHARS * 2)}` : null,
    ].filter((part): part is string => part !== null);
    const transcript = clipToBytes(parts.join('\n\n'), LESSON_REVIEW_EVIDENCE_BYTE_LIMIT);
    if (!transcript) return { eligible: false, reason: 'empty' };

    return {
        eligible: true,
        evidence: {
            // Both signals can hold; recovery is the stronger one to review.
            signal: recovered ? 'verified-recovery' : (corrected ? 'user-correction' : 'agent-proposal'),
            evidenceKey: lessonEvidenceKey({ projectId, sessionId: record.sessionId, content: transcript }),
            transcript,
        },
    };
}

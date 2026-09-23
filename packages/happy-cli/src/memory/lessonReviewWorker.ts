import { logger } from '@/ui/logger';

import type { LessonReviewBudget } from './lessonReviewBudget';
import type { LessonBindingIssuer } from './lessonBindingIssuer';
import type { LessonHostHandle } from './cmlLessonHost';
import { LessonSettingsError, type LessonSettingsStore } from './lessonSettingsStore';
import { evaluateLessonTurn, type LessonTurnRecord } from './lessonTurnEvidence';

export type LessonReviewOutcome =
    | 'reviewed'
    | 'no-lesson'
    | 'disabled'
    | 'unsupported'
    | 'not-eligible'
    | 'cancelled'
    | 'price_unknown'
    | 'budget_exceeded'
    | 'usage_unknown'
    | 'duplicate'
    | 'busy'
    | 'cooldown'
    | 'invalid_proposal'
    | 'evidence_budget'
    | 'private_evidence'
    | 'usage_exceeded'
    | 'invalid_gateway'
    | 'permission_denied'
    | 'stale_settings'
    | 'settings_unreadable'
    | 'rejected_content'
    | 'runtime_error';

export interface LessonReviewWorkerDeps {
    host: LessonHostHandle | null;
    issuer: LessonBindingIssuer | null;
    settings: LessonSettingsStore;
    budget: LessonReviewBudget;
    /**
     * Who this worker acts as.
     *
     * `machineId` is the daemon's real machine, not a placeholder: the binding
     * issuer records it and CML stores it on the trace, so an empty string
     * would attribute every candidate to no machine at all.
     */
    identity(): Promise<{ projectId: string; userId: string; machineId: string } | null>
        | { projectId: string; userId: string; machineId: string } | null;
    onOutcome?(outcome: LessonReviewOutcome): void;
}

/** Shapes the model's proposal into CML's candidate payload, or refuses it. */
function toCandidate(
    proposal: unknown,
    record: LessonTurnRecord,
    sourceEventIds: readonly string[],
): Record<string, unknown> | null {
    if (!proposal || typeof proposal !== 'object') return null;
    const value = proposal as Record<string, unknown>;
    const text = (key: string): string | null => {
        const item = value[key];
        return typeof item === 'string' && item.trim().length > 0 ? item.trim() : null;
    };
    const list = (key: string): string[] => {
        const item = value[key];
        if (Array.isArray(item)) {
            return item.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
        }
        // The proposal instruction asks for an array; a single string is
        // accepted rather than dropped, because dropping it would silently
        // produce a candidate with no validation at all.
        return typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : [];
    };
    const name = text('name');
    const trigger = text('trigger');
    const scope = text('scope');
    const reconsiderWhen = text('reconsiderWhen');
    const steps = list('steps');
    const validation = list('validation');
    // Kept, not dropped. `validVersions` is an applicability condition: a
    // lesson verified on one CLI version and presented without that fact reads
    // as unconditional, which is a broader claim than the review made.
    const validVersions = list('validVersions');
    /*
     * Every field CML requires must be present. A candidate missing its scope
     * or the validation that was actually run is a rule with no way to tell
     * whether it still holds, and CML refuses it anyway — refusing here names
     * the reason instead of surfacing a schema error.
     */
    if (!name || !trigger || !scope || !reconsiderWhen || steps.length === 0 || validation.length === 0) {
        return null;
    }
    return {
        name, trigger, steps, scope, validation, reconsiderWhen,
        ...(validVersions.length > 0 ? { validVersions } : {}),
        failureModes: list('failureModes'),
        // The model does not get to state its own confidence as authority; this
        // is a proposal awaiting a person either way.
        confidence: 0.5,
        skillCandidate: false,
        sourceSessionIds: [record.sessionId],
        sourceEventIds: [...sourceEventIds],
    };
}

export interface LessonReviewWorker {
    /** Optional for compatibility with older provider host adapters. */
    prepareReviewTurn?(): Promise<{ revision: number } | null>;
    reviewFinishedTurn(input: {
        record: LessonTurnRecord;
        signal: AbortSignal;
        /** Untrusted model proposal; never a lesson or permission grant. */
        proposal?: unknown;
        /** Captured before this foreground turn, not supplied by the model. */
        settingsRevision?: number;
    }): Promise<LessonReviewOutcome>;
}

/** Persists bounded foreground proposals. Never starts another model/API call. */
export function createLessonReviewWorker(deps: LessonReviewWorkerDeps): LessonReviewWorker {
    let running = false;
    const report = (outcome: LessonReviewOutcome): LessonReviewOutcome => {
        deps.onOutcome?.(outcome);
        return outcome;
    };
    return {
        async prepareReviewTurn() {
            try {
                if (!deps.host || !deps.issuer) {
                    logger.debug('[lesson-review-prepare] unsupported');
                    return null;
                }
                if (!(await deps.identity())) {
                    logger.debug('[lesson-review-prepare] permission_denied');
                    return null;
                }
                const settings = await deps.settings.read();
                if (!settings.reviewEnabled) {
                    logger.debug('[lesson-review-prepare] disabled');
                    return null;
                }
                return { revision: settings.revision };
            } catch (error) {
                logger.debug(error instanceof LessonSettingsError
                    ? '[lesson-review-prepare] settings_unreadable'
                    : '[lesson-review-prepare] runtime_error');
                return null;
            }
        },
        async reviewFinishedTurn({ record, signal, proposal, settingsRevision }) {
            if (!deps.host || !deps.issuer) return report('unsupported');
            if (running) return report('busy');
            // Claim before awaits so overlapping callbacks cannot both begin.
            running = true;
            let claimToRelease: string | undefined;
            let releaseOnAbort: (() => void) | undefined;
            let issued: Awaited<ReturnType<LessonBindingIssuer['issue']>> | undefined;
            try {
                const identity = await deps.identity();
                if (!identity) return report('permission_denied');
                const decision = evaluateLessonTurn(record, identity.projectId);
                if (!decision.eligible) {
                    logger.debug('[lesson-review-evidence]', {
                        reason: decision.reason, kind: record.kind,
                        hadPriorAssistantTurn: record.hadPriorAssistantTurn,
                        hasObservedActions: Boolean(record.agentSummary.trim()),
                        hasVerifiedRecovery: record.recoveredFailures.length > 0,
                        proposalSubmitted: proposal !== undefined && proposal !== null,
                    });
                    return report(decision.reason === 'aborted' ? 'cancelled' : 'not-eligible');
                }
                const settings = await deps.settings.read();
                if (!settings.reviewEnabled) return report('disabled');
                if (signal.aborted) return report('cancelled');
                // No proposal is not permission to fall back to a paid gateway.
                if (proposal === undefined || proposal === null) return report('no-lesson');
                if (settingsRevision !== settings.revision) return report('stale_settings');
                if (!deps.host.service.appendNormalEndEvidence) return report('unsupported');
                // Bound untrusted model output before passing it into storage.
                let serialized: string;
                try { serialized = JSON.stringify(proposal); } catch { return report('invalid_proposal'); }
                if (!serialized || Buffer.byteLength(serialized, 'utf8') > 16_384
                    || !toCandidate(proposal, record, [])) return report('invalid_proposal');
                const plannedRevision = settings.revision;
                issued = await deps.issuer.issue({
                    ...identity, sessionId: record.sessionId, capabilities: ['lesson.review'],
                    normalEndSessionIds: [record.sessionId], ttlMs: 120_000,
                });
                releaseOnAbort = () => issued?.release();
                signal.addEventListener('abort', releaseOnAbort, { once: true });
                if (signal.aborted) releaseOnAbort();
                const binding = issued.handle;
                const stillCurrent = async () => {
                    if (signal.aborted) return false;
                    try {
                        if ((await deps.issuer!.resolve(binding)).generation !== plannedRevision) return false;
                        const current = await deps.settings.read();
                        if (!current.reviewEnabled || current.revision !== plannedRevision) return false;
                        const actor = await deps.identity();
                        return !signal.aborted && actor?.projectId === identity.projectId && actor.userId === identity.userId
                            && actor.machineId === identity.machineId;
                    } catch { return false; }
                };
                const stale = () => report(signal.aborted ? 'cancelled' : 'stale_settings');
                if (!(await stillCurrent())) return stale();
                const requestId = `review:${decision.evidence.evidenceKey}`;
                const claim = await deps.budget.claimSession({ requestId, evidenceKey: decision.evidence.evidenceKey,
                    projectId: identity.projectId, sessionId: record.sessionId, cooldownMs: 30 * 60_000 });
                if (!claim.ok) return report(['duplicate', 'cooldown', 'busy'].includes(claim.reason)
                    ? claim.reason as LessonReviewOutcome : 'runtime_error');
                claimToRelease = requestId;
                if (!(await stillCurrent())) return stale();
                const appended = await deps.host.service.appendNormalEndEvidence({
                    version: 1, requestId: `evidence:${decision.evidence.evidenceKey}`, binding,
                    generation: plannedRevision, evidenceKey: decision.evidence.evidenceKey,
                    sessionId: record.sessionId, content: decision.evidence.transcript,
                }) as { outcome?: string; eventId?: unknown };
                if (appended?.outcome !== 'persisted' || typeof appended.eventId !== 'string' || !appended.eventId) return report('not-eligible');
                if (!(await stillCurrent())) return stale();
                const candidate = toCandidate(proposal, record, [appended.eventId])!;
                // Once enqueue starts, keep the claim even if its result is lost.
                claimToRelease = undefined;
                const enqueued = await deps.host.service.enqueueCandidate({
                    version: 1, requestId, binding, generation: plannedRevision,
                    evidenceKey: decision.evidence.evidenceKey,
                    payloadHash: deps.host.hashCandidatePayload(candidate), candidate,
                }) as { candidateId?: string; revision?: number; payloadHash?: string; status?: string };
                if (!enqueued?.candidateId || typeof enqueued.revision !== 'number' || !enqueued.payloadHash) return report('runtime_error');
                if (enqueued.status !== 'pending') return report('duplicate');
                if (!(await stillCurrent())) return stale();
                const reviewed = await deps.host.service.markReviewed({
                    version: 1, requestId: `${requestId}:reviewed`, binding, generation: plannedRevision,
                    candidateId: enqueued.candidateId, expectedRevision: enqueued.revision, payloadHash: enqueued.payloadHash,
                }) as { outcome?: string };
                return report(reviewed?.outcome === 'reviewed' ? 'reviewed' : 'runtime_error');
            } catch (error) {
                if (signal.aborted) return report('cancelled');
                if (error instanceof LessonSettingsError) return report('settings_unreadable');
                if (/private|credential|forbidden instruction/i.test((error as Error).message ?? '')) return report('rejected_content');
                logger.debug('[lesson-review] review failed; see the reported outcome');
                return report('runtime_error');
            } finally {
                if (claimToRelease) await deps.budget.cancelSessionClaim(claimToRelease);
                if (releaseOnAbort) signal.removeEventListener('abort', releaseOnAbort);
                issued?.release();
                running = false;
            }
        },
    };
}

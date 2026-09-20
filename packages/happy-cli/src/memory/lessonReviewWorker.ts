/**
 * Turns an eligible finished turn into a reviewed candidate — or into a typed
 * reason why it did not.
 *
 * The order is deliberate and every step can stop the run:
 *
 *  1. review must be enabled in the durable settings;
 *  2. the foreground must not be waiting (the abort signal is the turn loop's
 *     own idle wait, so a newly arrived message preempts this immediately);
 *  3. a resolved gateway config and a settled price must both exist — no
 *     price, no paid call, and "unknown" is never read as free;
 *  4. the budget ledger must reserve, which is also what makes a retried turn
 *     idempotent and what enforces the cooldown;
 *  5. only then is a provider called, exactly once, with no retry.
 *
 * The proposal that comes back is never a lesson. It is enqueued as a
 * candidate and marked reviewed, which is a proposal a person still has to
 * approve. This worker holds `lesson.review` and never `lesson.manage`, so it
 * could not persist a lesson even if it tried.
 */
import { logger } from '@/ui/logger';

import { reviewLessonWithGateway, type LessonGatewayConfig, type LessonPriceQuote } from './lessonReviewGateway';
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
    /** Resolved by authenticated Core config retrieval; never from env. */
    gateway(): Promise<{ config: LessonGatewayConfig; quote: LessonPriceQuote } | null>;
    /**
     * Who this worker acts as.
     *
     * `machineId` is the daemon's real machine, not a placeholder: the binding
     * issuer records it and CML stores it on the trace, so an empty string
     * would attribute every background candidate to no machine at all.
     */
    identity(): Promise<{ projectId: string; userId: string; machineId: string } | null>
        | { projectId: string; userId: string; machineId: string } | null;
    onOutcome?(outcome: LessonReviewOutcome): void;
    now?: () => number;
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
        // The gateway instruction asks for an array; a single string is
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
    /**
     * Called when a turn ends normally.
     *
     * The evidence is appended to the store first, and the ids that come back
     * are what anchor the candidate. No caller supplies them.
     */
    reviewFinishedTurn(input: {
        record: LessonTurnRecord;
        /** The turn loop's idle wait; a new foreground message aborts it. */
        signal: AbortSignal;
    }): Promise<LessonReviewOutcome>;
}

/** How often a running review re-reads the settings it was planned against. */
const SETTINGS_POLL_MS = 1_000;

export function createLessonReviewWorker(deps: LessonReviewWorkerDeps): LessonReviewWorker {
    const now = deps.now ?? Date.now;
    let running = false;

    function report(outcome: LessonReviewOutcome): LessonReviewOutcome {
        deps.onOutcome?.(outcome);
        return outcome;
    }

    return {
        async reviewFinishedTurn({ record, signal }) {
            if (!deps.host || !deps.issuer) return report('unsupported');
            // One review at a time per project; the ledger enforces the same
            // thing across processes, this just avoids the wasted work.
            if (running) return report('busy');

            /*
             * Re-confirmed before anything is spent. A review that began under
             * an authorization since revoked would charge an account the
             * studio no longer associates with this project.
             */
            const identity = await deps.identity();
            if (!identity) return report('permission_denied');
            const decision = evaluateLessonTurn(record, identity.projectId);
            if (!decision.eligible) {
                return report(decision.reason === 'aborted' ? 'cancelled' : 'not-eligible');
            }
            let settings;
            try {
                settings = await deps.settings.read();
            } catch (error) {
                // Unreadable settings are not permission to spend.
                return report(error instanceof LessonSettingsError ? 'settings_unreadable' : 'runtime_error');
            }
            if (!settings.reviewEnabled) return report('disabled');
            // The revision this run is planned against. Every later step is
            // checked against it, so a change mid-run stops the run rather
            // than committing under settings nobody chose.
            const plannedRevision = settings.revision;
            if (signal.aborted) return report('cancelled');
            // An install without the evidence entry point cannot anchor a
            // candidate, and nothing here will invent an id to work around it.
            if (!deps.host.service.appendNormalEndEvidence) return report('unsupported');

            running = true;
            /*
             * Issued before anything is paid for, and held for the whole run.
             *
             * This is what actually enforces "settings changed, stop": the
             * issuer's generation is the durable settings revision, so a
             * `configure` anywhere — this process or another — makes every
             * later `resolve` of this handle fail. Checking `signal.aborted`
             * alone would only catch the foreground, never a settings change.
             */
            let issued;
            try {
                issued = await deps.issuer.issue({
                    projectId: identity.projectId,
                    userId: identity.userId,
                    machineId: identity.machineId,
                    sessionId: record.sessionId,
                    // Review only. The transition to `accepted` needs
                    // `lesson.manage`, which only a person's grant carries.
                    capabilities: ['lesson.review'],
                    /*
                     * This host watched this turn end normally, and says so
                     * here rather than in the request. CML checks the session
                     * against this list, so a caller cannot assert its own
                     * completion — which is the whole point of the check.
                     */
                    normalEndSessionIds: [record.sessionId],
                    ttlMs: 120_000,
                });
            } catch {
                running = false;
                return report('permission_denied');
            }
            /**
             * True only while this run may still act.
             *
             * Three things, not one. The settings revision catches a change to
             * the configuration, but the binding was minted for two minutes
             * and its identity was read once — so a signed lease that expires
             * or an ACL withdrawn mid-call would otherwise let a slow gateway
             * response still enqueue. Re-reading the identity is what makes
             * "revoked" mean "no late write", which is the requirement.
             */
            const stillCurrent = async (): Promise<boolean> => {
                if (signal.aborted) return false;
                try {
                    if ((await deps.issuer!.resolve(issued.handle)).generation !== plannedRevision) {
                        return false;
                    }
                } catch {
                    return false;
                }
                // Goes through the same bounded authorization path a turn uses;
                // a refused or lapsed lease answers null.
                const now = await Promise.resolve(deps.identity()).catch(() => null);
                if (!now) return false;
                return now.userId === identity.userId
                    && now.projectId === identity.projectId
                    && now.machineId === identity.machineId;
            };
            /*
             * One controller for both reasons a run must stop.
             *
             * The foreground aborts it directly. A settings change cannot —
             * there is no event for it — so it is polled, and the poll aborts
             * the same controller. Without this the provider call runs to
             * completion after the user switched review off and the money is
             * already spent; fencing the write afterwards stops the record but
             * not the charge, and the user asked for both.
             */
            const controller = new AbortController();
            const stopForeground = () => controller.abort();
            signal.addEventListener('abort', stopForeground, { once: true });
            const poll = setInterval(() => {
                void stillCurrent().then((live) => { if (!live) controller.abort(); });
            }, SETTINGS_POLL_MS);
            poll.unref?.();
            try {
                /*
                 * Evidence first, provider second. The ids CML returns are the
                 * anchor for the candidate, and appending costs nothing — so a
                 * turn whose evidence will not persist is found out before any
                 * money is spent rather than after.
                 */
                const appended = await deps.host.service.appendNormalEndEvidence({
                    version: 1,
                    requestId: `evidence:${decision.evidence.evidenceKey}`,
                    binding: issued.handle,
                    generation: plannedRevision,
                    evidenceKey: decision.evidence.evidenceKey,
                    sessionId: record.sessionId,
                    content: decision.evidence.transcript,
                }) as { outcome?: string; eventId?: unknown };
                // One persisted event, and only when CML says it persisted.
                if (appended?.outcome !== 'persisted' || typeof appended.eventId !== 'string' || !appended.eventId) {
                    return report('not-eligible');
                }
                const sourceEventIds = [appended.eventId];

                const gateway = await deps.gateway();
                // No config and no price are the same answer to the only
                // question that matters: may this spend? It may not.
                if (!gateway) return report('price_unknown');

                const requestId = `review:${decision.evidence.evidenceKey}`;
                let fenced = false;
                if (!(await stillCurrent())) return report('stale_settings');
                const result = await reviewLessonWithGateway({
                    enabled: settings.reviewEnabled,
                    // Re-read on every internal checkpoint, so a settings change
                    // or a foreground message stops an in-flight review.
                    /*
                     * Synchronous by contract, so it reports the last observed
                     * state rather than pretending to re-read the settings file
                     * here. The authoritative re-check happens at each await
                     * boundary below, through `stillCurrent()`.
                     */
                    // Reports the controller, which both the foreground and
                    // the settings poll drive.
                    current: () => !controller.signal.aborted && !fenced,
                    signal: controller.signal,
                    gateway: gateway.config,
                    quote: gateway.quote,
                    identity: {
                        userId: identity.userId,
                        projectId: identity.projectId,
                        sessionId: record.sessionId,
                    },
                    budget: deps.budget,
                    requestId,
                    evidenceKey: decision.evidence.evidenceKey,
                    evidence: decision.evidence.transcript,
                    limits: { dailyMicroUsd: settings.dailyMicroUsd, dailyTokens: settings.dailyTokens },
                    now,
                });
                if (!result.ok) {
                    const known: readonly LessonReviewOutcome[] = [
                        'disabled', 'cancelled', 'price_unknown', 'budget_exceeded',
                        'usage_unknown', 'duplicate', 'busy', 'cooldown', 'invalid_proposal',
                        // Each of these is a specific refusal the gateway made.
                        // Flattening them into `runtime_error` would tell a user
                        // "something broke" when the truth is "the evidence was
                        // private", "it did not fit" or "the gateway is wrong".
                        'evidence_budget', 'private_evidence', 'usage_exceeded',
                        'invalid_gateway', 'permission_denied',
                    ];
                    const reason = result.reason as LessonReviewOutcome;
                    // A reason this worker does not know is reported as a
                    // runtime error rather than mapped onto a nearby one.
                    return report(known.includes(reason) ? reason : 'runtime_error');
                }
                // `{"proposal": null}` is the model saying there is nothing
                // reusable here. That is a successful review, not a failure.
                if (result.proposal === null) return report('no-lesson');

                const candidate = toCandidate(result.proposal, record, sourceEventIds);
                if (!candidate) return report('invalid_proposal');
                /*
                 * The decisive check. The provider call took time, and review
                 * may have been switched off during it — writing a candidate
                 * now would persist work the user already stopped.
                 */
                if (!(await stillCurrent())) {
                    fenced = true;
                    return report(signal.aborted ? 'cancelled' : 'stale_settings');
                }

                {
                    const generation = (await deps.issuer.resolve(issued.handle)).generation;
                    const enqueued = await deps.host.service.enqueueCandidate({
                        version: 1, requestId, binding: issued.handle, generation,
                        evidenceKey: decision.evidence.evidenceKey,
                        payloadHash: deps.host.hashCandidatePayload(candidate),
                        candidate,
                    }) as { candidateId?: string; revision?: number; payloadHash?: string; status?: string };
                    if (!enqueued?.candidateId || typeof enqueued.revision !== 'number' || !enqueued.payloadHash) {
                        return report('runtime_error');
                    }
                    // Already past `pending` — a restart re-observing the same
                    // turn must not review it twice.
                    if (enqueued.status !== 'pending') return report('duplicate');

                    await deps.host.service.markReviewed({
                        version: 1, requestId: `${requestId}:reviewed`, binding: issued.handle, generation,
                        candidateId: enqueued.candidateId,
                        expectedRevision: enqueued.revision,
                        payloadHash: enqueued.payloadHash,
                    });
                    return report('reviewed');
                }
            } catch (error) {
                const message = (error as Error).message ?? '';
                if (/private|credential|forbidden instruction/i.test(message)) return report('rejected_content');
                /*
                 * The classification only, never the message. A CML or Zod
                 * error quotes the value it rejected, which here is candidate
                 * text — possibly the very content that was refused for being
                 * private. Logging it would write it to disk.
                 */
                logger.debug('[lesson-review] review failed; see the reported outcome');
                return report('runtime_error');
            } finally {
                clearInterval(poll);
                signal.removeEventListener('abort', stopForeground);
                issued.release();
                running = false;
            }
        },
    };
}

/**
 * `lesson-host-v1` — the machine RPC the desktop calls for lesson state.
 *
 * The desktop sends `{ ...request, grantEnvelope }` flat. Nothing in that
 * object is authority:
 *
 *  - `grantEnvelope` is the **only** thing trusted. It is signed by the studio
 *    against the authenticated user, the project row, the machine-access check
 *    and the exact request digest.
 *  - `projectId` and `operation` are echoed back for an early mismatch check
 *    and then discarded — the verified claims are what the host acts on.
 *  - the remaining fields are the request, and they are digested *after* the
 *    envelope is split off so both sides agree on what "the request" is.
 *
 * Capabilities come from the grant. A UI grant never carries `lesson.review`,
 * so approving a candidate the automatic worker has not reviewed fails at the
 * CML status check rather than being smoothed over here.
 */
import type {
    LessonGrantResult,
    LessonGrantVerifier,
    LessonOperation,
} from './lessonGrantVerifier';
import { readLessonPage, type LessonHostHandle } from './cmlLessonHost';
import { LessonSettingsError } from './lessonSettingsStore';
import {
    LessonBindingError,
    type LessonBindingHandle,
    type LessonBindingIssuer,
} from './lessonBindingIssuer';
import type { LessonSettings, LessonSettingsStore } from './lessonSettingsStore';

export type LessonHostFailure =
    | 'invalid_request'
    | 'unsupported_version'
    | 'unsupported'
    | 'disabled'
    | 'permission_denied'
    | 'timeout'
    | 'revision_conflict'
    | 'request_conflict'
    | 'payload_conflict'
    | 'usage_unknown'
    | 'budget_exceeded'
    | 'settings_unreadable'
    /** A confirmed lesson of this name already exists; a person must decide. */
    | 'merge_required'
    | 'candidate_cap_reached'
    | 'evidence_conflict'
    | 'not_found'
    | 'runtime_error';

/** One page each of lessons and candidates, with the offsets to walk them. */
export interface LessonSnapshotPagination {
    lessonOffset: number;
    candidateOffset: number;
    /** null means this was the last page — never "we stopped looking". */
    nextLessonOffset: number | null;
    nextCandidateOffset: number | null;
}

export interface LessonSnapshot {
    version: 1;
    lessons: unknown[];
    candidates: unknown[];
    settings: LessonSettings;
    reviewOutcome: string;
    reviewExecution?: 'session';
    pagination: LessonSnapshotPagination;
}

/** CML pages at 100; the desktop walks with the offsets rather than seeing a truncated list. */
export const LESSON_PAGE_LIMIT = 100;
const MAX_OFFSET = 1_000_000;

function readOffset(value: unknown): number | null {
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    return value >= 0 && value <= MAX_OFFSET ? value : null;
}

export type LessonHostResponse =
    | { ok: true; snapshot: LessonSnapshot }
    | { ok: false; reason: LessonHostFailure };

export interface LessonHostRpcDeps {
    verifier: LessonGrantVerifier | null;
    /** null when CML is absent or too old; the whole feature then reports unsupported. */
    host: LessonHostHandle | null;
    /**
     * Mints the binding CML will act on.
     *
     * The RPC never constructs a binding object. It hands the issuer the
     * identity it verified, gets back an opaque handle, and releases it in a
     * `finally` — so an identity cannot outlive the request that proved it.
     */
    issuer: LessonBindingIssuer | null;
    settings: LessonSettingsStore;
    /**
     * Fences in-flight work.
     *
     * This is the durable settings revision, which the settings write itself
     * advances — there is no separate counter to bump, and nothing here claims
     * cross-process consistency that a process-local number could not provide.
     */
    generation(): Promise<number>;
    /** The last review worker outcome, surfaced so the UI can see why nothing ran. */
    reviewOutcome(): Promise<string> | string;
    /** Mutations get the shortest life that still covers the CML round trip. */
    bindingTtlMs?: number;
    now?: () => number;
}

/** CML stores a candidate body flat; the desktop snapshot expects it flat too. */
function flattenCandidate(row: unknown): unknown | null {
    if (!row || typeof row !== 'object') return null;
    const record = row as Record<string, unknown>;
    const payload = (record.candidate ?? {}) as Record<string, unknown>;
    const candidateId = record.candidateId;
    const revision = record.revision;
    const payloadHash = record.payloadHash;
    if (typeof candidateId !== 'string' || typeof revision !== 'number' || typeof payloadHash !== 'string') {
        return null;
    }
    const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    /*
     * Every applicability field the reviewer produced is carried through. These
     * are what a person needs in order to approve: a lesson without its scope,
     * the validation that was actually run, and the condition that should make
     * someone revisit it is a rule with no way to tell whether it still holds.
     * Dropping one here would show an approver less than the record contains.
     */
    const validVersions = strings(payload.validVersions);
    // Sibling lessons CML matched against this candidate. Shown before approval
    // so a person can see they are about to duplicate an existing rule.
    const duplicateLessonIds = strings(record.duplicateLessonIds);
    return {
        candidateId,
        revision,
        payloadHash,
        status: record.status,
        ...(duplicateLessonIds.length > 0 ? { duplicateLessonIds } : {}),
        name: typeof payload.name === 'string' ? payload.name : '',
        trigger: typeof payload.trigger === 'string' ? payload.trigger : '',
        steps: strings(payload.steps),
        sourceEventIds: strings(payload.sourceEventIds),
        sourceSessionIds: strings(payload.sourceSessionIds),
        scope: typeof payload.scope === 'string' ? payload.scope : '',
        validation: strings(payload.validation),
        reconsiderWhen: typeof payload.reconsiderWhen === 'string' ? payload.reconsiderWhen : '',
        // Always present, even when empty: a procedure shown without the ways
        // it goes wrong reads as unconditional, and an approver would be
        // deciding on less than the record holds.
        failureModes: strings(payload.failureModes),
        ...(validVersions.length > 0 ? { validVersions } : {}),
    };
}

function flattenLesson(row: unknown, recallEnabled: boolean): unknown | null {
    if (!row || typeof row !== 'object') return null;
    const record = row as Record<string, unknown>;
    if (typeof record.lessonId !== 'string' || typeof record.revision !== 'number') return null;
    const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    /*
     * Optional, and passed through exactly as stored.
     *
     * A lesson saved before these fields existed genuinely has none, and
     * filling in an empty string or an empty array would present a blank as if
     * it were the recorded answer. Absent means "this row does not have one";
     * present means the row said so.
     */
    const optionalText = (key: string) =>
        (typeof record[key] === 'string' && record[key] ? { [key]: record[key] as string } : {});
    const optionalList = (key: string) =>
        (Array.isArray(record[key]) ? { [key]: strings(record[key]) } : {});
    return {
        lessonId: record.lessonId,
        revision: record.revision,
        recallEnabled: typeof record.recallEnabled === 'boolean' ? record.recallEnabled : recallEnabled,
        name: typeof record.name === 'string' ? record.name : '',
        trigger: typeof record.trigger === 'string' ? record.trigger : '',
        steps: strings(record.steps),
        sourceEventIds: strings(record.sourceEventIds),
        sourceSessionIds: strings(record.sourceSessionIds),
        // Absent until the trace tables are read back; `null` is "not observed",
        // never "did not happen".
        lastSelectedAt: typeof record.lastSelectedAt === 'string' ? record.lastSelectedAt : null,
        lastDeliveredAt: typeof record.lastDeliveredAt === 'string' ? record.lastDeliveredAt : null,
        lastReadAt: typeof record.lastReadAt === 'string' ? record.lastReadAt : null,
        ...optionalText('scope'),
        ...optionalText('reconsiderWhen'),
        ...optionalList('validation'),
        ...optionalList('validVersions'),
        ...optionalList('failureModes'),
    };
}

/** CML surfaces conflicts as thrown Errors; this is the only place they are named. */
/**
 * `error.code` where CML sets one, exact message where it does not.
 *
 * Order matters and substring matching is the reason. "existing lesson
 * requires an explicit merge proposal and lesson revision CAS" contains the
 * word "revision", so a loose `/revision/` test reported a name collision as a
 * stale-revision conflict — and the UI told the user to retry something that
 * retrying cannot fix. Codes are checked first; the message table below is
 * exact-match, so a new CML message falls through to `runtime_error` instead
 * of being absorbed by whichever pattern happens to touch it.
 */
const MESSAGE_FAILURES: ReadonlyArray<readonly [string, LessonHostFailure]> = [
    ['existing lesson requires an explicit merge proposal and lesson revision CAS', 'merge_required'],
    ['pending candidate cap reached', 'candidate_cap_reached'],
    ['evidenceKey already exists without a recoverable host idempotency record', 'evidence_conflict'],
    ['evidence is not safely appendable', 'payload_conflict'],
    ['verified normal session completion is required', 'permission_denied'],
    ['requestId payload conflict', 'request_conflict'],
    ['payloadHash does not match canonical candidate payload', 'payload_conflict'],
    ['candidate changed before approval', 'revision_conflict'],
    ['lesson revision conflict or lesson not found', 'revision_conflict'],
    ['candidate revision, generation, or status conflict', 'revision_conflict'],
    ['binding generation mismatch', 'revision_conflict'],
    ['untrusted or unauthorized host binding', 'permission_denied'],
    ['source event refs are unavailable', 'not_found'],
    ['source event project mismatch', 'payload_conflict'],
    ['candidate contains private, credential-like, or forbidden instruction content', 'payload_conflict'],
];

const CODE_FAILURES: Readonly<Record<string, LessonHostFailure>> = {
    merge_required: 'merge_required',
    candidate_cap_reached: 'candidate_cap_reached',
    evidence_conflict: 'evidence_conflict',
    revision_conflict: 'revision_conflict',
    request_conflict: 'request_conflict',
    permission_denied: 'permission_denied',
    not_found: 'not_found',
};

function failureFor(error: unknown): LessonHostFailure {
    if (error instanceof LessonPageError) {
        return error.outcome === 'unsupported_version' ? 'unsupported_version' : 'runtime_error';
    }
    if (error instanceof LessonSettingsError) return 'settings_unreadable';
    if (error instanceof LessonBindingError) {
        // A refused binding is never a runtime error: it says the identity was
        // stale, fenced or for another project, and each of those is an answer.
        return error.reason === 'stale-generation' ? 'revision_conflict' : 'permission_denied';
    }
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && CODE_FAILURES[code]) return CODE_FAILURES[code];
    const message = error instanceof Error ? error.message : String(error);
    for (const [text, failure] of MESSAGE_FAILURES) {
        if (message === text) return failure;
    }
    return 'runtime_error';
}

/** A page the store refused. Carries the store's own outcome word. */
class LessonPageError extends Error {
    constructor(readonly outcome: string) {
        super(`lesson page refused: ${outcome}`);
        this.name = 'LessonPageError';
    }
}

const MUTATIONS: readonly LessonOperation[] = ['approve', 'reject', 'set-recall-enabled', 'configure'];

export function createLessonHostRpc(deps: LessonHostRpcDeps) {
    const now = deps.now ?? Date.now;

    async function snapshot(
        binding: LessonBindingHandle,
        requestId: string,
        offsets: { lessonOffset: number; candidateOffset: number },
    ): Promise<LessonSnapshot> {
        const host = deps.host!;
        const settings = await deps.settings.read();
        const candidatePage = readLessonPage(await host.service.listCandidates({
            version: 1, requestId, binding, limit: LESSON_PAGE_LIMIT, offset: offsets.candidateOffset,
        }), 'candidates');
        /*
         * A refused page is not an empty page. Rendering "no candidates yet"
         * for a store that answered `unsupported_version` would send a user
         * looking for records that are there and unreadable.
         */
        if (!candidatePage.ok) throw new LessonPageError(candidatePage.outcome);
        /*
         * `listLessons`, never `recall`. Recall is a query — it returns the top
         * few matches for a question and writes a `selected` trace for them. Using
         * it to fill a catalogue would hide most of the stored lessons from the
         * list and file selection traces for a turn that never happened.
         */
        const lessonPage = readLessonPage(await host.service.listLessons({
            version: 1, requestId: `${requestId}:lessons`, binding,
            limit: LESSON_PAGE_LIMIT, offset: offsets.lessonOffset,
        }), 'lessons');
        if (!lessonPage.ok) throw new LessonPageError(lessonPage.outcome);
        return {
            version: 1,
            lessons: lessonPage.rows
                .map((row) => flattenLesson(row, settings.recallEnabled))
                .filter((row): row is object => row !== null),
            candidates: candidatePage.rows
                .map(flattenCandidate).filter((row): row is object => row !== null),
            settings,
            reviewOutcome: await deps.reviewOutcome(),
            reviewExecution: 'session',
            pagination: {
                lessonOffset: offsets.lessonOffset,
                candidateOffset: offsets.candidateOffset,
                nextLessonOffset: lessonPage.nextOffset,
                nextCandidateOffset: candidatePage.nextOffset,
            },
        };
    }

    /*
     * A mutation answers with the first page. The list it changed may have
     * shifted under any deeper offset the caller held, and replaying a stale
     * one would show rows that moved rather than the result of the action.
     */
    const FIRST_PAGE = { lessonOffset: 0, candidateOffset: 0 };

    return async function handle(params: unknown): Promise<LessonHostResponse> {
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            return { ok: false, reason: 'invalid_request' };
        }
        const { grantEnvelope, ...request } = params as Record<string, unknown>;
        if (request.version !== 1) return { ok: false, reason: 'unsupported_version' };
        const operation = request.operation;
        if (typeof operation !== 'string' || typeof request.requestId !== 'string') {
            return { ok: false, reason: 'invalid_request' };
        }

        // Fail closed before anything is verified: with no verification key or
        // no store there is no authority and no place to act.
        if (!deps.verifier) return { ok: false, reason: 'disabled' };
        if (!deps.host || !deps.issuer) return { ok: false, reason: 'unsupported' };

        const isMutation = MUTATIONS.includes(operation as LessonOperation);
        // A snapshot may be retried by a slow machine; a click may not be replayed.
        const verified: LessonGrantResult = isMutation
            ? deps.verifier.consume({ envelope: grantEnvelope, request })
            : deps.verifier.verify({ envelope: grantEnvelope, request });
        if (!verified.ok) {
            return { ok: false, reason: verified.reason === 'expired' ? 'timeout' : 'permission_denied' };
        }
        const claims = verified.claims;

        /*
         * The identity comes from the verified claims and goes straight to the
         * issuer. No binding object exists in this scope for anything to
         * tamper with, and the handle stops resolving the moment this request
         * finishes.
         */
        let issued;
        try {
            issued = await deps.issuer.issue({
                projectId: claims.projectId,
                userId: claims.userId,
                machineId: claims.machineId,
                // UI work is its own session; it is not a turn in a conversation.
                sessionId: `lesson-ui:${claims.projectId}`,
                capabilities: claims.capabilities,
                ttlMs: deps.bindingTtlMs ?? 30_000,
            });
        } catch (error) {
            // A grant for another project on this machine lands here.
            return {
                ok: false,
                reason: error instanceof LessonBindingError && error.reason === 'project-mismatch'
                    ? 'permission_denied' : 'unsupported',
            };
        }
        const binding = issued.handle;
        const requestId = request.requestId;

        try {
            /*
             * The fence value CML compares its stored rows against. Read from the
             * durable settings revision, not from the handle: the handle is opaque
             * on purpose, and the issuer re-checks this same value on every
             * resolution, so another process turning recall off fences this too.
             */
            const generation = (await deps.issuer.resolve(binding)).generation;
            switch (operation) {
                case 'snapshot': {
                    const lessonOffset = readOffset(request.lessonOffset);
                    const candidateOffset = readOffset(request.candidateOffset);
                    if (lessonOffset === null || candidateOffset === null) {
                        return { ok: false, reason: 'invalid_request' };
                    }
                    return { ok: true, snapshot: await snapshot(binding, requestId, { lessonOffset, candidateOffset }) };
                }

                case 'approve': {
                    await deps.host.service.approveCandidate({
                        version: 1, requestId, binding, generation,
                        candidateId: request.candidateId, expectedRevision: request.expectedRevision,
                        payloadHash: request.payloadHash,
                    });
                    return { ok: true, snapshot: await snapshot(binding, `${requestId}:after`, FIRST_PAGE) };
                }

                case 'reject': {
                    await deps.host.service.rejectCandidate({
                        version: 1, requestId, binding, generation,
                        candidateId: request.candidateId, expectedRevision: request.expectedRevision,
                        payloadHash: request.payloadHash,
                    });
                    return { ok: true, snapshot: await snapshot(binding, `${requestId}:after`, FIRST_PAGE) };
                }

                case 'set-recall-enabled': {
                    await deps.host.service.setRecallEnabled({
                        version: 1, requestId, binding, generation,
                        lessonId: request.lessonId, expectedRevision: request.expectedRevision,
                        enabled: request.enabled,
                    });
                    return { ok: true, snapshot: await snapshot(binding, `${requestId}:after`, FIRST_PAGE) };
                }

                case 'configure': {
                    const written = await deps.settings.write({
                        expectedRevision: request.expectedRevision as number,
                        recallEnabled: request.recallEnabled as boolean,
                        reviewEnabled: request.reviewEnabled as boolean,
                        // Older running workers share these settings. Zero the
                        // paid budget so enabling session review cannot fund them.
                        dailyMicroUsd: 0,
                        dailyTokens: 0,
                    });
                    if (!written.ok) return { ok: false, reason: written.reason };
                    /*
                     * Settings changed, so anything already running was planned
                     * under the old ones. Bumping the generation is what stops a
                     * review that began before "review off" from committing after.
                     */
                    /*
                     * The write advanced the settings revision, which *is* the
                     * fence — so this request's own handle is now stale, by
                     * design. A fresh one is issued at the new revision rather
                     * than cloning the old binding past its own check, which
                     * would be exactly the bypass the fence exists to prevent.
                     */
                    issued.release();
                    const reissued = await deps.issuer.issue({
                        projectId: claims.projectId,
                        userId: claims.userId,
                        machineId: claims.machineId,
                        sessionId: `lesson-ui:${claims.projectId}`,
                        capabilities: claims.capabilities,
                        ttlMs: deps.bindingTtlMs ?? 30_000,
                    });
                    try {
                        return {
                            ok: true,
                            snapshot: await snapshot(reissued.handle, `${requestId}:after`, FIRST_PAGE),
                        };
                    } finally {
                        reissued.release();
                    }
                }

                default:
                    return { ok: false, reason: 'invalid_request' };
            }
        } catch (error) {
            return { ok: false, reason: failureFor(error) };
        } finally {
            // Always, on every path. A handle that survives its request is an
            // identity somebody else could still be holding.
            issued.release();
        }
    };
}

/**
 * The only thing in this process that can produce a binding CML will act on.
 *
 * CML's contract says a request "cannot provide or override" the binding
 * fields, and it enforces that by calling a host-supplied `verifyBinding` at
 * every entry and again immediately before each write. A `verifyBinding` that
 * returns its argument satisfies the type and defeats the contract completely:
 * any object shaped like a binding — including one assembled from an
 * unverified RPC payload — becomes an identity, with whatever capabilities it
 * claims.
 *
 * So a binding never travels as data. `issue` mints an opaque handle, keeps
 * the real binding in a `WeakMap` keyed by that handle, and `verifier()`
 * resolves only handles this registry issued. A forged object has no entry and
 * is refused; a copy of a handle's own fields is a different object and is
 * refused too.
 *
 * Freshness is re-checked on every resolution, not once at issue:
 *
 *  - the handle must not have been released (the caller releases in `finally`,
 *    so a binding cannot outlive the request that earned it);
 *  - it must not have expired;
 *  - the runtime must still be open;
 *  - the generation must still match, so a settings change or a re-bound
 *    session fences work that began under the old one — which is precisely the
 *    "again immediately before each write" check CML relies on.
 *
 * `projectHash` is supplied by the registry from the store the runtime opened,
 * never by the caller. Two projects on one machine would otherwise be one
 * grant apart: a grant legitimately minted for project A carries A's id, and
 * without pinning, its binding could be handed to the store opened for B.
 */
export type LessonCapability = 'lesson.read' | 'lesson.review' | 'lesson.manage';

export interface VerifiedLessonHostBinding {
    projectHash: string;
    actorId: string;
    userId: string;
    machineId: string;
    sessionId: string;
    generation: number;
    capabilities: readonly LessonCapability[];
    /**
     * Sessions whose turn this host watched end normally.
     *
     * CML accepts evidence only for a session named here, so this is the host
     * asserting "I saw that turn finish" — an assertion no request may make
     * for itself. It is set by the review path alone, from the turn record it
     * just evaluated, and is never populated from RPC input.
     */
    normalEndSessionIds?: readonly string[];
}

/** Opaque. Carries no fields a caller could copy into a forgery. */
export interface LessonBindingHandle {
    readonly __lessonBinding: unique symbol;
}

export type LessonBindingIssue = {
    /** Pass this to CML as the binding; it is never the binding itself. */
    handle: LessonBindingHandle;
    /** Always called in a `finally`; a released handle stops resolving. */
    release(): void;
};

export type LessonBindingRefusal =
    | 'unknown-binding'
    | 'released'
    | 'expired'
    | 'runtime-closed'
    | 'stale-generation'
    | 'project-mismatch';

export class LessonBindingError extends Error {
    constructor(readonly reason: LessonBindingRefusal) {
        super(`lesson host binding refused: ${reason}`);
        this.name = 'LessonBindingError';
    }
}

export interface LessonBindingIssuerOptions {
    /** The hash of the store this runtime actually opened. */
    projectHash(): string | null;
    /** The studio project id this runtime is pinned to, if any. */
    projectId: string | null;
    /**
     * The current fence, re-read on every resolution.
     *
     * Must be durable and shared, not a process counter: a counter restarts at
     * its initial value, so a candidate written at generation 5 could never be
     * approved after a restart — or, worse, could match again by coincidence
     * after a few settings writes. The settings revision is the value that
     * already survives restarts and is visible to other processes, so another
     * window turning recall off fences work here too.
     */
    generation(): Promise<number>;
    closed(): boolean;
    now?: () => number;
}

export interface LessonBindingIssuer {
    /**
     * Mints a handle for an already-authenticated identity.
     *
     * `projectId` is the scope the caller proved — from verified grant claims
     * for a UI request, or from the runtime's own pinning for a turn. It must
     * equal the project this runtime opened, or nothing is issued.
     */
    issue(input: {
        projectId: string;
        userId: string;
        machineId: string;
        sessionId: string;
        capabilities: readonly LessonCapability[];
        ttlMs: number;
        /** Host-observed normal turn ends; see the field's own note. */
        normalEndSessionIds?: readonly string[];
    }): Promise<LessonBindingIssue>;
    /** The `verifyBinding` handed to CML. Resolves issued handles only. */
    verifier(): (binding: unknown) => Promise<VerifiedLessonHostBinding>;
    /** For callers that need the resolved fields (tracing, ack tickets). */
    resolve(handle: LessonBindingHandle): Promise<VerifiedLessonHostBinding>;
}

interface Entry {
    binding: VerifiedLessonHostBinding;
    projectId: string;
    expiresAt: number;
    released: boolean;
}

export function createLessonBindingIssuer(options: LessonBindingIssuerOptions): LessonBindingIssuer {
    const now = options.now ?? Date.now;
    // Weak on purpose: a handle the caller dropped takes its binding with it.
    const issued = new WeakMap<object, Entry>();

    async function resolveEntry(candidate: unknown): Promise<VerifiedLessonHostBinding> {
        if (!candidate || typeof candidate !== 'object') throw new LessonBindingError('unknown-binding');
        const entry = issued.get(candidate as object);
        // A forgery, or a structural copy of a handle, has no entry.
        if (!entry) throw new LessonBindingError('unknown-binding');
        if (entry.released) throw new LessonBindingError('released');
        if (now() >= entry.expiresAt) throw new LessonBindingError('expired');
        if (options.closed()) throw new LessonBindingError('runtime-closed');
        // Re-read rather than trusted from issue time: this is the check that
        // makes a settings change or a re-bind actually stop in-flight work.
        if (entry.binding.generation !== await options.generation()) {
            throw new LessonBindingError('stale-generation');
        }
        const projectHash = options.projectHash();
        if (!projectHash || projectHash !== entry.binding.projectHash) {
            throw new LessonBindingError('project-mismatch');
        }
        if (options.projectId && options.projectId !== entry.projectId) {
            throw new LessonBindingError('project-mismatch');
        }
        return entry.binding;
    }

    return {
        async issue(input) {
            const projectHash = options.projectHash();
            if (!projectHash) throw new LessonBindingError('runtime-closed');
            if (options.closed()) throw new LessonBindingError('runtime-closed');
            /*
             * The grant said which studio project the caller proved. This
             * runtime was opened for one workspace. If they disagree, a grant
             * for another project on this same machine is being pointed at this
             * store, and issuing here would let it mutate the wrong project.
             */
            if (options.projectId && options.projectId !== input.projectId) {
                throw new LessonBindingError('project-mismatch');
            }
            const generation = await options.generation();
            const handle = Object.freeze({}) as unknown as LessonBindingHandle;
            issued.set(handle as unknown as object, {
                projectId: input.projectId,
                expiresAt: now() + Math.max(1_000, input.ttlMs),
                released: false,
                binding: {
                    // Never from the caller: the store this runtime opened decides.
                    projectHash,
                    actorId: `user:${input.userId}`,
                    userId: input.userId,
                    machineId: input.machineId,
                    sessionId: input.sessionId,
                    generation,
                    capabilities: [...input.capabilities],
                    ...(input.normalEndSessionIds && input.normalEndSessionIds.length > 0
                        ? { normalEndSessionIds: [...input.normalEndSessionIds] }
                        : {}),
                },
            });
            return {
                handle,
                release() {
                    const entry = issued.get(handle as unknown as object);
                    if (entry) entry.released = true;
                },
            };
        },
        verifier: () => (binding: unknown) => resolveEntry(binding),
        resolve: (handle) => resolveEntry(handle),
    };
}

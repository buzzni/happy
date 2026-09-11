/**
 * The provider-state scope, as it arrives on the wire.
 *
 * The parent names the sessions a checkpoint is meant to carry and signs them
 * with the rest of the checkpoint params - there is no separate digest or
 * claim, because `params` is already signed whole. This file is the runtime's
 * side of that agreement: it decides whether the document is the shape both
 * sides agreed on, and nothing else.
 *
 * ## Parsing is not coverage
 *
 * A scope that parses says the parent named some sources. It does **not** say
 * this runtime holds those files, that provider state may be archived, or that
 * a provider ever started. The publisher's fail-closed refusal is untouched by
 * anything here, and an absent scope is neither permission to archive provider
 * state nor evidence that none exists.
 *
 * ## Why the grammar is this strict
 *
 * Every rule below exists because the two parsers have to refuse the same
 * documents. A field one side accepts and the other ignores is a disagreement
 * that shows up as a checkpoint which restores nothing, long after the tick
 * that produced it.
 */

/** The full target document, before it is parsed. 256 KiB of JSON. */
export const MANAGED_TARGET_MAX_BYTES = 262144;

/**
 * The same document base64-encoded, as the checkpoint IPC carries it.
 *
 * `4 * ceil(n/3)` is what base64 costs, so this is the encoding of a document
 * exactly at the limit rather than a number chosen to look round.
 */
export const MANAGED_TARGET_MAX_BASE64 = 4 * Math.ceil(MANAGED_TARGET_MAX_BYTES / 3);

/** At most this many retained sessions per source. */
export const MANAGED_SCOPE_MAX_RETAINED = 32;

export type ProviderStateScopeGeneration = {
    projectId: string;
    workspaceId: string;
    runtimeId: string;
    epoch: number;
    provisioningOperationId: string;
};

export type ProviderStateScopeSource = {
    attemptId: string;
    runId: string;
    happySessionId: string;
    runtimeId: string;
    epoch: number;
    currentNativeId: string;
    retainedNativeIds: readonly string[];
    metadataVersion: number;
};

export type ProviderStateScopeV1 = {
    version: 1;
    provider: 'claude';
    capability: 'native-resume';
    generation: ProviderStateScopeGeneration;
    sources: readonly ProviderStateScopeSource[];
};

const GENERATION_KEYS = ['projectId', 'workspaceId', 'runtimeId', 'epoch', 'provisioningOperationId'] as const;
const SOURCE_KEYS = [
    'attemptId', 'runId', 'happySessionId', 'runtimeId', 'epoch',
    'currentNativeId', 'retainedNativeIds', 'metadataVersion',
] as const;
const SCOPE_KEYS = ['version', 'provider', 'capability', 'generation', 'sources'] as const;

/**
 * The product's own session-id grammar, case-insensitive as it is elsewhere.
 *
 * Insensitive in the **grammar** only. The value is kept exactly as written,
 * because it becomes a path, and a folded identifier is a file that is not
 * there.
 */
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ScopeError extends Error {
    constructor(detail: string) {
        // Never the value: this document travels with signed URLs and a one-use
        // key, and a refusal that quoted a field would put part of it in a log.
        super(`checkpoint target: provider-state scope ${detail}`);
        this.name = 'ProviderStateScopeError';
    }
}

function record(value: unknown, what: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ScopeError(`${what} must be an object`);
    }
    return value as Record<string, unknown>;
}

function onlyKnownKeys(value: Record<string, unknown>, known: readonly string[], what: string): void {
    for (const key of Object.keys(value)) {
        if (!known.includes(key)) throw new ScopeError(`${what} has an unknown key`);
    }
}

/**
 * The identifier grammar the managed wire already applies.
 *
 * The same literal appears in `launcher/ipcServer.ts`,
 * `launcher/generationManifest.ts`, `launcher/supervisor.ts` (twice) and
 * `daemon/launch/managedReportCredential.ts`. Importing one of them would
 * close a cycle - `ipcServer` already imports this module's size constant - and
 * hoisting it into a shared home would be a refactor across four owners for one
 * regex. So it is written here, and a parity test asserts it still equals the
 * one the IPC applies; if either moves, that test says so.
 *
 * Anything looser lets a scope name a generation the IPC could never carry -
 * unmatchable by construction. A cross-parser table over "non-empty string"
 * showed what that admits: a NUL, a newline, `/`, `../`, a right-to-left
 * override, a zero-width space and an emoji, accepted by both sides.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function identifier(value: unknown, what: string): string {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
        throw new ScopeError(`${what} is not a safe identifier`);
    }
    return value;
}

/** A safe non-negative integer. `0` is a real epoch and a real version. */
function counter(value: unknown, what: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new ScopeError(`${what} must be a non-negative safe integer`);
    }
    return value;
}

function nativeId(value: unknown, what: string): string {
    const id = identifier(value, what);
    if (!NATIVE_ID.test(id)) throw new ScopeError(`${what} is not a native session id`);
    return id;
}

function parseGeneration(value: unknown): ProviderStateScopeGeneration {
    const shape = record(value, 'generation');
    onlyKnownKeys(shape, GENERATION_KEYS, 'generation');
    return {
        projectId: identifier(shape.projectId, 'generation.projectId'),
        workspaceId: identifier(shape.workspaceId, 'generation.workspaceId'),
        runtimeId: identifier(shape.runtimeId, 'generation.runtimeId'),
        epoch: counter(shape.epoch, 'generation.epoch'),
        provisioningOperationId: identifier(shape.provisioningOperationId, 'generation.provisioningOperationId'),
    };
}

function parseSource(value: unknown, generation: ProviderStateScopeGeneration): ProviderStateScopeSource {
    const shape = record(value, 'source');
    onlyKnownKeys(shape, SOURCE_KEYS, 'source');

    const runtimeId = identifier(shape.runtimeId, 'source.runtimeId');
    /*
     * Foreign-runtime history reaches this filesystem only through a restore,
     * and nothing available here can verify that one happened - a file bearing
     * the right id says what this runtime holds now, not where it came from. So
     * it is refused until the source-checkpoint binding is verified, rather
     * than narrowed silently.
     */
    if (runtimeId !== generation.runtimeId) {
        throw new ScopeError('source.runtimeId is a different runtime');
    }
    const epoch = counter(shape.epoch, 'source.epoch');
    // A past epoch of the same runtime can still be on that filesystem; an
    // epoch above the generation's has not happened yet.
    if (epoch > generation.epoch) throw new ScopeError('source.epoch is ahead of the generation');

    const currentNativeId = nativeId(shape.currentNativeId, 'source.currentNativeId');
    const retained = shape.retainedNativeIds;
    if (!Array.isArray(retained)) throw new ScopeError('source.retainedNativeIds must be an array');
    if (retained.length > MANAGED_SCOPE_MAX_RETAINED) {
        throw new ScopeError('source.retainedNativeIds is too long');
    }
    const retainedNativeIds = retained.map((entry) => nativeId(entry, 'source.retainedNativeIds[]'));
    const seen = new Set<string>();
    for (const id of retainedNativeIds) {
        if (seen.has(id)) throw new ScopeError('source.retainedNativeIds repeats an id');
        seen.add(id);
    }
    // Within one source the two fields mean different things, so an id in both
    // is a source that cannot say which it is. Across sources the same id is
    // ordinary - see `parseProviderStateScope`.
    if (seen.has(currentNativeId)) {
        throw new ScopeError('source.retainedNativeIds repeats the current id');
    }

    return {
        attemptId: identifier(shape.attemptId, 'source.attemptId'),
        runId: identifier(shape.runId, 'source.runId'),
        happySessionId: identifier(shape.happySessionId, 'source.happySessionId'),
        runtimeId,
        epoch,
        currentNativeId,
        retainedNativeIds,
        metadataVersion: counter(shape.metadataVersion, 'source.metadataVersion'),
    };
}

export function parseProviderStateScope(value: unknown): ProviderStateScopeV1 {
    const shape = record(value, 'scope');
    onlyKnownKeys(shape, SCOPE_KEYS, 'scope');
    // Literals, not ranges. This runtime has measured one provider and one
    // capability, and a document naming another is asking for something nobody
    // here has evidence about.
    if (shape.version !== 1) throw new ScopeError('version must be 1');
    if (shape.provider !== 'claude') throw new ScopeError('provider must be claude');
    if (shape.capability !== 'native-resume') throw new ScopeError('capability must be native-resume');

    const generation = parseGeneration(shape.generation);
    const rawSources = shape.sources;
    if (!Array.isArray(rawSources) || rawSources.length === 0) {
        // The parent does not issue an empty list, so one arriving means
        // something upstream went wrong - it is not "nothing to cover".
        throw new ScopeError('sources must be a non-empty array');
    }
    const sources = rawSources.map((entry) => parseSource(entry, generation));

    let previous: string | null = null;
    for (const source of sources) {
        /*
         * Ascending and unique by `attemptId`. Ordering makes two parsers agree
         * on one canonical form; uniqueness is what stops a list from carrying
         * an attempt twice.
         *
         * Note what is **not** required: two different attempts may name the
         * same `currentNativeId`. That is an ordinary resume, and demanding
         * global uniqueness would read a continued session as a defect.
         */
        if (previous !== null && source.attemptId <= previous) {
            throw new ScopeError('sources must be in ascending attemptId order');
        }
        previous = source.attemptId;
    }
    return {
        version: 1,
        provider: 'claude',
        capability: 'native-resume',
        generation,
        sources,
    };
}

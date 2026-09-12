/**
 * What is on disk for a named set of Claude sessions, read once, inside a window
 * the caller has already proven.
 *
 * Contract:
 *
 * - **Not coverage.** The caller names sessions; this answers what exists for them
 *   and refuses when it cannot account for something. Which sessions a project
 *   needs, whether a parent receipt is authentic, and what the current epoch is are
 *   different questions this module does not answer and must not be read as
 *   answering.
 * - **The window is a caller contract**, not a proof that every writer is gone.
 *   `stillProven()` on entry and after collection detects the proof being lost; it
 *   detects nothing about a writer the proof never enumerated, and the check
 *   afterwards cannot undo a read that already happened. Containment is therefore
 *   static and prior: the walk below refuses a symlinked or foreign-owned component
 *   *before* anything is opened.
 * - **Nothing is opened that the caller's own identifiers did not name.** The parent
 *   transcript is read at the path the validated session produced; children only at
 *   paths built from the parent's own discovered ids; artifacts only from its own
 *   discovered segments. A file found while walking is never read because it was
 *   found.
 * - **No defaults for capacity.** Every cap is the caller's, validated first.
 */
import { createHash } from 'node:crypto';
import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    lstatSync,
    opendirSync,
    openSync,
    readSync,
} from 'node:fs';

import {
    claudeStateRequirements,
    classifyClaudeStateEntry,
    reconcileClaudeState,
    MANAGED_CLAUDE_CANONICAL_CWD,
    MANAGED_CLAUDE_PROVIDER_HOME,
    MANAGED_CLAUDE_PROJECT_SLUG,
    type ClaudeStateRequiredEntry,
    type ClaudeStateRequirements,
} from './managedClaudeStateLayout';
import {
    deriveClaudeTranscriptDependencies,
    discoverClaudeTranscriptDependencies,
    type ClaudeTranscriptRecord,
} from './managedClaudeTranscriptDerivation';
import { trustedPathRefusal, defaultProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

/** The state directory, relative to the provider home. */
const STATE_ROOT = '.claude';
const PROJECTS = `${STATE_ROOT}/projects`;
const PROJECT = `${PROJECTS}/${MANAGED_CLAUDE_PROJECT_SLUG}`;

export type ClaudeCollectorLimits = {
    maxTranscriptBytes: number;
    maxMetaBytes: number;
    maxArtifactBytes: number;
    /** Across everything read in one collection. */
    maxAggregateBytes: number;
    /**
     * Every dirent this collection observes, in total across directories —
     * **including** the ones it prunes. A budget spent only on what is kept would
     * let an unbounded directory pass by being entirely uninteresting.
     */
    maxEntries: number;
    /** Rows parsed per transcript. */
    maxRecords: number;
};

/**
 * The filesystem, and the ancestor question, as this module asks them.
 *
 * Injected so a test can serve a real tree for the canonical paths without the
 * module learning a second path policy — the paths it builds are always
 * `/workspace/.codex/…`. Production passes nothing and gets `node:fs`.
 */
export type ClaudeCollectorObservation = {
    /**
     * Whether everything above the provider home is trustworthy. Separate from
     * `lstat` because on a developer machine `/workspace` does not exist, and the
     * positive path has to be testable without weakening what production checks.
     */
    ancestorRefusal: () => string | null;
    lstat: (path: string) => {
        uid: number; mode: number; size: number; dev: number; ino: number;
        mtimeMs: number; ctimeMs: number;
        isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean;
    };
    opendir: (path: string) => {
        read: () => null | { name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean };
        close: () => void;
    };
    open: (path: string) => number;
    fstat: (fd: number) => {
        uid: number; mode: number; size: number; dev: number; ino: number;
        mtimeMs: number; ctimeMs: number; isFile: boolean;
    };
    read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
    close: (fd: number) => void;
};

export type ClaudeCollectionRefusal =
    | 'home-unsupported' | 'cwd-unsupported' | 'provider-uid-invalid' | 'limits-invalid'
    | 'window-not-proven' | 'window-lost'
    | 'provider-home-ancestor-untrusted' | 'provider-home-untrusted'
    | 'component-symlink' | 'component-irregular' | 'component-foreign-uid' | 'component-writable'
    | 'leaf-irregular' | 'leaf-foreign-uid' | 'leaf-writable' | 'leaf-swapped'
    | 'leaf-grew' | 'leaf-shrank'
    | 'too-large' | 'aggregate-too-large' | 'too-many-entries'
    | 'read-failed' | 'unknown-entry' | 'missing-required' | 'artifact-size-mismatch'
    | `requirements-refused:${string}` | `discovery-refused:${string}` | `derivation-refused:${string}`;

export type ClaudeCollectedEntry = ClaudeStateRequiredEntry & {
    /** `null` for `ancestry`: a directory is required for existing, not for content. */
    bytes: number | null;
    sha256: string | null;
};

export type ClaudeCollection =
    | {
        collected: true;
        entries: readonly ClaudeCollectedEntry[];
        /** The buffers the derivation reasoned over: parent, child records, child meta. */
        derivedFrom: readonly { path: string; sha256: string }[];
        /** Artifacts, which are digested and never parsed. */
        artifactDigests: readonly { path: string; sha256: string }[];
    }
    | { collected: false; refusal: ClaudeCollectionRefusal };

class CollectorRefusal extends Error {
    constructor(readonly refusal: ClaudeCollectionRefusal) {
        super(`claude state collection refused: ${refusal}`);
        this.name = 'CollectorRefusal';
    }
}

const defaultObservation: ClaudeCollectorObservation = {
    ancestorRefusal: () => {
        const refused = trustedPathRefusal('/workspace', 0, 'state-dir-unsafe', defaultProvisioningDeps);
        return refused === null ? null : refused.detail;
    },
    lstat: (path) => {
        const stat = lstatSync(path);
        return {
            uid: stat.uid, mode: stat.mode, size: stat.size, dev: stat.dev, ino: stat.ino,
            mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
            isDirectory: stat.isDirectory(), isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink(),
        };
    },
    opendir: (path) => {
        const handle = opendirSync(path);
        return {
            read: () => {
                const entry = handle.readSync();
                return entry === null ? null : {
                    name: entry.name,
                    isDirectory: entry.isDirectory(),
                    isFile: entry.isFile(),
                    isSymbolicLink: entry.isSymbolicLink(),
                };
            },
            close: () => handle.closeSync(),
        };
    },
    // `O_NOFOLLOW`: the leaf itself is never followed, and every component above it
    // was checked by the static walk.
    open: (path) => openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
    fstat: (fd) => {
        const stat = fstatSync(fd);
        return {
            uid: stat.uid, mode: stat.mode, size: stat.size, dev: stat.dev, ino: stat.ino,
            mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, isFile: stat.isFile(),
        };
    },
    read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    close: (fd) => closeSync(fd),
};

function positive(value: unknown): boolean {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

export function collectClaudeProviderState(input: {
    providerHome: string;
    canonicalCwd: string;
    providerUid: number;
    sources: readonly { attemptId: string; currentNativeId: string; retainedNativeIds: readonly string[] }[];
    window: { stillProven: () => boolean };
    limits: ClaudeCollectorLimits;
    observation?: ClaudeCollectorObservation;
}): ClaudeCollection {
    const fs = input.observation ?? defaultObservation;
    try {
        return collect(input, fs);
    } catch (error) {
        if (error instanceof CollectorRefusal) return { collected: false, refusal: error.refusal };
        /*
         * Anything the filesystem threw that this module did not classify becomes
         * one closed code.
         *
         * An `ENOENT`/`EACCES` from `node:fs` carries the **absolute path** it
         * failed on, and this collection walks the provider's home — so letting it
         * escape would hand a caller, and whatever log it reaches, the names of
         * files inside a tree the caller is not entitled to read. There is no
         * success arm here either: an unexplained failure is a refusal, never an
         * empty collection.
         */
        return { collected: false, refusal: 'read-failed' };
    }
}

function collect(
    input: Parameters<typeof collectClaudeProviderState>[0],
    fs: ClaudeCollectorObservation,
): ClaudeCollection {
    const refuse: (refusal: ClaudeCollectionRefusal) => never = (refusal) => {
        throw new CollectorRefusal(refusal);
    };

    /* ---- validated before a single path is built ---- */
    if (input.providerHome !== MANAGED_CLAUDE_PROVIDER_HOME) refuse('home-unsupported');
    if (input.canonicalCwd !== MANAGED_CLAUDE_CANONICAL_CWD) refuse('cwd-unsupported');
    // Zero is refused on its own: root-owned provider state is not provider state.
    if (!positive(input.providerUid)) refuse('provider-uid-invalid');
    const limits = input.limits;
    if (!positive(limits?.maxTranscriptBytes) || !positive(limits?.maxMetaBytes)
        || !positive(limits?.maxArtifactBytes) || !positive(limits?.maxAggregateBytes)
        || !positive(limits?.maxEntries) || !positive(limits?.maxRecords)) {
        refuse('limits-invalid');
    }
    if (!input.window.stillProven()) refuse('window-not-proven');

    const sessions = input.sources.flatMap((source) => [
        { attemptId: source.attemptId, nativeId: source.currentNativeId, role: 'current' as const },
        ...source.retainedNativeIds.map((nativeId) => ({
            attemptId: source.attemptId, nativeId, role: 'retained' as const,
        })),
    ]);

    /*
     * Path planning, not a requirement.
     *
     * Paths only, by type: a `ClaudeStateRequirements` here would compile straight
     * into the result or into `reconcileClaudeState`, and "provisional" would be a
     * convention rather than something the compiler keeps.
     */
    const planned = planTraversalPaths(input, refuse);

    /* ---- everything above the home, then the home itself ---- */
    if (fs.ancestorRefusal() !== null) refuse('provider-home-ancestor-untrusted');
    const home = fs.lstat(input.providerHome);
    if (home.isSymbolicLink || !home.isDirectory) refuse('provider-home-untrusted');
    if (home.uid !== input.providerUid || (home.mode & 0o022) !== 0) refuse('provider-home-untrusted');

    /* ---- pass A: catalogue, without opening anything ---- */
    const budget = { entries: limits.maxEntries, bytes: limits.maxAggregateBytes };
    const catalog = new Map<string, { isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>();
    const absolute = (path: string): string => `${input.providerHome}/${path}`;

    const traverse = (relativePath: string, provisional: ReadonlySet<string>): void => {
        // A component this walk will step through is checked before it is used —
        // the classifier would only ever call an odd entry `unknown`.
        const stat = fs.lstat(relativePath === '' ? input.providerHome : absolute(relativePath));
        if (stat.isSymbolicLink) refuse('component-symlink');
        if (!stat.isDirectory) refuse('component-irregular');
        if (stat.uid !== input.providerUid) refuse('component-foreign-uid');
        if ((stat.mode & 0o022) !== 0) refuse('component-writable');

        const dir = fs.opendir(relativePath === '' ? input.providerHome : absolute(relativePath));
        try {
            for (;;) {
                const dirent = dir.read();
                if (dirent === null) break;
                // Counted before anything is decided about it: pruned entries spend
                // the budget too, on purpose.
                budget.entries -= 1;
                if (budget.entries < 0) refuse('too-many-entries');
                const path = relativePath === '' ? dirent.name : `${relativePath}/${dirent.name}`;
                catalog.set(path, dirent);
                const verdict = classifyClaudeStateEntry(
                    { path, type: dirent.isDirectory ? 'directory' : dirent.isFile ? 'file' : 'symlink' },
                );
                /*
                 * `never` is catalogued from the dirent and left alone — no `lstat`,
                 * no open, not even a size. A `never` entry that happens to be a
                 * symlink is still not followed, and refusing on it would let a file
                 * this collector never touches fail a checkpoint.
                 */
                if (verdict.kind === 'never' || verdict.kind === 'unsafe') continue;
                /*
                 * A symlink **dirent** on a path this collection may walk or read is
                 * refused here, before anything below it is touched. Skipping it as
                 * "not a directory" left the tree reachable through it: the leaf's
                 * `O_NOFOLLOW` says nothing about its ancestors, so a symlinked
                 * `subagents` would have been opened through, and the only later
                 * signal would have been a `missing-required` about a path that was
                 * already read from somewhere else.
                 */
                const candidate = provisional.has(path) || path === PROJECT || path.startsWith(`${PROJECT}/`);
                if (candidate && dirent.isSymbolicLink) refuse('component-symlink');
                if (!dirent.isDirectory) continue;
                /*
                 * Descent is decided by the plan, **before** the classifier's
                 * `out-of-scope`: asked on its own, `.claude/projects` is outside
                 * the project's own tree and would be pruned, leaving the project
                 * unreachable and every later refusal a `missing-required` about a
                 * path nobody walked to.
                 */
                if (candidate) traverse(path, provisional);
            }
        } finally {
            dir.close();
        }
    };

    /*
     * From the home itself: `.claude.json`, `config.toml` and `.happy` live here,
     * not under `.claude`, and a walk starting lower would never observe them —
     * so they would be neither catalogued nor counted, and "never opened" would be
     * true only because they were never seen.
     */
    const provisional = new Set([STATE_ROOT, ...planned.directories]);
    traverse('', provisional);

    /* ---- pass B: read only what the caller and the parent named ---- */
    const reads = new Map<string, { bytes: number; sha256: string }>();
    const readLeaf = (path: string, cap: number): Buffer => {
        let stat: ReturnType<ClaudeCollectorObservation['lstat']>;
        try {
            stat = fs.lstat(absolute(path));
        } catch (error) {
            // The parent named it and it is not there. That is the collection's own
            // answer, not an error from the filesystem passed through.
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') refuse('missing-required');
            throw error;
        }
        if (stat.isSymbolicLink || !stat.isFile) refuse('leaf-irregular');
        if (stat.uid !== input.providerUid) refuse('leaf-foreign-uid');
        if ((stat.mode & 0o022) !== 0) refuse('leaf-writable');
        if (stat.size > cap) refuse('too-large');

        const fd = fs.open(absolute(path));
        try {
            const before = fs.fstat(fd);
            if (!before.isFile) refuse('leaf-irregular');
            if (before.uid !== input.providerUid) refuse('leaf-foreign-uid');
            // The cap is checked against the handle too: the `lstat` was of a path.
            if (before.size > cap) refuse('too-large');
            if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size
                || before.mode !== stat.mode || before.mtimeMs !== stat.mtimeMs
                || before.ctimeMs !== stat.ctimeMs) {
                refuse('leaf-swapped');
            }
            budget.bytes -= before.size;
            if (budget.bytes < 0) refuse('aggregate-too-large');

            const buffer = Buffer.allocUnsafe(before.size);
            let total = 0;
            while (total < before.size) {
                const read = fs.read(fd, buffer, total, before.size - total, total);
                // A short read is the file ending early, which is a different file
                // from the one that was measured.
                if (read <= 0) refuse('leaf-shrank');
                total += read;
            }
            // One more byte than stated means it grew under the read.
            if (fs.read(fd, Buffer.allocUnsafe(1), 0, 1, total) > 0) refuse('leaf-grew');

            const after = fs.fstat(fd);
            if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
                || after.mode !== before.mode || after.uid !== before.uid
                || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
                refuse('leaf-swapped');
            }
            reads.set(path, { bytes: total, sha256: createHash('sha256').update(buffer).digest('hex') });
            return buffer;
        } finally {
            fs.close(fd);
        }
    };

    const parse = (buffer: Buffer, path: string): ClaudeTranscriptRecord[] => {
        const lines = buffer.toString('utf8').split('\n').filter((line) => line.length > 0);
        if (lines.length > limits.maxRecords) refuse('too-large');
        return lines.map((line) => {
            try {
                return JSON.parse(line) as ClaudeTranscriptRecord;
            } catch {
                return refuse('read-failed');
            }
        });
    };

    const derivedFrom: { path: string; sha256: string }[] = [];
    const artifactDigests: { path: string; sha256: string }[] = [];
    const dependencies = new Map<string, {
        complete: true;
        subagents: { agentId: string }[];
        references: { segment: string; size: number }[];
    }>();

    for (const session of sessions) {
        if (dependencies.has(session.nativeId)) continue;
        const transcriptPath = `${PROJECT}/${session.nativeId}.jsonl`;
        const records = parse(readLeaf(transcriptPath, limits.maxTranscriptBytes), transcriptPath);
        derivedFrom.push({ path: transcriptPath, sha256: reads.get(transcriptPath)!.sha256 });

        const discovered = discoverClaudeTranscriptDependencies({
            nativeId: session.nativeId,
            canonicalCwd: input.canonicalCwd,
            providerHome: input.providerHome,
            records,
        });
        if (!discovered.discovered) refuse(`discovery-refused:${discovered.refusal}`);

        const children = new Map<string, { records: ClaudeTranscriptRecord[]; meta: unknown }>();
        for (const agentId of discovered.agentIds) {
            const base = `${PROJECT}/${session.nativeId}/subagents/agent-${agentId}`;
            const childRecords = parse(readLeaf(`${base}.jsonl`, limits.maxTranscriptBytes), `${base}.jsonl`);
            derivedFrom.push({ path: `${base}.jsonl`, sha256: reads.get(`${base}.jsonl`)!.sha256 });
            const metaBuffer = readLeaf(`${base}.meta.json`, limits.maxMetaBytes);
            // Included because the derivation reads it: a meta swapped afterwards
            // would rebind a child while every transcript digest still agreed.
            derivedFrom.push({ path: `${base}.meta.json`, sha256: reads.get(`${base}.meta.json`)!.sha256 });
            let meta: unknown;
            try {
                meta = JSON.parse(metaBuffer.toString('utf8'));
            } catch {
                refuse('read-failed');
            }
            children.set(agentId, { records: childRecords, meta });
        }

        const derived = deriveClaudeTranscriptDependencies({
            nativeId: session.nativeId,
            canonicalCwd: input.canonicalCwd,
            providerHome: input.providerHome,
            records,
            children,
        });
        if (!derived.derived) refuse(`derivation-refused:${derived.refusal}`);

        for (const reference of derived.references) {
            const artifactPath = `${PROJECT}/${session.nativeId}/tool-results/${reference.segment}`;
            // Digested, never parsed: the record carries a size, not content. That
            // size is compared here, because the requirements name paths only and
            // nothing downstream would notice a file of a different length.
            readLeaf(artifactPath, limits.maxArtifactBytes);
            if (reads.get(artifactPath)!.bytes !== reference.size) refuse('artifact-size-mismatch');
            artifactDigests.push({ path: artifactPath, sha256: reads.get(artifactPath)!.sha256 });
        }

        dependencies.set(session.nativeId, {
            complete: true,
            subagents: derived.subagents.map((subagent) => ({ agentId: subagent.agentId })),
            references: derived.references.map((reference) => ({
                segment: reference.segment, size: reference.size,
            })),
        });
    }

    /* ---- pass C: the real requirements, and a verdict for everything seen ---- */
    const requirements = claudeStateRequirements({
        providerHome: input.providerHome,
        canonicalCwd: input.canonicalCwd,
        sources: input.sources,
        dependencies,
    });
    if (!requirements.ok) refuse(`requirements-refused:${requirements.refusal}`);

    const inventory = [...catalog.entries()].map(([path, dirent]) => ({
        path,
        type: (dirent.isDirectory ? 'directory' : dirent.isFile ? 'file' : 'symlink') as
            'directory' | 'file' | 'symlink',
    }));
    // The home is the walk's root, not a dirent of its own; `.claude` and below
    // are catalogued from their parents' enumeration.
    const reconciliation = reconcileClaudeState(inventory, requirements);
    if (reconciliation.missing.length > 0) refuse('missing-required');
    if (reconciliation.unknown.length > 0) refuse('unknown-entry');
    if (requirements.entries.length > limits.maxEntries) refuse('too-many-entries');

    if (!input.window.stillProven()) refuse('window-lost');

    return {
        collected: true,
        entries: requirements.entries.map((entry) => ({
            ...entry,
            bytes: entry.kind === 'ancestry' ? null : reads.get(entry.path)?.bytes ?? null,
            sha256: entry.kind === 'ancestry' ? null : reads.get(entry.path)?.sha256 ?? null,
        })),
        derivedFrom,
        artifactDigests,
    };
}

/**
 * The directories this collection may step through, and nothing else.
 *
 * Returns **paths**, never a `ClaudeStateRequirements`: the plan exists to validate
 * identifiers before any filesystem call and to name the ancestry, and a type that
 * could be reconciled would make "provisional" a convention instead of a guarantee.
 */
function planTraversalPaths(
    input: Parameters<typeof collectClaudeProviderState>[0],
    refuse: (refusal: ClaudeCollectionRefusal) => never,
): { directories: readonly string[] } {
    const provisional = claudeStateRequirements({
        providerHome: input.providerHome,
        canonicalCwd: input.canonicalCwd,
        sources: input.sources,
        dependencies: new Map(input.sources.flatMap((source) => [
            source.currentNativeId, ...source.retainedNativeIds,
        ]).map((nativeId) => [nativeId, { complete: true as const, subagents: [], references: [] }])),
    });
    if (!provisional.ok) refuse(`requirements-refused:${provisional.refusal}`);
    return {
        directories: provisional.entries
            .filter((entry) => entry.kind === 'ancestry')
            .map((entry) => entry.path),
    };
}

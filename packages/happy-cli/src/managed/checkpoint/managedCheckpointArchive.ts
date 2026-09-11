/**
 * Produces a managed project checkpoint: the sealed archives and the manifest
 * that describes them.
 *
 * The legacy walk applies `classifyCheckpointEntry` to every entry and never descends
 * into one it excluded — that is what keeps `node_modules` and `.ssh` from
 * being read at all rather than read and then dropped. Its exclusions are
 * recorded, because "this checkpoint does not contain your 900MB binary" is a
 * result the user has to be able to see (plan §7).
 *
 * The internal native branch collects Claude dependencies and prunes with the
 * Claude classifier before metadata reads. Its exclusions are not an exhaustive
 * persisted catalogue. Source authority and publisher activation remain separate.
 *
 * ## Memory
 *
 * `tar` output goes straight through the hash and the cipher into the sealed
 * file. The archive is never a `Buffer`, so peak memory is a stream chunk
 * regardless of project size — a cap on a buffered archive would only have
 * turned an out-of-memory kill into a refusal, and neither one produces a
 * checkpoint. `maxArchiveBytes` remains, but it now bounds the *file* the
 * checkpoint would occupy, which is a different question from whether this
 * process survives making it.
 *
 * ## Linked worktrees
 *
 * A linked worktree is two absolute paths pointing at each other:
 * `.git/worktrees/<name>/gitdir` names the worktree's `.git` file, and that
 * file names the administrative directory back. Both are recorded here as a
 * path *relative to the archived root*, so a restore can rebuild the pair at
 * whatever absolute path it lands on. A registration whose worktree lives
 * outside the archived root is dropped entirely — its working tree cannot
 * travel, so carrying the registration would only deliver a pointer to a
 * directory on a machine that no longer exists.
 */
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, readlink, readFile, realpath, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';

import {
    checkpointManifestDigest,
    serializeManagedCheckpointManifest,
    parseManagedCheckpointManifest,
    MANAGED_CHECKPOINT_MANIFEST_VERSION,
    type ManagedCheckpointEntry,
    type ManagedCheckpointManifest,
} from './managedCheckpointManifest';
import { sealCheckpointStream } from './managedCheckpointCrypto';
import { classifyCheckpointEntry, sanitizeGitConfig, type CheckpointArea } from './managedCheckpointScope';
import { collectClaudeProviderState, type ClaudeCollectorLimits, type ClaudeCollection } from './managedClaudeStateCollector';
import { trustedPathRefusal, defaultProvisioningDeps } from '@/daemon/managedRuntimeIdentity';
import { parseProviderStateScope, type ProviderStateScopeV1 } from './managedProviderStateScope';
import { MANAGED_CLAUDE_PROVIDER_HOME, MANAGED_CLAUDE_CANONICAL_CWD, MANAGED_CLAUDE_PROJECT_SLUG, classifyClaudeStateEntry, type ClaudeStateRequirements } from './managedClaudeStateLayout';

export const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export type CheckpointAreaSource = { area: CheckpointArea; root: string };

/**
 * An area was archived and nothing in it could be carried.
 *
 * A live runtime met this and it surfaced as
 * `TypeError: no paths specified to add to archive` from the tar library — no
 * `code`, so the coordinator could only say `checkpoint-failed`, and nobody could
 * act on that. An empty area is not a library error: it is a fact this runtime
 * has to answer for, because a checkpoint that carries none of an area it
 * declared cannot claim to restore it.
 *
 * The area is in the code, because the two are nothing alike — the project tree
 * being empty is a different situation from the provider's own state being
 * entirely outside the allowlist, which is what actually happened.
 */
export class ManagedCheckpointAreaEmptyError extends Error {
    constructor(readonly code: 'area-empty-project' | 'area-empty-provider-state') {
        super(`managed checkpoint area has nothing to archive: ${code}`);
        this.name = 'ManagedCheckpointAreaEmptyError';
    }
}

/**
 * The manifest described bytes the sealed archive does not contain.
 *
 * `walkArea` digests each carried file, and `tar` opens the same paths again
 * when the sealer pulls. A file written between those two reads makes the
 * manifest a claim about bytes that were never sealed, and the earliest place
 * that could notice it was restore's per-entry compare — after the pointer had
 * been published. Re-stat'ing the source afterwards would only say the file was
 * stable across a window; what is checked here is the tar stream itself.
 */
export class ManagedCheckpointSealMismatchError extends Error {
    constructor(readonly code: 'sealed-mismatch-project' | 'sealed-mismatch-provider-state') {
        super(`managed checkpoint archive does not match its manifest: ${code}`);
        this.name = 'ManagedCheckpointSealMismatchError';
    }
}

/**
 * What the tar stream actually carried, as it went past.
 *
 * `link` is tar's own de-duplication of one inode under two paths, and the
 * producer above is configured never to emit it. It is named here so such a
 * header is an unexpected type that refuses, rather than being read as a file
 * with no content — teaching the comparison a `Link` grammar would give one set
 * of bytes a second identity to verify.
 */
type SealedEntry = {
    type: 'file' | 'directory' | 'symlink' | 'link' | 'other';
    bytes: number;
    sha256: string;
    /**
     * `null` when the header did not state one. Restore compares mode, so an
     * entry whose mode cannot be read here cannot be verified — it is refused
     * rather than accepted on its bytes alone.
     */
    mode: number | null;
    linkTarget?: string;
};

/**
 * The bytes a collector said it read are not the bytes this archive sealed.
 *
 * The seal check above proves the manifest describes what went into the tar. It
 * cannot say those were the bytes some **other** reader had — and a derivation that
 * reasoned over one version of a transcript while the archive carried another is
 * two internally consistent halves that disagree.
 */
export class ManagedCheckpointCollectedBytesError extends Error {
    constructor(readonly code:
        | 'collected-bytes-missing'
        | 'collected-bytes-mismatch'
        | 'collected-bytes-unlisted'
        | 'collected-entry-not-a-file'
        | 'collected-input-invalid'
        | 'collected-input-duplicate',
    ) {
        super(`managed checkpoint collected bytes refused: ${code}`);
        this.name = 'ManagedCheckpointCollectedBytesError';
    }
}

/**
 * One regular file, as the collector read it.
 *
 * Provider-state only, and files only. A relative path is not an identity on its
 * own — the same spelling can exist in the project area — so this is compared
 * against `provider-state` entries and nothing else. Directories carry no claim:
 * the collector reports no bytes for them and the walk records the empty digest,
 * which are two conventions for "no content" and not an equality.
 */
export type CollectedProviderStateFile = {
    path: string;
    bytes: number;
    sha256: string;
};


export type ManagedCheckpointNativeCode =
    | 'native-input-invalid' | 'native-window-not-proven' | 'native-collection-refused'
    | 'native-window-lost' | 'native-walk-refused' | 'native-manifest-invalid'
    | 'native-output-failed' | 'native-cleanup-failed';

type ClosedArchiveCode = ManagedCheckpointNativeCode | ManagedCheckpointCollectedBytesError['code']
    | ManagedCheckpointSealMismatchError['code'] | ManagedCheckpointAreaEmptyError['code'];

export class ManagedCheckpointNativeStateError extends Error {
    constructor(readonly code: ManagedCheckpointNativeCode, readonly priorCode?: ClosedArchiveCode) {
        super(`managed checkpoint native state refused: ${code}`);
        this.name = 'ManagedCheckpointNativeStateError';
    }
}

type NativeProviderStateInput = {
    scope: ProviderStateScopeV1;
    providerUid: number;
    limits: ClaudeCollectorLimits;
    window: { stillProven: () => boolean };
};

type NativePreparation = {
    scope: ProviderStateScopeV1;
    providerUid: number;
    limits: ClaudeCollectorLimits;
    checkWindow: () => void;
    collection: Extract<ClaudeCollection, { collected: true }>;
    requirements: ClaudeStateRequirements;
};

function prepareNative(
    input: NativeProviderStateInput,
    sources: readonly CheckpointAreaSource[],
    projectId: string,
    legacyOptions: boolean,
): NativePreparation {
    let scope: ProviderStateScopeV1;
    let limits: ClaudeCollectorLimits;
    let providerUid: number;
    let stillProven: () => boolean;
    try {
        if (legacyOptions || sources.some(source => source.area !== 'project' && source.area !== 'provider-state') || sources.filter(source => source.area === 'provider-state').length !== 1
            || new Set(sources.map(source => source.area)).size !== sources.length
            || sources.find(source => source.area === 'provider-state')!.root !== MANAGED_CLAUDE_PROVIDER_HOME) throw new Error();
        if (!Array.isArray(input.scope.sources) || input.scope.sources.length > 128
            || Buffer.byteLength(JSON.stringify(input.scope), 'utf8') > 262_144) throw new Error();
        scope = parseProviderStateScope(input.scope);
        if (scope.generation.projectId !== projectId) throw new Error();
        providerUid = input.providerUid;
        limits = {
            maxTranscriptBytes: input.limits.maxTranscriptBytes, maxMetaBytes: input.limits.maxMetaBytes,
            maxArtifactBytes: input.limits.maxArtifactBytes, maxAggregateBytes: input.limits.maxAggregateBytes,
            maxEntries: input.limits.maxEntries, maxRecords: input.limits.maxRecords,
        };
        if (!Number.isSafeInteger(providerUid) || providerUid <= 0
            || Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error();
        stillProven = input.window.stillProven;
        if (typeof stillProven !== 'function') throw new Error();
    } catch {
        throw new ManagedCheckpointNativeStateError('native-input-invalid');
    }
    let windowLost = false;
    const observeWindow = (): boolean => {
        try { if (!windowLost && stillProven()) return true; } catch { /* Closed window verdict below. */ }
        windowLost = true;
        return false;
    };
    const check = (code: ManagedCheckpointNativeCode): void => {
        if (!observeWindow()) throw new ManagedCheckpointNativeStateError(code);
    };
    check('native-window-not-proven');
    let collection: ClaudeCollection;
    try {
        collection = collectClaudeProviderState({
            providerHome: MANAGED_CLAUDE_PROVIDER_HOME, canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD,
            providerUid, sources: scope.sources, limits, window: { stillProven: observeWindow },
        });
    } catch {
        throw new ManagedCheckpointNativeStateError('native-collection-refused');
    }
    if (!collection.collected) throw new ManagedCheckpointNativeStateError(windowLost ? 'native-window-lost' : 'native-collection-refused');
    return {
        scope, providerUid, limits, collection,
        checkWindow: () => check('native-window-lost'),
        requirements: { ok: true, slug: MANAGED_CLAUDE_PROJECT_SLUG, entries: collection.entries },
    };
}

export type ManagedCheckpointProduct = {
    manifest: ManagedCheckpointManifest;
    manifestDigest: string;
    /** Sealed archive file per area. */
    objects: Map<CheckpointArea, string>;
};

type Excluded = ManagedCheckpointManifest['excluded'][number];
type WorktreeRelation = ManagedCheckpointManifest['worktrees'][number];

async function assertUsableRoot(root: string): Promise<void> {
    // `lstat`, not `stat`: a root that is itself a symlink is refused rather
    // than followed, because the tree that would get read is not the one that
    // was named. Ancestor components are not checked here — on a real host
    // they are legitimately links (`/var` → `/private/var`) — containment for
    // everything below the root comes from the walk, which never follows one.
    try {
        const stat = await lstat(root);
        if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
        throw new Error('managed checkpoint area root is unusable');
    }
}

/**
 * Reads `.git/worktrees/<name>/gitdir` for every registration and splits them
 * into the ones whose worktree lives inside the archived root and the ones
 * that do not.
 */
async function readWorktreeRelations(root: string): Promise<{
    inScope: WorktreeRelation[];
    outOfScope: string[];
}> {
    const inScope: WorktreeRelation[] = [];
    const outOfScope: string[] = [];
    let names: string[];
    try {
        names = await readdir(join(root, '.git/worktrees'));
    } catch {
        return { inScope, outOfScope };
    }
    // A `gitdir` file holds one path. Reading it whole would allocate whatever
    // is in it — and this runs before the walk that caps file sizes, so a
    // repository carrying a huge file under that name would be read in full
    // just to be rejected. Bounded, and only if it is a regular file.
    const readPointer = async (path: string): Promise<string> => {
        const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            if (!(await handle.stat()).isFile()) throw new Error('not a regular file');
            const limit = 4096;
            const buffer = Buffer.allocUnsafe(limit + 1);
            const read = await handle.read(buffer, 0, limit + 1, 0);
            if (read.bytesRead > limit) throw new Error('gitdir pointer is too large');
            return buffer.subarray(0, read.bytesRead).toString('utf8');
        } finally {
            await handle.close();
        }
    };

    // Both sides are resolved before they are compared. Git records whatever
    // absolute path it canonicalised to, and a root reached through a link
    // (`/var` → `/private/var`, or a symlinked workspace mount) would
    // otherwise make every registration look like it points outside.
    const canonicalRoot = await realpath(root).catch(() => resolve(root));
    for (const name of names.sort()) {
        let gitdir: string;
        try {
            gitdir = (await readPointer(join(root, '.git/worktrees', name, 'gitdir'))).trim();
        } catch {
            outOfScope.push(name);
            continue;
        }
        // `gitdir` names the worktree's own `.git` file; its directory is the
        // worktree.
        const declared = dirname(gitdir);
        const worktreePath = await realpath(declared).catch(() => resolve(declared));
        const inside = relative(canonicalRoot, worktreePath);
        if (!gitdir.startsWith('/') || inside === '' || inside.startsWith('..') || inside.startsWith('/')) {
            outOfScope.push(name);
            continue;
        }
        inScope.push({ name, path: inside });
    }
    return { inScope, outOfScope };
}

/** Hashes a file without holding it: a 2GB asset costs one chunk of memory. */
async function fileDigest(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), async function* (chunks) {
        for await (const chunk of chunks) hash.update(chunk as Buffer);
    });
    return hash.digest('hex');
}


function closedNativeFailure(error: unknown): ManagedCheckpointNativeStateError
    | ManagedCheckpointCollectedBytesError | ManagedCheckpointSealMismatchError | ManagedCheckpointAreaEmptyError {
    if (error instanceof ManagedCheckpointNativeStateError || error instanceof ManagedCheckpointCollectedBytesError
        || error instanceof ManagedCheckpointSealMismatchError || error instanceof ManagedCheckpointAreaEmptyError) return error;
    return new ManagedCheckpointNativeStateError('native-output-failed');
}

/** Native-only enumeration: never/out-of-scope dirents are pruned before metadata or content reads. */
async function walkNativeArea(native: NativePreparation): Promise<{ entries: ManagedCheckpointEntry[]; excluded: Excluded[] }> {
    try {
        native.checkWindow();
        if (trustedPathRefusal('/workspace', 0, 'state-dir-unsafe', defaultProvisioningDeps) !== null) throw new Error();
        const collected = new Map(native.collection.entries.map(entry => [entry.path, entry]));
        const seen = new Set<string>();
        const entries: ManagedCheckpointEntry[] = [];
        let observed = 0;
        const visit = async (path: string): Promise<void> => {
            native.checkWindow();
            const directory = await lstat(path === '' ? MANAGED_CLAUDE_PROVIDER_HOME : join(MANAGED_CLAUDE_PROVIDER_HOME, path));
            if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== native.providerUid
                || (directory.mode & 0o022) !== 0) throw new Error();
            native.checkWindow();
            const handle = await opendir(path === '' ? MANAGED_CLAUDE_PROVIDER_HOME : join(MANAGED_CLAUDE_PROVIDER_HOME, path));
            try {
                for (;;) {
                    native.checkWindow();
                    const child = await handle.read();
                    if (child === null) break;
                    if (++observed > native.limits.maxEntries) throw new Error();
                    const relativePath = path === '' ? child.name : `${path}/${child.name}`;
                    const type = child.isFile() ? 'file' : child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'other';
                    const verdict = classifyClaudeStateEntry({ path: relativePath, type }, native.requirements);
                    if (verdict.kind === 'never' || verdict.kind === 'out-of-scope') continue;
                    if (verdict.kind !== 'required' || seen.has(relativePath)) throw new Error();
                    native.checkWindow();
                    const stat = await lstat(join(MANAGED_CLAUDE_PROVIDER_HOME, relativePath));
                    if (stat.uid !== native.providerUid || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink()) throw new Error();
                    const expected = collected.get(relativePath);
                    if (!expected) throw new Error();
                    if (expected.kind === 'ancestry') {
                        if (!stat.isDirectory()) throw new Error();
                        entries.push({ area: 'provider-state', path: relativePath, type: 'directory', bytes: 0, sha256: EMPTY_SHA256, mode: stat.mode & 0o7777 });
                        seen.add(relativePath);
                        await visit(relativePath);
                    } else {
                        if (!stat.isFile() || expected.bytes === null || expected.sha256 === null || stat.size !== expected.bytes) throw new Error();
                        entries.push({ area: 'provider-state', path: relativePath, type: 'file', bytes: expected.bytes, sha256: expected.sha256, mode: stat.mode & 0o7777 });
                        seen.add(relativePath);
                    }
                }
            } finally { await handle.close(); }
        };
        await visit('');
        if (seen.size !== collected.size) throw new Error();
        native.checkWindow();
        return { entries, excluded: [] };
    } catch (error) {
        if (error instanceof ManagedCheckpointNativeStateError) throw error;
        throw new ManagedCheckpointNativeStateError('native-walk-refused');
    }
}

async function walkArea(
    area: CheckpointArea,
    root: string,
    outOfScopeWorktrees: Set<string>,
    providerStateSessions: readonly string[],
): Promise<{ entries: ManagedCheckpointEntry[]; excluded: Excluded[] }> {
    const entries: ManagedCheckpointEntry[] = [];
    const excluded: Excluded[] = [];

    const visit = async (relativePath: string): Promise<void> => {
        const children = await readdir(relativePath === '' ? root : join(root, relativePath), { withFileTypes: true });
        for (const child of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const path = relativePath === '' ? child.name : `${relativePath}/${child.name}`;
            const absolute = join(root, path);
            const stat = await lstat(absolute);
            const type = stat.isFile() ? 'file'
                : stat.isDirectory() ? 'directory'
                    : stat.isSymbolicLink() ? 'symlink' : 'other';

            if (area === 'project'
                && relativePath === '.git/worktrees'
                && outOfScopeWorktrees.has(child.name)) {
                excluded.push({ area, path, reason: 'worktree-out-of-scope' });
                continue;
            }

            const linkTarget = type === 'symlink' ? await readlink(absolute) : undefined;
            const decision = classifyCheckpointEntry({
                area, path, type, bytes: stat.size, linkTarget, providerStateSessions,
            });
            if (!decision.include) {
                excluded.push({ area, path, reason: decision.reason });
                continue;
            }
            if (type === 'directory') {
                entries.push({ area, path, type, bytes: 0, mode: stat.mode & 0o7777, sha256: EMPTY_SHA256 });
                await visit(path);
                continue;
            }
            if (type === 'symlink') {
                entries.push({
                    area,
                    path,
                    type,
                    bytes: 0,
                    mode: stat.mode & 0o7777,
                    sha256: createHash('sha256').update(linkTarget!).digest('hex'),
                    linkTarget,
                });
                continue;
            }
            if (decision.include && 'sanitize' in decision) {
                // Rewritten rather than copied, so it travels in the manifest:
                // see `inline` there.
                if (stat.size > 64 * 1024) {
                    excluded.push({ area, path, reason: 'too-large' });
                    continue;
                }
                const inline = sanitizeGitConfig(await readFile(absolute, 'utf8'));
                entries.push({
                    area,
                    path,
                    type: 'file',
                    bytes: Buffer.byteLength(inline),
                    mode: stat.mode & 0o7777,
                    sha256: createHash('sha256').update(inline).digest('hex'),
                    inline,
                });
                continue;
            }
            entries.push({
                area,
                path,
                type: 'file',
                bytes: stat.size,
                mode: stat.mode & 0o7777,
                sha256: await fileDigest(absolute),
            });
        }
    };

    await visit('');
    return { entries, excluded };
}

/**
 * The archive, produced only while it is being consumed.
 *
 * `tar.c(...)` returns a stream that starts reading the tree the moment it
 * exists, so building it up front and piping it into the sealer began the work
 * before the sealer had claimed its destination or attached a single error
 * handler. A refusal from the size limit then had nowhere to go and left the
 * process as an uncaught exception — the tar source is not one of the stages
 * `pipeline` owns, so tearing the pipeline down never reached it.
 *
 * As a generator, nothing happens until the sealer pulls: the tar stream is
 * created inside the consumer's first `next()`, every chunk is measured on the
 * way through, and a `throw` here is the pipeline's rejection rather than a
 * loose error on a stream nobody is listening to. Breaking out of the
 * `for await` — which is what a torn-down pipeline does — closes the tar
 * stream through the iterator's own `return`.
 */
function archiveSource(input: {
    root: string;
    paths: string[];
    maxArchiveBytes: number;
}): {
    stream: Readable;
    archiveBytes: () => number;
    digest: () => string;
    /**
     * The entries as the tar stream carried them. Resolves once the parser has
     * seen the end of the stream; a parse failure is returned rather than
     * thrown, because the sealer's own error must win when both happen.
     */
    sealed: () => Promise<{
        entries: Map<string, SealedEntry>;
        /** Headers seen, counted before de-duplication by path. */
        count: number;
        /** Two headers for one path: the later would silently win the map. */
        duplicate: boolean;
        failure: unknown;
    }>;
} {
    const hash = createHash('sha256');
    let archiveBytes = 0;
    /*
     * The bytes that reach the cipher are also handed to a parser, so the
     * comparison below is against what was sealed and not against a second
     * reading of the tree. Only a digest per entry is kept — a 2GB file costs
     * one chunk of memory here as it does in the walk.
     */
    const sealedEntries = new Map<string, SealedEntry>();
    let sealedCount = 0;
    let duplicatePath = false;
    let parseFailure: unknown = null;
    const parser = new tar.Parser({
        strict: true,
        onReadEntry: (entry) => {
            const entryHash = createHash('sha256');
            let bytes = 0;
            entry.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                entryHash.update(chunk);
            });
            entry.on('end', () => {
                const type = entry.type === 'File' ? 'file'
                    : entry.type === 'Directory' ? 'directory'
                        : entry.type === 'SymbolicLink' ? 'symlink'
                            : entry.type === 'Link' ? 'link' : 'other';
                const path = String(entry.path).replace(/\/$/, '');
                sealedCount += 1;
                if (sealedEntries.has(path)) duplicatePath = true;
                sealedEntries.set(path, {
                    type,
                    bytes,
                    mode: typeof entry.mode === 'number' ? entry.mode & 0o7777 : null,
                    // A symlink carries its target in the header, not the body:
                    // digest what the walk digested, which is the target.
                    sha256: type === 'symlink'
                        ? createHash('sha256').update(String(entry.linkpath ?? '')).digest('hex')
                        : entryHash.digest('hex'),
                    linkTarget: type === 'symlink' || type === 'link'
                        ? String(entry.linkpath ?? '')
                        : undefined,
                });
            });
            entry.resume();
        },
    });
    let ended = false;
    let settled = false;
    let settle: () => void = () => undefined;
    const parsed = new Promise<void>((resolve) => {
        settle = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
    });
    /*
     * A malformed stream — a gzip header followed by rubbish — makes the parser
     * report `Z_DATA_ERROR` and then never reach an end of stream, so
     * `parser.end(cb)` alone left this waiting for a completion that could not
     * come: creation hung with the sealed object still on disk, which is worse
     * than the mismatch the check exists to catch. The failure itself is what
     * settles the wait.
     */
    parser.on('error', (error: unknown) => {
        parseFailure ??= error;
        settle();
    });
    const endParser = (): void => {
        if (ended) return;
        ended = true;
        try {
            parser.end(() => settle());
        } catch (error) {
            parseFailure ??= error;
            settle();
        }
    };
    const stream = Readable.from((async function* () {
        // `portable` is off deliberately. It rewrites each entry's mode as
        // `(mode | 0o600) & ~0o22`, which turns Git's read-only loose objects
        // (0o400) into 0o600 — a checkpoint that quietly makes the user's
        // read-only files writable is not a faithful copy of the tree, and the
        // manifest's recorded mode would disagree with what a restore finds.
        // The uid/gid the header then carries are ignored on the way back out
        // (`preserveOwner: false`), and ownership is verified separately.
        const pack = tar.c(
            {
                cwd: input.root,
                gzip: true,
                portable: false,
                noDirRecurse: true,
                follow: false,
                /*
                 * One inode under two carried paths: tar keys a `linkCache` by
                 * `dev:ino` and writes the second path as a `Link` header with no
                 * body. The manifest has no notion of a link group — it says each
                 * path is a file with its own digest — so a cache that remembers
                 * nothing makes the archive hold exactly what the manifest
                 * claims, and the comparison below needs no `Link` grammar and no
                 * second identity for one set of bytes. The cost is the content
                 * once per path, bounded by `maxArchiveBytes` as everything else
                 * is; the hardlink relation is dropped, which was never recorded.
                 */
                linkCache: { get: () => undefined, set: () => undefined } as never,
            },
            input.paths,
        );
        try {
            for await (const chunk of pack) {
                const bytes = chunk as Buffer;
                archiveBytes += bytes.length;
                if (archiveBytes > input.maxArchiveBytes) {
                    throw new Error('managed checkpoint archive is too large');
                }
                hash.update(bytes);
                /*
                 * Once the parser has failed there is nothing left to feed and no
                 * `'drain'` to wait for; the sealer still finishes, and the
                 * failure is answered after it with the sealed object removed.
                 *
                 * `write` is guarded because it can throw **synchronously**, and
                 * that error arrives before any `once` subscription exists to
                 * observe it — the seam where a failure would otherwise be lost.
                 */
                if (parseFailure === null) {
                    let accepted = true;
                    try {
                        accepted = parser.write(bytes);
                    } catch (error) {
                        parseFailure ??= error;
                        settle();
                    }
                    if (parseFailure === null && !accepted) {
                        /*
                         * Raced against the settle for the same reason: a parser
                         * that has errored never emits `'drain'`. `once` rejects
                         * on `'error'`, so its rejection is caught where it is
                         * created rather than on the way out of the race, and the
                         * signal removes the abandoned listener when the settle
                         * wins instead.
                         */
                        const abandon = new AbortController();
                        const drained = once(parser, 'drain', { signal: abandon.signal })
                            .then(() => undefined, () => undefined);
                        await Promise.race([drained, parsed]);
                        abandon.abort();
                    }
                }
                yield bytes;
            }
        } finally {
            // Also on a torn-down pipeline: the parser is ended so nothing is
            // left holding the stream, and the partial entries it collected are
            // never compared — the sealer's failure is the one that surfaces.
            endParser();
        }
    })());
    return {
        stream,
        archiveBytes: () => archiveBytes,
        digest: () => hash.digest('hex'),
        sealed: async () => {
            endParser();
            await parsed;
            return {
                entries: sealedEntries,
                count: sealedCount,
                duplicate: duplicatePath,
                failure: parseFailure,
            };
        },
    };
}

/**
 * Every carried entry, as the manifest will state it, against the bytes the tar
 * stream actually carried. An entry the archive does not hold, and an entry the
 * archive holds that the manifest does not, are both mismatches: the manifest is
 * the restore side's only description of the object.
 */
function sealedMatchesEntries(
    carried: readonly ManagedCheckpointEntry[],
    sealed: { entries: Map<string, SealedEntry>; count: number; duplicate: boolean },
): boolean {
    // Counted, not just keyed: two headers for one path leave a map of the right
    // size whose later entry silently won.
    if (sealed.duplicate) return false;
    if (sealed.count !== carried.length) return false;
    if (sealed.entries.size !== carried.length) return false;
    for (const entry of carried) {
        const actual = sealed.entries.get(entry.path);
        if (!actual) return false;
        if (actual.type !== entry.type) return false;
        if (actual.sha256 !== entry.sha256) return false;
        // Restore refuses on mode as well as on bytes, so a chmod between the
        // walk and the tar read would otherwise publish a checkpoint that
        // cannot be restored even though every byte agrees.
        if (actual.mode === null || actual.mode !== entry.mode) return false;
        // Directories and symlinks carry no body; the walk records 0 for both.
        if (entry.type === 'file' && actual.bytes !== entry.bytes) return false;
        if (entry.type === 'symlink' && actual.linkTarget !== entry.linkTarget) return false;
    }
    return true;
}

const COLLECTED_SHA256 = /^[a-f0-9]{64}$/;

/**
 * The claim itself, checked before anything touches a disk.
 *
 * The path rule is `classifyCheckpointEntry`'s **safe-relative-path throw** and
 * nothing else: its `include` verdict admits `sessions/<id>/…` only, so reading
 * that as validation would refuse every real Claude path a collector reports.
 */
function validateCollectedProviderState(
    claim: readonly CollectedProviderStateFile[] | undefined,
): readonly CollectedProviderStateFile[] | undefined {
    if (claim === undefined) return undefined;
    const seen = new Set<string>();
    /*
     * Copied scalar by scalar, synchronously, before the first `await`. The caller
     * keeps its array, and an archive runs across many awaits — a list that could be
     * swapped, truncated or edited after validation is a list that was checked and
     * then not used.
     */
    const projected: CollectedProviderStateFile[] = [];
    for (const file of claim) {
        if (typeof file?.path !== 'string' || file.path.length === 0) {
            throw new ManagedCheckpointCollectedBytesError('collected-input-invalid');
        }
        try {
            classifyCheckpointEntry({ area: 'provider-state', path: file.path, type: 'file', bytes: 0 });
        } catch {
            throw new ManagedCheckpointCollectedBytesError('collected-input-invalid');
        }
        if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
            throw new ManagedCheckpointCollectedBytesError('collected-input-invalid');
        }
        if (typeof file.sha256 !== 'string' || !COLLECTED_SHA256.test(file.sha256)) {
            throw new ManagedCheckpointCollectedBytesError('collected-input-invalid');
        }
        /*
         * Twice is refused even when the two agree: a list that says one thing
         * twice was not written by the collector, and agreement is not a reason to
         * accept a shape nobody can account for.
         */
        if (seen.has(file.path)) {
            throw new ManagedCheckpointCollectedBytesError('collected-input-duplicate');
        }
        seen.add(file.path);
        projected.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
    }
    return projected;
}

/** The claim against what this area actually sealed. */
function assertCollectedBytes(
    claim: readonly CollectedProviderStateFile[],
    sealed: Map<string, SealedEntry>,
): void {
    // The tar's own entries for this area's stream — area-qualified by being that
    // stream, and the same map the seal check used, so nothing is claimed about a
    // comparison that was made somewhere else.
    for (const file of claim) {
        const entry = sealed.get(file.path);
        if (entry === undefined) throw new ManagedCheckpointCollectedBytesError('collected-bytes-missing');
        // Directories are not bound; a claim about one is a claim about nothing.
        if (entry.type !== 'file') {
            throw new ManagedCheckpointCollectedBytesError('collected-entry-not-a-file');
        }
        if (entry.bytes !== file.bytes || entry.sha256 !== file.sha256) {
            throw new ManagedCheckpointCollectedBytesError('collected-bytes-mismatch');
        }
    }
    const listed = new Set(claim.map((file) => file.path));
    for (const [path, entry] of sealed) {
        // An explicit list is a subset claim over the files carried: one nobody
        // accounted for is what a fake coverage answer would look like.
        if (entry.type === 'file' && !listed.has(path)) {
            throw new ManagedCheckpointCollectedBytesError('collected-bytes-unlisted');
        }
    }
}

export async function createManagedCheckpoint(input: {
    checkpointId: string;
    tenant: { tenantId: string; projectId: string };
    volume: { volumeId: string; deviceUuid: string };
    image: { imageVersion: string };
    sources: CheckpointAreaSource[];
    key: Buffer;
    /** Where the sealed archives are written. */
    outputDir: string;
    /** Session ids that may leave the `provider-state` area. */
    providerStateSessions?: readonly string[];
    /**
     * What a collector read out of the provider-state area, file by file.
     *
     * Omitted: no claim is made and nothing is compared — today's behaviour
     * exactly. `[]`: the claim is that the collection was empty, so any
     * provider-state **file** carried contradicts it. Neither is a project-only
     * fallback, and `[]` with no provider-state area proves nothing either way.
     */
    collectedProviderState?: readonly CollectedProviderStateFile[];
    /** Internal native archive path; no publisher caller is enabled. */
    nativeProviderState?: NativeProviderStateInput;
    now: () => number;
    /** Compressed gzip cap; collector limits do not bound a later tar reread after source growth. */
    maxArchiveBytes?: number;
    /**
     * Told after each area is sealed, so a caller can say **which** area a
     * failure happened in. The areas differ in owner, contents and allowlist, so
     * one word for both is not enough to act on.
     */
    onAreaArchived?: (area: CheckpointArea) => void;
}): Promise<ManagedCheckpointProduct> {
    /*
     * Before `assertUsableRoot`, before `mkdir`, before a single directory is
     * walked: a malformed claim must not cost a walk, an output directory or a
     * sealed byte.
     */
    /*
     * The sources, scalar by scalar, before the first `await`.
     *
     * `input.sources` stays the caller's array. Emptying it after the preflight —
     * which is the first `await` away — made the loop run over nothing and produced
     * an empty manifest as a **success**, while a non-empty collected claim went
     * unchecked. Editing an element's `area` or `root` would redirect what was
     * admitted just as quietly. The preflight and the loop therefore read the same
     * snapshot, and the caller's array is not touched.
     */
    const sources: readonly CheckpointAreaSource[] = input.sources
        .map((source) => ({ area: source.area, root: source.root }));

    // Only metadata reread across native awaits is owned here; keys and unrelated inputs are not copied.
    const bound = input.nativeProviderState === undefined ? input : {
        checkpointId: input.checkpointId,
        tenant: { tenantId: input.tenant.tenantId, projectId: input.tenant.projectId },
        volume: { volumeId: input.volume.volumeId, deviceUuid: input.volume.deviceUuid },
        image: { imageVersion: input.image.imageVersion }, outputDir: input.outputDir, now: input.now,
    };
    if (input.nativeProviderState !== undefined) {
        if ([bound.checkpointId, bound.tenant.tenantId, bound.tenant.projectId, bound.volume.volumeId,
            bound.volume.deviceUuid, bound.image.imageVersion, bound.outputDir].some(value => typeof value !== 'string' || value.length === 0)
            || typeof bound.now !== 'function') throw new ManagedCheckpointNativeStateError('native-input-invalid');
    }
    const native = input.nativeProviderState === undefined ? undefined : prepareNative(
        input.nativeProviderState, sources, bound.tenant.projectId,
        input.providerStateSessions !== undefined || input.collectedProviderState !== undefined,
    );
    const collected = validateCollectedProviderState(native
        ? native.collection.entries.filter(entry => entry.kind !== 'ancestry').map(entry => {
            if (entry.bytes === null || entry.sha256 === null) throw new ManagedCheckpointNativeStateError('native-collection-refused');
            return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
        }) : input.collectedProviderState);
    /*
     * Answered here, beside the input check, because the comparison itself lives in
     * the per-area loop: a claim about files made while no provider-state area was
     * asked for would never be looked at, and the archive would be produced as
     * though nothing had been claimed. Nothing has been read at this point.
     */
    if (collected !== undefined && collected.length > 0
        && !sources.some((source) => source.area === 'provider-state')) {
        throw new ManagedCheckpointCollectedBytesError('collected-bytes-missing');
    }

    const maxArchiveBytes = input.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    const entries: ManagedCheckpointEntry[] = [];
    const excluded: Excluded[] = [];
    const areas: ManagedCheckpointManifest['areas'] = [];
    const worktrees: WorktreeRelation[] = [];
    const objects = new Map<CheckpointArea, string>();
    /** Destinations this call sealed, in order, for its own refusal to undo. */
    const sealedOutputs: string[] = [];
    try {
        native?.checkWindow();
        await mkdir(bound.outputDir, { recursive: true, mode: 0o700 });

        for (const source of sources) {
            native?.checkWindow();
            if (!native || source.area !== 'provider-state') await assertUsableRoot(source.root);
            const relations = source.area === 'project'
                ? await readWorktreeRelations(source.root)
                : { inScope: [], outOfScope: [] };
            native?.checkWindow();
            const walked = native && source.area === 'provider-state' ? await walkNativeArea(native) : await walkArea(
                source.area,
                source.root,
                new Set(relations.outOfScope),
                input.providerStateSessions ?? [],
            );

            const carried = walked.entries.filter((entry) => entry.inline === undefined);
            if (carried.length === 0) {
                /*
                 * tar 에 경로 0개를 주면 라이브러리가 TypeError 를 던진다 — `code` 가
                 * 없어서 상위에서는 "무언가 실패" 로만 보인다. 그 전에 이 runtime 이
                 * 스스로 답한다.
                 */
                throw new ManagedCheckpointAreaEmptyError(
                    source.area === 'project' ? 'area-empty-project' : 'area-empty-provider-state',
                );
            }

            const destination = join(bound.outputDir, `${source.area}.tar.gz.enc`);
            const measure = archiveSource({
                root: source.root,
                // Entries carried inline are not in the tar; the archive holds
                // exactly what the manifest says it holds.
                paths: carried.map((entry) => entry.path),
                maxArchiveBytes,
            });
            native?.checkWindow();
            await sealCheckpointStream({
                source: measure.stream,
                destination,
                key: input.key,
                binding: {
                    tenantId: bound.tenant.tenantId,
                    projectId: bound.tenant.projectId,
                    checkpointId: bound.checkpointId,
                    area: source.area,
                },
            });

            /*
             * 봉인된 바이트가 manifest 와 같은지 **반환 전에** 확인한다. 여기서
             * 거절하면 publisher 의 첫 PUT 이 나가지 않는다 — restore 가 digest
             * 불일치를 발견하는 시점은 이미 pointer 가 published 된 뒤다.
             */
            // Native ownership starts before any measurement/comparison/window failure can occur.
            if (native) sealedOutputs.push(destination);
            const sealedResult = await measure.sealed();
            if (sealedResult.failure !== null || !sealedMatchesEntries(carried, sealedResult)) {
                if (!native) await rm(destination, { force: true }).catch(() => undefined);
                throw new ManagedCheckpointSealMismatchError(
                    source.area === 'project' ? 'sealed-mismatch-project' : 'sealed-mismatch-provider-state',
                );
            }

            if (!native) sealedOutputs.push(destination);
            if (collected !== undefined && source.area === 'provider-state') {
                try {
                    assertCollectedBytes(collected, sealedResult.entries);
                } catch (error) {
                    if (native) throw error;
                    /*
                     * Only what this call sealed, tracked as it sealed it. No filename
                     * is read as ownership, nothing in `outputDir` is scanned, and a
                     * sealer's own failure keeps its own error and its own cleanup —
                     * this path never runs for one.
                     */
                    for (const output of sealedOutputs) {
                        await rm(output, { force: true }).catch(() => undefined);
                    }
                    throw error;
                }
            }

            native?.checkWindow();
            areas.push({
                area: source.area,
                archiveSha256: measure.digest(),
                archiveBytes: measure.archiveBytes(),
                entryCount: walked.entries.filter((entry) => entry.inline === undefined).length,
            });
            objects.set(source.area, destination);
            entries.push(...walked.entries);
            excluded.push(...walked.excluded);
            worktrees.push(...relations.inScope);
            // 이 area 는 봉인까지 끝났다. 실패가 어느 area 에서 났는지 말하려면
            // 끝난 것을 아는 쪽이 있어야 한다.
            input.onAreaArchived?.(source.area);
        }

        let manifest: ManagedCheckpointManifest;
        try {
            const base = {
                checkpointId: bound.checkpointId, tenant: bound.tenant, volume: bound.volume, image: bound.image,
                createdAtMs: bound.now(), areas, entries, excluded, worktrees,
            };
            manifest = native ? {
                ...base, schemaVersion: 2,
                nativeState: {
                    layoutVersion: 1, providerStateScope: native.scope,
                    entries: native.collection.entries.map(entry => ({ path: entry.path, kind: entry.kind, requiredBy: [...entry.requiredBy] })),
                },
            } : { ...base, schemaVersion: MANAGED_CHECKPOINT_MANIFEST_VERSION };
            if (native) manifest = parseManagedCheckpointManifest(serializeManagedCheckpointManifest(manifest));
        } catch (error) {
            if (!native) throw error;
            throw new ManagedCheckpointNativeStateError('native-manifest-invalid');
        }
        const result = { manifest, manifestDigest: checkpointManifestDigest(manifest), objects };
        // All async work and callbacks are complete; do not add an await after this final observation.
        native?.checkWindow();
        return result;
    } catch (error) {
        if (!native) throw error;
        const failure = closedNativeFailure(error);
        let cleanupFailed = false;
        for (const output of sealedOutputs) {
            try { await rm(output, { force: true }); } catch { cleanupFailed = true; }
        }
        if (cleanupFailed) throw new ManagedCheckpointNativeStateError('native-cleanup-failed', failure.code);
        throw failure;
    }
}

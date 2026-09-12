/**
 * Lays a managed checkpoint down — in a temporary tree first, and only then in
 * place.
 *
 * The two remote restore paths that already exist both extract straight onto
 * the target: `restoreWorkspaceRemote.ts:172` runs `tar -xzf … -C
 * "$RESOLVED_WORKSPACE_DIR"`, and `trialMachineRestoreTransfer.ts` checks the
 * archive's sha256 and then `cp -R`s it over the workspace. Either one that
 * fails half way leaves a tree that is neither the old contents nor the new
 * ones, which is exactly the outcome plan §7 forbids: on failure the existing
 * Volume and the completed checkpoint must both still be there.
 *
 * So everything is verified against the manifest in a staging tree — checksums,
 * the exact entry set, types, modes, link targets, ownership, and the scope
 * rule re-applied to what actually arrived — and the destination is not touched
 * until all of it holds. Re-applying the scope on this side is deliberate: the
 * producer already excluded credentials, and a restore that trusted the
 * producer's word for that would import whatever a forged manifest claimed.
 *
 * ## Volumes
 *
 * The checkpoint's volume and the volume being restored onto are different
 * questions and are kept apart. A checkpoint taken on a machine that was
 * destroyed is restored onto a **new** volume — that is the whole point of
 * AC08 — so the manifest's volume is only ever compared against what the caller
 * says it expects the *source* to have been, and never rewritten to match the
 * target. Anything that edited the manifest to agree with the destination would
 * turn the check into a formality.
 *
 * ## Memory
 *
 * Nothing here holds an archive. The sealed object is decrypted through a
 * stream into a staging file, and the extraction is bounded by what the
 * manifest says the archive contains: more entries, a larger file, or more
 * total bytes than were promised is a refusal partway through, not a full disk
 * followed by one.
 *
 * What this does not do is record that a restore happened. That record is
 * `recordManagedRestoreCompletion`, it is written after this returns, and it
 * is not evidence that any of the above ran.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import * as tar from 'tar';
import { createGunzip } from 'node:zlib';
import { claudeStateRequirements, classifyClaudeStateEntry, MANAGED_CLAUDE_CANONICAL_CWD, MANAGED_CLAUDE_PROVIDER_HOME, MANAGED_CLAUDE_PROJECT_SLUG, type ClaudeStateRequirements, type ClaudeSessionDependencies } from './managedClaudeStateLayout';
import { discoverClaudeTranscriptDependencies, deriveClaudeTranscriptDependencies, type ClaudeTranscriptRecord } from './managedClaudeTranscriptDerivation';

import { openCheckpointFile } from './managedCheckpointCrypto';
import { checkpointManifestDigest, parseManagedCheckpointManifest, serializeManagedCheckpointManifest, type ManagedCheckpointManifest, type ManagedCheckpointManifestV2 } from './managedCheckpointManifest';
import {
    managedPromotionJournalPath,
    promoteCheckpointTrees,
    ManagedPromotionError,
} from './managedCheckpointPromotion';
import { classifyCheckpointEntry, type CheckpointArea } from './managedCheckpointScope';

import { parseProviderStateScope, type ProviderStateScopeV1 } from './managedProviderStateScope';

type NativeRestoreLimits = {
    maxArchiveBytesPerArea: number; maxExpandedBytesPerArea: number; maxEntriesPerArea: number;
    maxTarMetaBytes: number; maxTranscriptBytes: number; maxMetaBytes: number; maxArtifactBytes: number;
    maxAggregateReadBytes: number; maxRecords: number;
};

export type ManagedCheckpointRestoreCode =
    | 'native-scope-required' | 'native-input-invalid' | 'native-manifest-invalid'
    | 'native-scope-mismatch' | 'native-budget-exceeded' | 'native-dependency-invalid'
    | 'provider-state-unscoped'
    | 'tenant-mismatch'
    | 'source-volume-mismatch'
    | 'area-missing'
    | 'object-unreadable'
    | 'archive-checksum-mismatch'
    | 'extract-failed'
    | 'archive-exceeds-manifest'
    | 'missing-entry'
    | 'unexpected-entry'
    | 'entry-mismatch'
    | 'forbidden-content'
    | 'ownership-mismatch'
    | 'worktree-repair-failed'
    | 'promotion-failed'
    | 'promotion-unreconciled';

export class ManagedCheckpointRestoreError extends Error {
    constructor(readonly code: ManagedCheckpointRestoreCode) {
        // The code is the whole message. Archive contents, paths and provider
        // text are not put in front of a caller that may relay it onward.
        super(`managed checkpoint restore refused: ${code}`);
        this.name = 'ManagedCheckpointRestoreError';
    }
}

/**
 * Where a boot gets the two things a restore needs besides the key.
 *
 * Deliberately one call: a manifest fetched separately from the objects it
 * describes is a pair that can be mismatched by whoever answers second.
 *
 * `null` is not a failure. It means this project has no checkpoint to restore
 * from, which is the `empty-initialized` path — collapsing it into an error
 * would turn a new project into a failed boot, and collapsing an error into it
 * would clear a volume that has real work on it.
 *
 * The `key` is a live value for this restore only: it is never written to the
 * volume and never carried in the machine's boot input, because that file
 * outlives every checkpoint it could open. Producing it — unwrapping the data
 * key, resolving the latest pointer, fetching the objects — belongs to the
 * parent-side work that lands with T09; nothing here implements it.
 */
export type ManagedCheckpointSource = {
    resolveLatest(): Promise<null | {
        manifest: ManagedCheckpointManifest;
        /** Sealed object files already fetched onto this volume. */
        objects: Map<CheckpointArea, string>;
        key: Buffer;
    }>;
};

function refuse(code: ManagedCheckpointRestoreCode): never {
    throw new ManagedCheckpointRestoreError(code);
}

/**
 * Extraction bounded by the manifest. The archive is not allowed to be larger
 * than what it was said to contain, which is what stops a decompression bomb
 * from filling the volume before any verification runs.
 */
async function extractArchive(archivePath: string, into: string, budget: {
    entries: number;
    totalBytes: number;
    maxFileBytes: number;
}): Promise<void> {
    await mkdir(into, { recursive: true, mode: 0o700 });
    let entries = 0;
    let totalBytes = 0;
    let exceeded = false;
    try {
        await pipeline(createReadStream(archivePath), tar.x({
            cwd: into,
            strict: true,
            preservePaths: false,
            preserveOwner: false,
            // Skipping rather than throwing: an entry that breaches the budget
            // is never written, and every entry after it is skipped too, so
            // the refusal below costs at most what the manifest allowed.
            filter: (_path: string, entry: { size?: number }) => {
                if (exceeded) return false;
                entries += 1;
                totalBytes += entry.size ?? 0;
                if (entries > budget.entries
                    || totalBytes > budget.totalBytes
                    || (entry.size ?? 0) > budget.maxFileBytes) {
                    exceeded = true;
                    return false;
                }
                return true;
            },
        }));
    } catch {
        refuse('extract-failed');
    }
    if (exceeded) refuse('archive-exceeds-manifest');
}

/** V2 bounds decoded bytes (including metadata), then admits each actual member. */
async function extractNativeArchive(archivePath: string, into: string, area: ManagedCheckpointManifestV2['areas'][number],
    members: ManagedCheckpointManifestV2['entries'], limits: NativeRestoreLimits): Promise<void> {
    await mkdir(into, { recursive: true, mode: 0o700 });
    let failure: ManagedCheckpointRestoreCode | undefined;
    let count = 0;
    let bytes = 0;
    const seen = new Set<string>();
    const expected = new Map(members.filter(entry => entry.inline === undefined).map(entry => [entry.path, entry]));
    const extractor = tar.x({
        cwd: into, strict: true, preservePaths: false, preserveOwner: false,
        brotli: false, zstd: false, maxMetaEntrySize: limits.maxTarMetaBytes,
        filter: (path, entry) => {
            if (failure) return false;
            count++;
            if (count > Math.min(limits.maxEntriesPerArea, area.entryCount)) {
                failure = 'archive-exceeds-manifest'; return false;
            }
            if (!('type' in entry)) { failure = 'forbidden-content'; return false; }
            const effective = entry.type === 'Directory' && path.endsWith('/') ? path.slice(0, -1) : path;
            const declared = expected.get(effective);
            if (seen.has(effective)) { failure = 'archive-exceeds-manifest'; return false; }
            seen.add(effective);
            if (!declared || (entry.type !== 'File' && entry.type !== 'Directory' && entry.type !== 'SymbolicLink')
                || declared.type !== (entry.type === 'File' ? 'file' : entry.type === 'Directory' ? 'directory' : 'symlink')
                || (declared.type === 'symlink' && entry.linkpath !== declared.linkTarget)) {
                failure = 'forbidden-content'; return false;
            }
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size !== declared.bytes
                || entry.size > limits.maxExpandedBytesPerArea - bytes) {
                failure = 'archive-exceeds-manifest'; return false;
            }
            bytes += entry.size;
            return true;
        },
    });
    extractor.on('ignoredEntry', () => { failure ??= 'forbidden-content'; });
    let expanded = 0;
    let prefix = Buffer.alloc(0);
    let prefixChecked = false;
    const limiter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            if (failure) { done(new Error('refused')); return; }
            if (chunk.length > limits.maxExpandedBytesPerArea - expanded) {
                failure = 'native-budget-exceeded'; done(new Error('limit')); return;
            }
            expanded += chunk.length;
            if (!prefixChecked) {
                const need = 2 - prefix.length;
                prefix = Buffer.concat([prefix, chunk.subarray(0, need)]);
                if (prefix.length < 2) { done(); return; }
                // tar auto-detects gzip even with gzip:false. Forward neither
                // prefix byte until a split-safe check rules out a second inflate.
                if (prefix[0] === 0x1f && prefix[1] === 0x8b) { done(new Error('nested')); return; }
                prefixChecked = true;
                this.push(prefix);
                if (chunk.length > need) this.push(chunk.subarray(need));
            } else this.push(chunk);
            done();
        },
        flush(done) { done(prefixChecked ? undefined : new Error('short')); },
    });
    try {
        await pipeline(createReadStream(archivePath), createGunzip(), limiter, extractor);
    } catch { refuse(failure ?? 'extract-failed'); }
    if (failure) refuse(failure);
}

type StagedEntry = {
    type: 'file' | 'directory' | 'symlink';
    bytes: number;
    mode: number;
    sha256: string;
    linkTarget?: string;
    uid: number;
};

async function fileDigest(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), async function* (chunks) {
        for await (const chunk of chunks) hash.update(chunk as Buffer);
    });
    return hash.digest('hex');
}

async function readStagedTree(root: string): Promise<Map<string, StagedEntry>> {
    const found = new Map<string, StagedEntry>();
    const visit = async (relative: string): Promise<void> => {
        for (const child of await readdir(relative === '' ? root : join(root, relative))) {
            const path = relative === '' ? child : `${relative}/${child}`;
            const absolute = join(root, path);
            const entry = await lstat(absolute);
            if (entry.isDirectory()) {
                found.set(path, {
                    type: 'directory', bytes: 0, mode: entry.mode & 0o7777, uid: entry.uid,
                    sha256: createHash('sha256').update('').digest('hex'),
                });
                await visit(path);
            } else if (entry.isSymbolicLink()) {
                const linkTarget = await readlink(absolute);
                found.set(path, {
                    type: 'symlink', bytes: 0, mode: entry.mode & 0o7777, uid: entry.uid, linkTarget,
                    sha256: createHash('sha256').update(linkTarget).digest('hex'),
                });
            } else if (entry.isFile()) {
                found.set(path, {
                    type: 'file', bytes: entry.size, mode: entry.mode & 0o7777, uid: entry.uid,
                    sha256: await fileDigest(absolute),
                });
            } else {
                // A device or socket cannot have come from a scope-conforming
                // producer, and there is no manifest entry it could match.
                refuse('forbidden-content');
            }
        }
    };
    await visit('');
    return found;
}

/** Private staging has no other trusted writer. Never interpret temporary paths as Claude roots. */
async function verifyNativeStaging(area: CheckpointArea, root: string, manifest: ManagedCheckpointManifestV2,
    expectedUid: number, limits: NativeRestoreLimits): Promise<void> {
    const members = manifest.entries.filter(entry => entry.area === area);
    const expected = new Map(members.map(entry => [entry.path, entry]));
    const requirements: ClaudeStateRequirements = { ok: true, slug: MANAGED_CLAUDE_PROJECT_SLUG, entries: manifest.nativeState.entries };
    const found = new Map<string, Stats>();
    const visit = async (relative: string): Promise<void> => {
        const directory = await opendir(join(root, relative));
        for await (const child of directory) {
            const path = relative ? `${relative}/${child.name}` : child.name;
            if (found.size >= members.length || !expected.has(path)) refuse('unexpected-entry');
            const declared = expected.get(path)!;
            const actual = await lstat(join(root, path));
            const type = actual.isDirectory() ? 'directory' : actual.isFile() ? 'file' : actual.isSymbolicLink() ? 'symlink' : null;
            if (!type || (area === 'provider-state'
                ? classifyClaudeStateEntry({ path, type }, requirements).kind !== 'required'
                : !classifyCheckpointEntry({ area, path, type, bytes: actual.isFile() ? actual.size : 0, linkTarget: declared.linkTarget }).include)) refuse('forbidden-content');
            if (actual.uid !== expectedUid) refuse('ownership-mismatch');
            if (type !== declared.type || (actual.mode & 0o7777) !== declared.mode
                || !Number.isSafeInteger(actual.size) || actual.size < 0
                || (type === 'file' && actual.size !== declared.bytes)) refuse('entry-mismatch');
            found.set(path, actual);
            if (type === 'directory') {
                if (declared.sha256 !== createHash('sha256').update('').digest('hex')) refuse('entry-mismatch');
                await visit(path);
            } else if (type === 'symlink') {
                const target = await readlink(join(root, path));
                if (target !== declared.linkTarget || createHash('sha256').update(target).digest('hex') !== declared.sha256) refuse('entry-mismatch');
            }
        }
    };
    await visit('');
    if (found.size !== expected.size) refuse('missing-entry');
    let remaining = limits.maxAggregateReadBytes;
    const cache = new Map<string, Buffer>();
    const read = async (path: string, cap: number, retain = true): Promise<Buffer> => {
        const cached = cache.get(path);
        if (cached) return cached;
        const declared = expected.get(path);
        const before = found.get(path);
        if (!declared || !before || declared.type !== 'file') refuse('native-dependency-invalid');
        if (declared.bytes > cap || (retain && declared.bytes > remaining)) refuse('native-budget-exceeded');
        const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const same = (value: Stats) => value.isFile()
                && value.dev === before.dev && value.ino === before.ino && value.size === before.size
                && value.uid === expectedUid && (value.mode & 0o7777) === declared.mode
                && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs;
            if (!same(await handle.stat())) refuse('entry-mismatch');
            const hash = createHash('sha256');
            const buffers: Buffer[] = [];
            const scratch = Buffer.alloc(65536);
            let bytes = 0;
            while (true) {
                const allowance = Math.min(cap - bytes, declared.bytes - bytes, retain ? remaining : cap - bytes);
                const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.length, allowance + 1), null);
                if (retain) remaining -= bytesRead;
                if (bytesRead > allowance) refuse('native-budget-exceeded');
                if (bytesRead === 0) break;
                bytes += bytesRead;
                const chunk = scratch.subarray(0, bytesRead);
                hash.update(chunk);
                if (retain) buffers.push(Buffer.from(chunk));
            }
            if (bytes !== declared.bytes || hash.digest('hex') !== declared.sha256 || !same(await handle.stat())) refuse('entry-mismatch');
            const result = retain ? Buffer.concat(buffers, bytes) : Buffer.alloc(0);
            if (retain) cache.set(path, result);
            return result;
        } finally { await handle.close(); }
    };
    if (area === 'project') {
        for (const entry of members) if (entry.type === 'file') await read(entry.path, limits.maxExpandedBytesPerArea, false);
        return;
    }
    const parse = (buffer: Buffer): ClaudeTranscriptRecord[] => {
        const records: ClaudeTranscriptRecord[] = [];
        let start = 0;
        for (let end = 0; end <= buffer.length; end++) {
            if (end !== buffer.length && buffer[end] !== 10) continue;
            if (end > start) {
                if (records.length >= limits.maxRecords) refuse('native-budget-exceeded');
                try { records.push(JSON.parse(buffer.subarray(start, end).toString('utf8'))); }
                catch { refuse('native-dependency-invalid'); }
            }
            start = end + 1;
        }
        return records;
    };
    const project = `.claude/projects/${MANAGED_CLAUDE_PROJECT_SLUG}`;
    const dependencies = new Map<string, ClaudeSessionDependencies>();
    for (const source of manifest.nativeState.providerStateScope.sources) {
        for (const nativeId of [source.currentNativeId, ...source.retainedNativeIds]) {
            if (dependencies.has(nativeId)) continue;
            const records = parse(await read(`${project}/${nativeId}.jsonl`, limits.maxTranscriptBytes));
            const context = { nativeId, canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD, providerHome: MANAGED_CLAUDE_PROVIDER_HOME, records };
            const discovered = discoverClaudeTranscriptDependencies(context);
            if (!discovered.discovered) refuse('native-dependency-invalid');
            const children = new Map<string, { records: ClaudeTranscriptRecord[]; meta: unknown }>();
            for (const agentId of discovered.agentIds) {
                const base = `${project}/${nativeId}/subagents/agent-${agentId}`;
                const records = parse(await read(`${base}.jsonl`, limits.maxTranscriptBytes));
                const bytes = await read(`${base}.meta.json`, limits.maxMetaBytes);
                let meta: unknown;
                try { meta = JSON.parse(bytes.toString('utf8')); } catch { refuse('native-dependency-invalid'); }
                children.set(agentId, { records, meta });
            }
            const derived = deriveClaudeTranscriptDependencies({ ...context, children });
            if (!derived.derived) refuse('native-dependency-invalid');
            for (const reference of derived.references) {
                const path = `${project}/${nativeId}/tool-results/${reference.segment}`;
                if (expected.get(path)?.bytes !== reference.size) refuse('native-dependency-invalid');
                await read(path, limits.maxArtifactBytes);
            }
            dependencies.set(nativeId, { complete: true, subagents: derived.subagents, references: derived.references });
        }
    }
    const actual = claudeStateRequirements({ providerHome: MANAGED_CLAUDE_PROVIDER_HOME, canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD,
        sources: manifest.nativeState.providerStateScope.sources, dependencies });
    if (!actual.ok || actual.entries.length !== requirements.entries.length
        || cache.size !== members.filter(entry => entry.type === 'file').length) refuse('native-dependency-invalid');
    const associationSet = (entry: ClaudeStateRequirements['entries'][number]) => new Set(entry.requiredBy.map(value => JSON.stringify([value.attemptId, value.nativeId, value.role])));
    for (const entry of actual.entries) {
        const declared = requirements.entries.find(value => value.path === entry.path);
        if (!declared || declared.kind !== entry.kind) refuse('native-dependency-invalid');
        const associations = associationSet(declared);
        const derived = associationSet(entry);
        if (associations.size !== derived.size || [...derived].some(value => !associations.has(value))) refuse('native-dependency-invalid');
    }
}

function verifyArea(
    area: CheckpointArea,
    manifest: ManagedCheckpointManifest,
    staged: Map<string, StagedEntry>,
    expectedUid: number,
    providerStateSessions: readonly string[],
): void {
    const expected = manifest.entries.filter((entry) => entry.area === area);
    // The scope rule is re-applied before anything else, because a forbidden
    // path is refused on its name alone: whether its size and mode happen to
    // agree with the manifest is not what makes it unacceptable.
    for (const entry of expected) {
        const decision = classifyCheckpointEntry({
            area,
            path: entry.path,
            type: entry.type,
            bytes: entry.bytes,
            linkTarget: entry.linkTarget,
            providerStateSessions,
        });
        if (!decision.include) refuse('forbidden-content');
    }
    for (const entry of expected) {
        const actual = staged.get(entry.path);
        if (!actual) refuse('missing-entry');
        if (actual.type !== entry.type
            || actual.sha256 !== entry.sha256
            || actual.bytes !== entry.bytes
            || actual.mode !== entry.mode
            || (entry.type === 'symlink' && actual.linkTarget !== entry.linkTarget)) {
            refuse('entry-mismatch');
        }
        if (actual.uid !== expectedUid) refuse('ownership-mismatch');
    }
    const expectedPaths = new Set(expected.map((entry) => entry.path));
    for (const path of staged.keys()) {
        if (!expectedPaths.has(path)) refuse('unexpected-entry');
    }
}

/**
 * Rebuilds the pair of absolute pointers a linked worktree is made of, at the
 * path this restore is actually landing on.
 *
 * Both files already exist in the staging tree and are only rewritten — never
 * created — so a manifest that named a worktree the archive did not carry is a
 * refusal rather than a new file appearing out of the manifest.
 */
async function repairWorktrees(
    manifest: ManagedCheckpointManifest,
    areaStaging: string,
    destination: string,
): Promise<void> {
    for (const worktree of manifest.worktrees) {
        classifyCheckpointEntry({ area: 'project', path: `${worktree.path}/.git`, type: 'file', bytes: 0 });
        const administrative = join(areaStaging, '.git/worktrees', worktree.name, 'gitdir');
        const pointer = join(areaStaging, worktree.path, '.git');
        const bothPresent = await Promise.all([
            stat(administrative).then((entry) => entry.isFile(), () => false),
            stat(pointer).then((entry) => entry.isFile(), () => false),
        ]);
        if (!bothPresent[0] || !bothPresent[1]) refuse('worktree-repair-failed');
        await writeFile(administrative, `${join(destination, worktree.path, '.git')}\n`);
        await writeFile(pointer, `gitdir: ${join(destination, '.git/worktrees', worktree.name)}\n`);
    }
}

export async function restoreManagedCheckpoint(input: {
    manifest: ManagedCheckpointManifest;
    /** Sealed object file per area. */
    objects: Map<CheckpointArea, string>;
    key: Buffer;
    expected: {
        tenant: { tenantId: string; projectId: string };
        /**
         * The volume the checkpoint must have been taken on. Omitted when any
         * volume of this tenant and project is acceptable — the ordinary case
         * for restoring onto a replacement machine.
         */
        sourceVolume?: { volumeId: string; deviceUuid: string };
        /** The volume being restored onto. Never compared to the manifest. */
        targetVolume: { volumeId: string; deviceUuid: string };
    };
    destinations: Map<CheckpointArea, string>;
    /** Must be on the same filesystem as every destination — promotion renames. */
    stagingRoot: string;
    expectedUid?: number;
    nativeRestore?: { expectedSourceScope: ProviderStateScopeV1; limits: NativeRestoreLimits };
    providerStateSessions?: readonly string[];
    deps?: { rename?: (from: string, to: string) => Promise<void> };
}): Promise<{
    promoted: true;
    checkpointId: string;
    manifestDigest: string;
    sourceVolume: { volumeId: string; deviceUuid: string };
    targetVolume: { volumeId: string; deviceUuid: string };
}> {
    const expectedUid = input.expectedUid ?? process.getuid?.() ?? 0;
    const providerStateSessions = input.providerStateSessions ?? [];
    // Own the plain metadata before the first await. The caller may keep editing
    // its manifest; every check, path, inline write and digest below must describe
    // the same document that passed entry-time policy. V2 also owns the additional
    // scalar/path dependencies below; legacy v1 inputs retain their behavior.
    let manifest = structuredClone(input.manifest);
    if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) refuse('native-manifest-invalid');
    let native: { scope: ProviderStateScopeV1; limits: NativeRestoreLimits } | undefined;
    if (manifest.schemaVersion === 2) {
        try {
            manifest = parseManagedCheckpointManifest(serializeManagedCheckpointManifest(manifest));
        } catch { refuse('native-manifest-invalid'); }
        if (!input.nativeRestore) refuse('native-scope-required');
        if (input.providerStateSessions !== undefined) refuse('native-input-invalid');
        try {
            const raw = input.nativeRestore.expectedSourceScope;
            if (!raw || !Array.isArray(raw.sources) || raw.sources.length > 128
                || Buffer.byteLength(JSON.stringify(raw)) > 262144) refuse('native-input-invalid');
            const scope = parseProviderStateScope(structuredClone(raw));
            const supplied = input.nativeRestore.limits;
            const limits: NativeRestoreLimits = {
                maxArchiveBytesPerArea: supplied.maxArchiveBytesPerArea,
                maxExpandedBytesPerArea: supplied.maxExpandedBytesPerArea,
                maxEntriesPerArea: supplied.maxEntriesPerArea, maxTarMetaBytes: supplied.maxTarMetaBytes,
                maxTranscriptBytes: supplied.maxTranscriptBytes, maxMetaBytes: supplied.maxMetaBytes,
                maxArtifactBytes: supplied.maxArtifactBytes, maxAggregateReadBytes: supplied.maxAggregateReadBytes,
                maxRecords: supplied.maxRecords,
            };
            if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)
                || !Number.isSafeInteger(expectedUid) || expectedUid < 0) refuse('native-input-invalid');
            native = { scope, limits };
        } catch { refuse('native-input-invalid'); }
        if (manifest.schemaVersion !== 2
            || JSON.stringify(native.scope) !== JSON.stringify(parseProviderStateScope(manifest.nativeState.providerStateScope))) {
            refuse('native-scope-mismatch');
        }
        for (const entry of manifest.entries) {
            if (entry.area === 'project' && !classifyCheckpointEntry({ ...entry }).include) refuse('forbidden-content');
        }
        if (manifest.entries.some(entry => !manifest.areas.some(area => area.area === entry.area))) refuse('native-manifest-invalid');
        // Inline writes must not traverse a symlink/file (or an undeclared
        // implicit directory). A safe-looking leaf path alone cannot establish
        // containment when its declared ancestors are non-directories.
        const projectMembers = new Map(manifest.entries.filter(entry => entry.area === 'project').map(entry => [entry.path, entry]));
        for (const entry of projectMembers.values()) {
            const parts = entry.path.split('/');
            for (let depth = 1; depth < parts.length; depth++) {
                if (projectMembers.get(parts.slice(0, depth).join('/'))?.type !== 'directory') refuse('forbidden-content');
            }
        }
        const projectFiles = new Set(manifest.entries.filter(entry => entry.area === 'project' && entry.type === 'file').map(entry => entry.path));
        for (const worktree of manifest.worktrees) {
            if (!worktree.name || worktree.name === '.' || worktree.name === '..' || /[/\\\0]/.test(worktree.name)
                || !projectFiles.has(`.git/worktrees/${worktree.name}/gitdir`)
                || !projectFiles.has(`${worktree.path}/.git`)) refuse('forbidden-content');
        }
        let remaining = native.limits.maxAggregateReadBytes;
        const kinds = new Map(manifest.nativeState.entries.map(entry => [entry.path, entry.kind]));
        for (const area of manifest.areas) {
            if (!input.objects.get(area.area) || !input.destinations.get(area.area)) refuse('area-missing');
            if (!Number.isSafeInteger(area.archiveBytes) || area.archiveBytes <= 0
                || area.archiveBytes > native.limits.maxArchiveBytesPerArea
                || !Number.isSafeInteger(area.entryCount) || area.entryCount > native.limits.maxEntriesPerArea) refuse('native-budget-exceeded');
            let areaRemaining = native.limits.maxExpandedBytesPerArea;
            for (const entry of manifest.entries.filter(entry => entry.area === area.area)) {
                if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > areaRemaining) refuse('native-budget-exceeded');
                areaRemaining -= entry.bytes;
                if (area.area === 'provider-state' && entry.type === 'file') {
                    const kind = kinds.get(entry.path);
                    const cap = kind === 'artifact' ? native.limits.maxArtifactBytes : kind === 'subagent-meta' ? native.limits.maxMetaBytes : native.limits.maxTranscriptBytes;
                    if (entry.bytes > cap || entry.bytes > remaining) refuse('native-budget-exceeded');
                    remaining -= entry.bytes;
                }
            }
        }
    }
    // Only v2 owns the additional scalar/path dependencies; v1 compatibility stays unchanged.
    const options = native ? {
        expected: structuredClone(input.expected), key: input.key, stagingRoot: input.stagingRoot,
        objects: new Map(manifest.areas.map(area => [area.area, input.objects.get(area.area)!])),
        destinations: new Map(manifest.areas.map(area => [area.area, input.destinations.get(area.area)!])),
        deps: input.deps ? { rename: input.deps.rename } : undefined,
    } : input;

    if (manifest.tenant.tenantId !== options.expected.tenant.tenantId
        || manifest.tenant.projectId !== options.expected.tenant.projectId) {
        refuse('tenant-mismatch');
    }
    const sourceVolume = options.expected.sourceVolume;
    if (sourceVolume
        && (manifest.volume.volumeId !== sourceVolume.volumeId
            || manifest.volume.deviceUuid !== sourceVolume.deviceUuid)) {
        refuse('source-volume-mismatch');
    }

    // V1 records no scoped native inventory. Legacy session hints or omission of
    // a provider destination cannot turn it into a verified native restore.
    // Refuse the whole mixed restore before staging or reading either area.
    if (manifest.schemaVersion === 1
        && (manifest.areas.some(area => area.area === 'provider-state')
            || manifest.entries.some(entry => entry.area === 'provider-state'))) {
        refuse('provider-state-unscoped');
    }

    if (manifest.schemaVersion === 1 && input.nativeRestore) refuse('native-manifest-invalid');

    const staging = join(options.stagingRoot, `.managed-checkpoint-${randomUUID()}`);
    let unreconciled = false;
    try {
        await mkdir(staging, { recursive: true, mode: 0o700 });
        const plan: { area: CheckpointArea; staged: string; destination: string; displaced: string }[] = [];

        for (const area of manifest.areas) {
            const sealed = options.objects.get(area.area);
            const destination = options.destinations.get(area.area);
            if (!sealed || !destination) refuse('area-missing');

            const archivePath = join(staging, `${area.area}.tar.gz`);
            let opened: { bytes: number; sha256: string };
            try {
                opened = await openCheckpointFile({
                    source: sealed,
                    destination: archivePath,
                    key: options.key,
                    maxPlaintextBytes: native ? Math.min(native.limits.maxArchiveBytesPerArea, area.archiveBytes) : undefined,
                    binding: {
                        tenantId: manifest.tenant.tenantId,
                        projectId: manifest.tenant.projectId,
                        checkpointId: manifest.checkpointId,
                        area: area.area,
                    },
                });
            } catch {
                refuse('object-unreadable');
            }
            if (opened.sha256 !== area.archiveSha256 || opened.bytes !== area.archiveBytes) {
                refuse('archive-checksum-mismatch');
            }

            const areaEntries = manifest.entries.filter((entry) => entry.area === area.area);
            const areaStaging = join(staging, area.area);
            if (native) await extractNativeArchive(archivePath, areaStaging, area, areaEntries, native.limits);
            else await extractArchive(archivePath, areaStaging, {
                entries: area.entryCount,
                totalBytes: areaEntries.reduce((total, entry) => total + entry.bytes, 0),
                maxFileBytes: areaEntries.reduce((largest, entry) => Math.max(largest, entry.bytes), 0),
            });
            await rm(archivePath, { force: true });

            // Entries the manifest carries itself are written before
            // verification, so every entry is checked the same way.
            for (const entry of areaEntries) {
                if (entry.inline === undefined) continue;
                await mkdir(dirname(join(areaStaging, entry.path)), { recursive: true });
                await writeFile(join(areaStaging, entry.path), entry.inline, { mode: entry.mode });
            }

            if (native && manifest.schemaVersion === 2) {
                try { await verifyNativeStaging(area.area, areaStaging, manifest, expectedUid, native.limits); }
                catch (error) {
                    if (error instanceof ManagedCheckpointRestoreError) throw error;
                    refuse('native-dependency-invalid');
                }
            } else verifyArea(area.area, manifest, await readStagedTree(areaStaging), expectedUid, providerStateSessions);
            if (area.area === 'project') await repairWorktrees(manifest, areaStaging, destination);

            plan.push({
                area: area.area,
                staged: areaStaging,
                destination,
                // A sibling of the destination, never a child of staging: a
                // rollback has to survive staging being cleaned up.
                displaced: `${destination}.saycode-displaced-${manifest.checkpointId.slice(0, 16)}`,
            });
            await mkdir(dirname(destination), { recursive: true });
        }

        try {
            await promoteCheckpointTrees({
                journalPath: managedPromotionJournalPath(options.stagingRoot, manifest.checkpointId),
                checkpointId: manifest.checkpointId,
                entries: plan,
                deps: options.deps,
            });
        } catch (error) {
            if (error instanceof ManagedPromotionError) {
                unreconciled = error.code === 'promotion-unreconciled';
                refuse(error.code);
            }
            throw error;
        }
    } catch (error) {
        if (native && !(error instanceof ManagedCheckpointRestoreError)) refuse('extract-failed');
        throw error;
    } finally {
        // Kept after an unreconciled promotion. The user's data is safe
        // either way — the displaced tree is a sibling of the destination, not
        // a child of staging — but this is the one exit that needs a person,
        // and the decrypted trees it leaves behind are what they will look at.
        if (!unreconciled) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
        promoted: true,
        checkpointId: manifest.checkpointId,
        manifestDigest: checkpointManifestDigest(manifest),
        sourceVolume: manifest.volume,
        targetVolume: options.expected.targetVolume,
    };
}

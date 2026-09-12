/**
 * The manifest a managed checkpoint is verified against.
 *
 * A checkpoint is two things that must not drift apart: the encrypted archives
 * and the statement of what they contain. This file is the statement. It is
 * bound to the tenant, the project, the volume and the image version, because
 * a restore that only checked "the bytes arrived intact" would happily lay
 * another company's project down on this volume — the checksum would pass.
 *
 * `checkpointManifestDigest` is what `recordManagedRestoreCompletion` stores as
 * `manifestDigest`. It is computed over a canonical form so that two encoders
 * of the same manifest cannot disagree; JSON key order is not part of the
 * statement, and every field that is part of it must change the digest.
 *
 * Nothing about retention or cost lives here. Those numbers are undecided, and
 * a default written into a manifest schema becomes the decision.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { claudeStateRequirements, MANAGED_CLAUDE_PROVIDER_HOME, MANAGED_CLAUDE_CANONICAL_CWD } from './managedClaudeStateLayout';
import { parseProviderStateScope } from './managedProviderStateScope';

import { classifyCheckpointEntry } from './managedCheckpointScope';

export const MANAGED_CHECKPOINT_MANIFEST_VERSION = 1;
const MANIFEST_MAX_BYTES = 8_388_608;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(200);

const entrySchema = z.object({
    area: z.enum(['project', 'provider-state']),
    path: z.string().min(1),
    type: z.enum(['file', 'directory', 'symlink']),
    bytes: z.number().int().min(0),
    mode: z.number().int().min(0),
    sha256: sha256Hex,
    linkTarget: z.string().min(1).optional(),
    /**
     * Content carried in the manifest instead of in the archive, for the small
     * files a checkpoint has to rewrite rather than copy — today only the
     * sanitized `.git/config`. The tar cannot hold a version of a file that
     * differs from the one on disk, and the alternative to rewriting it is
     * shipping the credentials in it.
     */
    inline: z.string().max(64 * 1024).optional(),
}).strict();

const excludedSchema = z.object({
    area: z.enum(['project', 'provider-state']),
    path: z.string().min(1),
    reason: z.enum([
        'regeneratable', 'credential', 'personal-history', 'too-large', 'link-escape',
        'unsupported-type', 'not-allowlisted', 'worktree-out-of-scope',
    ]),
}).strict();

const manifestSchema = z.object({
    schemaVersion: z.literal(MANAGED_CHECKPOINT_MANIFEST_VERSION),
    checkpointId: sha256Hex,
    // `company:<id>` or `user:<id>`; see the crypto binding's own note.
    tenant: z.object({ tenantId: identifier, projectId: identifier }).strict(),
    volume: z.object({ volumeId: identifier, deviceUuid: identifier }).strict(),
    image: z.object({ imageVersion: identifier }).strict(),
    createdAtMs: z.number().int().min(0),
    areas: z.array(z.object({
        area: z.enum(['project', 'provider-state']),
        archiveSha256: sha256Hex,
        archiveBytes: z.number().int().min(0),
        entryCount: z.number().int().min(0),
    }).strict()).min(1),
    entries: z.array(entrySchema),
    excluded: z.array(excludedSchema),
    /**
     * Linked worktrees whose working tree lives inside the archived root,
     * recorded as root-relative paths so the pair of absolute pointers can be
     * rebuilt wherever the checkpoint is restored. Registrations pointing
     * outside the root are not listed — they are dropped from the archive.
     */
    worktrees: z.array(z.object({
        name: z.string().min(1),
        path: z.string().min(1),
    }).strict()),
}).strict();

const readNativeScope = parseProviderStateScope;

const nativeEntrySchema = z.object({
    path: z.string().min(1),
    kind: z.enum(['ancestry', 'transcript', 'subagent-records', 'subagent-meta', 'artifact']),
    requiredBy: z.array(z.object({
        attemptId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
        nativeId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        role: z.enum(['current', 'retained']),
    }).strict()).min(1),
}).strict();

const manifestV2Schema = manifestSchema.extend({
    schemaVersion: z.literal(2),
    nativeState: z.object({
        layoutVersion: z.literal(1),
        providerStateScope: z.unknown().transform(readNativeScope),
        entries: z.array(nativeEntrySchema).min(1),
    }).strict(),
}).strict();
const readableManifestSchema = z.discriminatedUnion('schemaVersion', [manifestSchema, manifestV2Schema]);

function rawRecord(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
}

/** Counts precede schema reconstruction and relation maps, not the byte-bounded JSON.parse. */
function checkNativeRawBounds(value: unknown): void {
    const manifest = rawRecord(value);
    if (manifest.schemaVersion !== 2) return;
    const native = rawRecord(manifest.nativeState);
    const scope = rawRecord(native.providerStateScope);
    if (!Array.isArray(scope.sources) || scope.sources.length === 0 || scope.sources.length > 128) throw new Error();
    for (const source of scope.sources) {
        const retained = rawRecord(source).retainedNativeIds;
        if (!Array.isArray(retained) || retained.length > 32) throw new Error();
    }
    if (!Array.isArray(native.entries) || native.entries.length === 0 || native.entries.length > 8192) throw new Error();
    let associations = 0;
    for (const entry of native.entries) {
        const row = rawRecord(entry);
        if (typeof row.path !== 'string' || Buffer.byteLength(row.path, 'utf8') > 1024) throw new Error();
        if (!Array.isArray(row.requiredBy) || row.requiredBy.length === 0 || row.requiredBy.length > 4224) throw new Error();
        associations += row.requiredBy.length;
        if (associations > 32768) throw new Error();
    }
    for (const name of ['areas', 'entries', 'excluded', 'worktrees']) {
        if (!Array.isArray(manifest[name])) throw new Error();
    }
    if (Buffer.byteLength(JSON.stringify(scope), 'utf8') > 262_144
        || Buffer.byteLength(JSON.stringify(native), 'utf8') > 2_097_152
        || Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MANIFEST_MAX_BYTES) throw new Error();
}

export type ManagedCheckpointManifestV1 = z.infer<typeof manifestSchema>;
export type ManagedCheckpointManifestV2 = z.infer<typeof manifestV2Schema>;
export type ManagedCheckpointManifest = ManagedCheckpointManifestV1 | ManagedCheckpointManifestV2;
type V2Manifest = ManagedCheckpointManifestV2;

type NativeEntry = z.infer<typeof nativeEntrySchema>;
type NativeAssociation = NativeEntry['requiredBy'][number];
type DeclaredDependencies = {
    complete: true;
    subagents: { agentId: string }[];
    references: { segment: string; size: number }[];
};
const NATIVE_PROJECT = '.claude/projects/-workspace-project';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function associationKey(by: NativeAssociation): string {
    return JSON.stringify([by.attemptId, by.nativeId, by.role]);
}

function sameAssociations(actual: readonly NativeAssociation[], expected: readonly NativeAssociation[]): boolean {
    const keys = new Set(actual.map(associationKey));
    return keys.size === actual.length && keys.size === expected.length
        && expected.every(by => keys.has(associationKey(by)));
}

/** Declared consistency only: this cannot discover an omitted transcript dependency. */
function validateNativeManifest(manifest: V2Manifest): void {
    const { providerStateScope: scope, entries: inventory } = manifest.nativeState;
    if (scope.generation.projectId !== manifest.tenant.projectId) throw new Error();
    const areas = new Set(manifest.areas.map(area => area.area));
    if (areas.size !== manifest.areas.length || !areas.has('provider-state')) throw new Error();
    const declared = new Map<string, typeof manifest.entries[number]>();
    for (const entry of manifest.entries) {
        const key = JSON.stringify([entry.area, entry.path]);
        if (declared.has(key)) throw new Error();
        declared.set(key, entry);
    }
    const providerEntries = manifest.entries.filter(entry => entry.area === 'provider-state');
    if (providerEntries.length !== inventory.length
        || manifest.areas.find(area => area.area === 'provider-state')!.entryCount !== inventory.length) throw new Error();

    const associations = new Map<string, NativeAssociation[]>();
    const dependencies = new Map<string, DeclaredDependencies>();
    for (const source of scope.sources) {
        const named: { nativeId: string; role: 'current' | 'retained' }[] = [
            { nativeId: source.currentNativeId, role: 'current' },
            ...source.retainedNativeIds.map(nativeId => ({ nativeId, role: 'retained' as const })),
        ];
        for (const { nativeId, role } of named) {
            const by = associations.get(nativeId) ?? [];
            by.push({ attemptId: source.attemptId, nativeId, role });
            associations.set(nativeId, by);
            if (!dependencies.has(nativeId)) dependencies.set(nativeId, { complete: true, subagents: [], references: [] });
        }
    }
    const inventoryByPath = new Map<string, NativeEntry>();
    for (const entry of inventory) {
        if (inventoryByPath.has(entry.path)) throw new Error();
        inventoryByPath.set(entry.path, entry);
        const sealed = declared.get(JSON.stringify(['provider-state', entry.path]));
        if (!sealed || sealed.inline !== undefined || sealed.linkTarget !== undefined) throw new Error();
        if (entry.kind === 'ancestry') {
            if (sealed.type !== 'directory' || sealed.bytes !== 0 || sealed.sha256 !== EMPTY_SHA256) throw new Error();
            continue;
        }
        if (sealed.type !== 'file' || !Number.isSafeInteger(sealed.bytes) || sealed.bytes < 0
            || !entry.path.startsWith(`${NATIVE_PROJECT}/`)) throw new Error();
        const relative = entry.path.slice(NATIVE_PROJECT.length + 1);
        const transcript = /^([^/]+)\.jsonl$/.exec(relative);
        const child = /^([^/]+)\/subagents\/agent-([a-z0-9]{1,64})\.(jsonl|meta\.json)$/.exec(relative);
        const artifact = /^([^/]+)\/tool-results\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(relative);
        const match = entry.kind === 'transcript' ? transcript
            : entry.kind === 'artifact' ? artifact : child;
        if (!match) throw new Error();
        const expected = associations.get(match[1]);
        const dependency = dependencies.get(match[1]);
        // Check leaves before helper expansion: bounded declarations cannot hide large fanout.
        if (!expected || !dependency || !sameAssociations(entry.requiredBy, expected)) throw new Error();
        if (entry.kind === 'subagent-records' || entry.kind === 'subagent-meta') {
            if (match[3] !== (entry.kind === 'subagent-records' ? 'jsonl' : 'meta.json')) throw new Error();
            if (entry.kind === 'subagent-records') dependency.subagents.push({ agentId: match[2] });
        } else if (entry.kind === 'artifact') {
            if (!Number.isSafeInteger(sealed.bytes) || sealed.bytes <= 0) throw new Error();
            dependency.references.push({ segment: match[2], size: sealed.bytes });
        }
    }
    const expected = declaredRequirements(scope.sources, dependencies);
    if (expected.length !== inventory.length) throw new Error();
    for (const entry of expected) {
        const actual = inventoryByPath.get(entry.path);
        if (!actual || actual.kind !== entry.kind || !sameAssociations(actual.requiredBy, entry.requiredBy)) throw new Error();
    }
}

function declaredRequirements(
    sources: Parameters<typeof claudeStateRequirements>[0]['sources'],
    dependencies: ReadonlyMap<string, DeclaredDependencies>,
) {
    const requirements = claudeStateRequirements({
        providerHome: MANAGED_CLAUDE_PROVIDER_HOME,
        canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD,
        sources, dependencies,
    });
    if (!requirements.ok) throw new Error();
    return requirements.entries;
}

export type ManagedCheckpointEntry = z.infer<typeof entrySchema>;

/**
 * Canonical JSON: objects with sorted keys, arrays in their given order.
 * Array order is content, not encoding — reordering entries changes what the
 * manifest says was archived, so it is allowed to change the digest.
 */
function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${fields.join(',')}}`;
}

export function checkpointManifestDigest(manifest: ManagedCheckpointManifest): string {
    return createHash('sha256').update(canonicalize(manifest)).digest('hex');
}

export function serializeManagedCheckpointManifest(manifest: ManagedCheckpointManifest): string {
    if (manifest.schemaVersion === 1) return canonicalize(manifestSchema.parse(manifest));
    try {
        checkNativeRawBounds(manifest);
        const parsed = readableManifestSchema.parse(manifest);
        if (parsed.schemaVersion === 2) validateNativeManifest(parsed);
        return canonicalize(parsed);
    } catch {
        throw new Error('managed checkpoint manifest is not readable');
    }
}

export function parseManagedCheckpointManifest(raw: string): ManagedCheckpointManifest {
    let parsed: unknown;
    try {
        // This common pre-parse bound also limits legacy v1 reads; the v1 writer is unchanged.
        if (Buffer.byteLength(raw, 'utf8') > MANIFEST_MAX_BYTES) throw new Error();
        const value: unknown = JSON.parse(raw);
        checkNativeRawBounds(value);
        const manifest = readableManifestSchema.parse(value);
        if (manifest.schemaVersion === 2) validateNativeManifest(manifest);
        parsed = manifest;
    } catch {
        // The manifest's own contents never reach the caller: it is attacker-
        // reachable input on the restore side.
        throw new Error('managed checkpoint manifest is not readable');
    }
    const manifest = parsed as ManagedCheckpointManifest;
    // Path safety is the scope module's rule, not a second copy of it here —
    // a manifest that names a path the producer could not have produced is
    // refused before anything is extracted against it.
    for (const entry of manifest.entries) {
        try {
            classifyCheckpointEntry({
                area: entry.area,
                path: entry.path,
                type: entry.type,
                bytes: entry.bytes,
                linkTarget: entry.linkTarget,
            });
        } catch (error) {
            if (manifest.schemaVersion === 1) throw error;
            throw new Error('managed checkpoint manifest is not readable');
        }
    }
    return manifest;
}

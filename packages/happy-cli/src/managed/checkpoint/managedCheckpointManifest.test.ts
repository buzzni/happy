import { describe, expect, it, vi } from 'vitest';

import {
    MANAGED_CHECKPOINT_MANIFEST_VERSION,
    checkpointManifestDigest,
    parseManagedCheckpointManifest,
    serializeManagedCheckpointManifest,
    type ManagedCheckpointManifest,
    type ManagedCheckpointManifestV1,
} from './managedCheckpointManifest';

function manifest(overrides: Partial<ManagedCheckpointManifestV1> = {}): ManagedCheckpointManifestV1 {
    return {
        schemaVersion: MANAGED_CHECKPOINT_MANIFEST_VERSION,
        checkpointId: 'a'.repeat(64),
        tenant: { tenantId: 'co_1', projectId: 'pr_1' },
        volume: { volumeId: 'vol_1', deviceUuid: 'dev-1' },
        image: { imageVersion: 'managed-runtime@1.2.3' },
        createdAtMs: 1_700_000_000_000,
        areas: [{ area: 'project', archiveSha256: 'b'.repeat(64), archiveBytes: 128, entryCount: 1 }],
        entries: [{ area: 'project', path: 'src/index.ts', type: 'file', bytes: 10, mode: 0o644, sha256: 'c'.repeat(64) }],
        excluded: [{ area: 'project', path: 'node_modules/x', reason: 'regeneratable' }],
        worktrees: [{ name: 'feature', path: '.worktrees/feature' }],
        ...overrides,
    };
}

describe('managed checkpoint manifest', () => {
    it('shouldRoundTripThroughSerializationUnchanged', () => {
        const value = manifest();
        expect(parseManagedCheckpointManifest(serializeManagedCheckpointManifest(value))).toEqual(value);
    });

    it('shouldRejectAForeignSchemaVersion', () => {
        expect(() => parseManagedCheckpointManifest(JSON.stringify(manifest({ schemaVersion: 2 as never }))))
            .toThrow('managed checkpoint manifest is not readable');
    });

    it('shouldRejectUnknownFieldsRatherThanIgnoringThem', () => {
        const raw = JSON.parse(serializeManagedCheckpointManifest(manifest()));
        raw.retentionDays = 30;
        expect(() => parseManagedCheckpointManifest(JSON.stringify(raw)))
            .toThrow('managed checkpoint manifest is not readable');
    });

    it('shouldRejectAnEntryPathThatEscapesItsArea', () => {
        expect(() => parseManagedCheckpointManifest(serializeManagedCheckpointManifest(manifest({
            entries: [{ area: 'project', path: '../outside', type: 'file', bytes: 1, mode: 0o644, sha256: 'c'.repeat(64) }],
        })))).toThrow('unsafe checkpoint path');
    });

    it('shouldProduceTheSameDigestRegardlessOfKeyOrder', () => {
        const value = manifest();
        const reordered = JSON.parse(JSON.stringify({
            excluded: value.excluded,
            entries: value.entries,
            areas: value.areas,
            createdAtMs: value.createdAtMs,
            image: value.image,
            volume: value.volume,
            worktrees: value.worktrees,
            tenant: { projectId: 'pr_1', tenantId: 'co_1' },
            checkpointId: value.checkpointId,
            schemaVersion: value.schemaVersion,
        })) as ManagedCheckpointManifest;
        expect(checkpointManifestDigest(reordered)).toBe(checkpointManifestDigest(value));
    });

    it('shouldChangeTheDigestWhenAnyBoundFieldChanges', () => {
        const base = checkpointManifestDigest(manifest());
        const mutated = [
            manifest({ tenant: { tenantId: 'co_2', projectId: 'pr_1' } }),
            manifest({ tenant: { tenantId: 'co_1', projectId: 'pr_2' } }),
            manifest({ volume: { volumeId: 'vol_2', deviceUuid: 'dev-1' } }),
            manifest({ image: { imageVersion: 'managed-runtime@1.2.4' } }),
            manifest({ areas: [{ area: 'project', archiveSha256: 'd'.repeat(64), archiveBytes: 128, entryCount: 1 }] }),
            manifest({ entries: [{ area: 'project', path: 'src/index.ts', type: 'file', bytes: 11, mode: 0o644, sha256: 'c'.repeat(64) }] }),
        ].map(checkpointManifestDigest);
        expect(new Set([base, ...mutated]).size).toBe(mutated.length + 1);
    });
});

it('bounds legacy raw UTF-8 bytes before parsing without changing the v1 writer', () => {
    const raw = serializeManagedCheckpointManifest(manifest());
    const exact = raw + ' '.repeat(8_388_608 - Buffer.byteLength(raw));
    expect(parseManagedCheckpointManifest(exact)).toEqual(manifest());
    expect(() => parseManagedCheckpointManifest(exact + ' ')).toThrow('managed checkpoint manifest is not readable');
    const multibyte = serializeManagedCheckpointManifest(manifest({ entries: [], excluded: [], worktrees: [{ name: '한'.repeat(2_800_000), path: 'x' }] }));
    expect(multibyte.length).toBeLessThan(8_388_608);
    expect(() => parseManagedCheckpointManifest(multibyte)).toThrow('managed checkpoint manifest is not readable');
});

// BEGIN identical native manifest vectors (wire data, not a schema implementation).
function nativeVector() {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const project = '.claude/projects/-workspace-project';
    const byA = [
        { attemptId: 'attempt-a', nativeId: a, role: 'current' },
        { attemptId: 'attempt-b', nativeId: a, role: 'retained' },
    ];
    const byB = [{ attemptId: 'attempt-b', nativeId: b, role: 'current' }];
    const inventory = [
        ...['.claude', '.claude/projects', project].map(path => ({ path, kind: 'ancestry', requiredBy: [...byA, ...byB] })),
        { path: `${project}/${a}.jsonl`, kind: 'transcript', requiredBy: byA },
        { path: `${project}/${b}.jsonl`, kind: 'transcript', requiredBy: byB },
        ...[`${project}/${a}`, `${project}/${a}/subagents`, `${project}/${a}/tool-results`].map(path => ({ path, kind: 'ancestry', requiredBy: byA })),
        { path: `${project}/${a}/subagents/agent-abc.jsonl`, kind: 'subagent-records', requiredBy: byA },
        { path: `${project}/${a}/subagents/agent-abc.meta.json`, kind: 'subagent-meta', requiredBy: byA },
        { path: `${project}/${a}/tool-results/tool.txt`, kind: 'artifact', requiredBy: byA },
    ];
    return {
        schemaVersion: 2, checkpointId: 'a'.repeat(64),
        tenant: { tenantId: 'co_1', projectId: 'pr_1' },
        volume: { volumeId: 'vol_1', deviceUuid: 'dev-1' },
        image: { imageVersion: 'image-1' }, createdAtMs: 1,
        areas: [{ area: 'provider-state', archiveSha256: 'b'.repeat(64), archiveBytes: 128, entryCount: inventory.length }],
        entries: inventory.map(entry => ({ area: 'provider-state', path: entry.path,
            type: entry.kind === 'ancestry' ? 'directory' : 'file', bytes: entry.kind === 'ancestry' ? 0 : 1,
            mode: entry.kind === 'ancestry' ? 0o755 : 0o644,
            sha256: entry.kind === 'ancestry' ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' : 'c'.repeat(64),
        })),
        excluded: [], worktrees: [],
        nativeState: { layoutVersion: 1, providerStateScope: {
            version: 1, provider: 'claude', capability: 'native-resume',
            generation: { projectId: 'pr_1', workspaceId: 'ws-1', runtimeId: 'rt-1', epoch: 3, provisioningOperationId: 'op-1' },
            sources: [
                { attemptId: 'attempt-a', runId: 'run-a', happySessionId: 'happy-a', runtimeId: 'rt-1', epoch: 1, currentNativeId: a, retainedNativeIds: [], metadataVersion: 1 },
                { attemptId: 'attempt-b', runId: 'run-b', happySessionId: 'happy-b', runtimeId: 'rt-1', epoch: 3, currentNativeId: b, retainedNativeIds: [a], metadataVersion: 2 },
            ],
        }, entries: inventory },
    };
}
// END identical native manifest vectors.

function readNativeRaw(raw: string): unknown {
    return parseManagedCheckpointManifest(raw);
}

it('reads declared native layout with shared current/retained IDs and historical same-runtime sources', () => {
    const raw = JSON.stringify(nativeVector());
    expect(readNativeRaw(raw)).toEqual(JSON.parse(raw));
});

it('does not upgrade v1 with native metadata', () => {
    const value = nativeVector();
    value.schemaVersion = 1;
    expect(() => readNativeRaw(JSON.stringify(value))).toThrow();
});

// BEGIN identical association refusal vectors.
const associationRefusals = [
    ['missing shared association', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries[3].requiredBy.pop(); }],
    ['duplicate association', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries[3].requiredBy.push(v.nativeState.entries[3].requiredBy[0]); }],
    ['wrong role', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries[3].requiredBy[0].role = 'retained'; }],
    ['foreign attempt', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries[3].requiredBy[0].attemptId = 'foreign'; }],
    ['incomplete ancestor union', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries[0].requiredBy.pop(); }],
] as const;
// END identical association refusal vectors.

it.each(associationRefusals)('refuses %s without returning a partial native manifest', (_name, change) => {
    const value = JSON.parse(JSON.stringify(nativeVector()));
    change(value);
    expect(() => readNativeRaw(JSON.stringify(value))).toThrow();
});

const NATIVE_UNREADABLE = 'managed checkpoint manifest is not readable';

// BEGIN identical native relationship vectors.
const nativeRelationshipRefusals = [
    ['provider count minus one', (v: ReturnType<typeof nativeVector>) => { v.areas[0].entryCount--; }],
    ['provider count plus one', (v: ReturnType<typeof nativeVector>) => { v.areas[0].entryCount++; }],
    ['missing provider area', (v: ReturnType<typeof nativeVector>) => { v.areas[0].area = 'project'; }],
    ['duplicate provider area', (v: ReturnType<typeof nativeVector>) => { v.areas.push({ ...v.areas[0] }); }],
    ['duplicate manifest member', (v: ReturnType<typeof nativeVector>) => { v.entries[4] = { ...v.entries[3] }; }],
    ['duplicate inventory member', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries[4] = structuredClone(v.nativeState.entries[3]); }],
    ['missing manifest member', (v: ReturnType<typeof nativeVector>) => { v.entries.pop(); }],
    ['missing inventory member', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries.pop(); }],
    ['wrong child meta ID', (v: ReturnType<typeof nativeVector>) => {
        v.nativeState.entries[9].path = v.nativeState.entries[9].path.replace('agent-abc', 'agent-def');
        v.entries[9].path = v.nativeState.entries[9].path;
    }],
    ['wrong child meta parent', (v: ReturnType<typeof nativeVector>) => {
        v.nativeState.entries[9].path = v.nativeState.entries[9].path.replace(v.nativeState.providerStateScope.sources[0].currentNativeId, v.nativeState.providerStateScope.sources[1].currentNativeId);
        v.entries[9].path = v.nativeState.entries[9].path;
    }],
    ['missing child meta pair', (v: ReturnType<typeof nativeVector>) => {
        v.nativeState.entries.splice(9, 1); v.entries.splice(9, 1); v.areas[0].entryCount--;
    }],
    ['missing child record pair', (v: ReturnType<typeof nativeVector>) => {
        v.nativeState.entries.splice(8, 1); v.entries.splice(8, 1); v.areas[0].entryCount--;
    }],
    ['missing required transcript', (v: ReturnType<typeof nativeVector>) => {
        v.nativeState.entries.splice(4, 1); v.entries.splice(4, 1); v.areas[0].entryCount--;
    }],
    ['invented ancestry', (v: ReturnType<typeof nativeVector>) => {
        v.nativeState.entries[0].path = '.claude/extra'; v.entries[0].path = '.claude/extra';
    }],
    ['wrong native kind', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries[8].kind = 'subagent-meta'; }],
    ['native file as directory', (v: ReturnType<typeof nativeVector>) => { v.entries[3].type = 'directory'; }],
    ['native symlink', (v: ReturnType<typeof nativeVector>) => { v.entries[3].type = 'symlink'; }],
    ['nonempty ancestor', (v: ReturnType<typeof nativeVector>) => { v.entries[0].bytes = 1; }],
    ['ancestor digest mismatch', (v: ReturnType<typeof nativeVector>) => { v.entries[0].sha256 = 'd'.repeat(64); }],
    ['zero-size artifact', (v: ReturnType<typeof nativeVector>) => { v.entries[10].bytes = 0; }],
    ['unsafe numeric file size', (v: ReturnType<typeof nativeVector>) => { v.entries[3].bytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['foreign runtime', (v: ReturnType<typeof nativeVector>) => { v.nativeState.providerStateScope.sources[0].runtimeId = 'foreign'; }],
    ['future source epoch', (v: ReturnType<typeof nativeVector>) => { v.nativeState.providerStateScope.sources[0].epoch = 4; }],
    ['foreign project', (v: ReturnType<typeof nativeVector>) => { v.nativeState.providerStateScope.generation.projectId = 'foreign'; }],
    ['duplicate source attempt', (v: ReturnType<typeof nativeVector>) => { v.nativeState.providerStateScope.sources[1].attemptId = 'attempt-a'; }],
    ['empty sources', (v: ReturnType<typeof nativeVector>) => { v.nativeState.providerStateScope.sources = []; }],
    ['empty inventory', (v: ReturnType<typeof nativeVector>) => { v.nativeState.entries = []; v.entries = []; v.areas[0].entryCount = 0; }],
    ['unsupported layout', (v: ReturnType<typeof nativeVector>) => { v.nativeState.layoutVersion = 2; }],
    ['unsupported provider', (v: ReturnType<typeof nativeVector>) => { v.nativeState.providerStateScope.provider = 'codex'; }],
    ['unsupported capability', (v: ReturnType<typeof nativeVector>) => { v.nativeState.providerStateScope.capability = 'context-continuation'; }],
] as const;
// END identical native relationship vectors.

it.each(nativeRelationshipRefusals)('refuses %s as closed native metadata', (_name, change) => {
    const value = JSON.parse(JSON.stringify(nativeVector()));
    change(value);
    expect(() => readNativeRaw(JSON.stringify(value))).toThrow(NATIVE_UNREADABLE);
});

it.each(['inline', 'linkTarget', 'unknown'])('refuses a native entry carrying %s', field => {
    const value = JSON.parse(JSON.stringify(nativeVector()));
    value.entries[3][field] = 'x';
    expect(() => readNativeRaw(JSON.stringify(value))).toThrow(NATIVE_UNREADABLE);
});

it('preserves project inline entries without imposing provider tar count rules on them', () => {
    const value = JSON.parse(JSON.stringify(nativeVector()));
    value.areas.push({ area: 'project', archiveSha256: 'd'.repeat(64), archiveBytes: 1, entryCount: 0 });
    value.entries.push({ area: 'project', path: '.git/config', type: 'file', bytes: 1, mode: 0o644, sha256: 'e'.repeat(64), inline: 'x' });
    expect(readNativeRaw(JSON.stringify(value))).toEqual(value);
});

// A post-JSON.parse seam observes whether count gates precede deeper reconstruction.
// The ordinary wire vectors above/below still execute the real JSON parser.
it.each([
    ['sources', 128], ['entries', 8192], ['per-entry associations', 4224], ['total associations', 32768],
] as const)('gates raw %s at its limit before inspecting member fields', (axis, limit) => {
    for (const delta of [0, 1]) {
        const value = JSON.parse(JSON.stringify(nativeVector()));
        let memberReads = 0;
        const poison = Object.defineProperty({}, 'attemptId', { enumerable: true, get() { memberReads++; throw new Error('deep member reached'); } });
        if (axis === 'sources') {
            const source = { retainedNativeIds: [] };
            Object.defineProperty(source, 'attemptId', { enumerable: true, get() { memberReads++; throw new Error('deep member reached'); } });
            value.nativeState.providerStateScope.sources = Array.from({ length: limit + delta }, () => source);
        } else if (axis === 'entries') {
            const entry = { path: 'x', requiredBy: [poison] };
            value.nativeState.entries = Array.from({ length: limit + delta }, () => entry);
        } else if (axis === 'per-entry associations') {
            value.nativeState.entries[0].requiredBy = Array.from({ length: limit + delta }, () => poison);
        } else {
            let remaining = limit + delta;
            value.nativeState.entries = [];
            while (remaining > 0) {
                const count = Math.min(remaining, 4224);
                value.nativeState.entries.push({ path: 'x', requiredBy: Array.from({ length: count }, () => poison) });
                remaining -= count;
            }
        }
        const parse = vi.spyOn(JSON, 'parse').mockReturnValue(value);
        try {
            expect(() => readNativeRaw('{}')).toThrow(NATIVE_UNREADABLE);
            expect(memberReads).toBe(delta === 0 ? 1 : 0);
        } finally { parse.mockRestore(); }
    }
});

it('measures the native path ceiling in UTF-8 before member expansion', () => {
    for (const bytes of [1024, 1025]) {
        const value = JSON.parse(JSON.stringify(nativeVector()));
        value.nativeState.entries[0].path = '한'.repeat(341) + 'x'.repeat(bytes - 1023);
        let memberReads = 0;
        Object.defineProperty(value.nativeState.entries[0].requiredBy[0], 'role', { enumerable: true, get() { memberReads++; throw new Error('deep member reached'); } });
        const parse = vi.spyOn(JSON, 'parse').mockReturnValue(value);
        try {
            expect(() => readNativeRaw('{}')).toThrow(NATIVE_UNREADABLE);
            expect(memberReads).toBe(bytes === 1024 ? 1 : 0);
        } finally { parse.mockRestore(); }
    }
});

it('accepts exact raw byte ceiling and refuses one extra byte for v2', () => {
    const raw = JSON.stringify(nativeVector());
    const exact = raw + ' '.repeat(8_388_608 - Buffer.byteLength(raw));
    expect(readNativeRaw(exact)).toEqual(nativeVector());
    expect(() => readNativeRaw(exact + ' ')).toThrow();
});

it.each(['layoutVersion', 'providerStateScope', 'entries'])('refuses missing native field %s', field => {
    const value = JSON.parse(JSON.stringify(nativeVector()));
    delete value.nativeState[field];
    expect(() => readNativeRaw(JSON.stringify(value))).toThrow(NATIVE_UNREADABLE);
});

it.each([['scope', 262_144], ['native', 2_097_152]] as const)('bounds serialized %s before expanding the full manifest', (axis, limit) => {
    for (const delta of [0, 1]) {
        const value = JSON.parse(JSON.stringify(nativeVector()));
        const target = axis === 'scope' ? value.nativeState.providerStateScope : value.nativeState;
        // Unknown padding is deliberate: this observes the raw gate before strict schema rejection.
        target.padding = '';
        const missing = limit + delta - Buffer.byteLength(JSON.stringify(target));
        target.padding = '한'.repeat(Math.floor(missing / 3)) + 'x'.repeat(missing % 3);
        expect(Buffer.byteLength(JSON.stringify(target))).toBe(limit + delta);
        let fullReads = 0;
        Object.defineProperty(value, 'checkpointId', { enumerable: true, get() { fullReads++; throw new Error('full manifest reached'); } });
        const parse = vi.spyOn(JSON, 'parse').mockReturnValue(value);
        try {
            expect(() => readNativeRaw('{}')).toThrow(NATIVE_UNREADABLE);
            expect(fullReads).toBe(delta === 0 ? 1 : 0);
        } finally { parse.mockRestore(); }
    }
});

it('refuses duplicate project declarations without collapsing them into a map', () => {
    const value = JSON.parse(JSON.stringify(nativeVector()));
    const area = { area: 'project', archiveSha256: 'd'.repeat(64), archiveBytes: 0, entryCount: 0 };
    value.areas.push(area, { ...area });
    expect(() => readNativeRaw(JSON.stringify(value))).toThrow(NATIVE_UNREADABLE);
});

it('keeps exact-case native IDs and does not invent conditional directories', () => {
    const value = JSON.parse(JSON.stringify(nativeVector()));
    const old = value.nativeState.providerStateScope.sources[0].currentNativeId;
    const nativeId = 'ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF';
    // A transcript-only, single-source scope must not require session/subagent directories.
    value.nativeState.providerStateScope.sources = [{ ...value.nativeState.providerStateScope.sources[0], currentNativeId: nativeId }];
    value.nativeState.entries = value.nativeState.entries.slice(0, 4).map((entry: { path: string; kind: string }) => ({
        ...entry, path: entry.path.replace(old, nativeId), requiredBy: [{ attemptId: 'attempt-a', nativeId, role: 'current' }],
    }));
    value.entries = value.entries.slice(0, 4).map((entry: { path: string }) => ({ ...entry, path: entry.path.replace(old, nativeId) }));
    value.areas[0].entryCount = 4;
    expect(readNativeRaw(JSON.stringify(value))).toEqual(value);
    value.nativeState.entries[3].path = value.nativeState.entries[3].path.toLowerCase();
    value.entries[3].path = value.nativeState.entries[3].path;
    expect(() => readNativeRaw(JSON.stringify(value))).toThrow(NATIVE_UNREADABLE);
});

it('serializes strict v2 without changing caller array order or duplicating byte metadata', () => {
    const value = parseManagedCheckpointManifest(JSON.stringify(nativeVector()));
    const before = structuredClone(value);
    const raw = serializeManagedCheckpointManifest(value);
    expect(parseManagedCheckpointManifest(raw)).toEqual(before);
    expect(value).toEqual(before);
    expect(checkpointManifestDigest(value)).toBe(checkpointManifestDigest(JSON.parse(raw)));
    const reversed = structuredClone(value);
    reversed.entries.reverse();
    expect(checkpointManifestDigest(reversed)).not.toBe(checkpointManifestDigest(value));
    expect(parseManagedCheckpointManifest(serializeManagedCheckpointManifest(reversed))).toEqual(reversed);
    if (value.schemaVersion !== 2) throw new Error('v2 fixture');
    value.nativeState.entries[3].requiredBy.pop();
    expect(() => serializeManagedCheckpointManifest(value)).toThrow(NATIVE_UNREADABLE);
});

it('applies the raw inventory count before serializing v2 member data', () => {
    const value = parseManagedCheckpointManifest(JSON.stringify(nativeVector()));
    if (value.schemaVersion !== 2) throw new Error('v2 fixture');
    let reads = 0;
    const entry = value.nativeState.entries[0];
    Object.defineProperty(entry, 'path', { enumerable: true, get() { reads++; throw new Error('member reached'); } });
    value.nativeState.entries = Array.from({ length: 8193 }, () => entry);
    expect(() => serializeManagedCheckpointManifest(value)).toThrow(NATIVE_UNREADABLE);
    expect(reads).toBe(0);
});

it('refuses a complete serialized v2 above the plaintext ceiling without tightening the v1 writer', () => {
    const value = parseManagedCheckpointManifest(JSON.stringify(nativeVector()));
    value.worktrees = [{ name: 'x'.repeat(8_388_608), path: 'x' }];
    expect(() => serializeManagedCheckpointManifest(value)).toThrow(NATIVE_UNREADABLE);
    const legacy = manifest({ worktrees: value.worktrees });
    const raw = serializeManagedCheckpointManifest(legacy);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(8_388_608);
    expect(() => parseManagedCheckpointManifest(raw)).toThrow(NATIVE_UNREADABLE);
});

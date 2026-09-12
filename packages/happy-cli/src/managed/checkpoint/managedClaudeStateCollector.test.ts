/**
 * The collector, against a real tree served through its own observation seam.
 *
 * The canonical roots are not relaxed for tests: the module always builds
 * `/workspace/.codex/...`. What the tests substitute is the *filesystem* — the
 * same handful of calls the module would otherwise make on `node:fs` — so a temp
 * directory can answer for those paths without the module learning a second path
 * policy. A Linux fixture covers what a double cannot honestly simulate
 * (ownership, `O_NOFOLLOW`, a real symlinked component); it is reported separately.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    collectClaudeProviderState,
    type ClaudeCollectorObservation,
} from './managedClaudeStateCollector';
import {
    MANAGED_CLAUDE_CANONICAL_CWD,
    MANAGED_CLAUDE_PROVIDER_HOME,
    MANAGED_CLAUDE_PROJECT_SLUG,
} from './managedClaudeStateLayout';

const PROVIDER_UID = 10601;
const NATIVE = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';
const AGENT = 'a4ec78d2c4e3608ba';
const SEGMENT = 'bwmc1gbmg.txt';
const P = `.claude/projects/${MANAGED_CLAUDE_PROJECT_SLUG}`;

const LIMITS = {
    maxTranscriptBytes: 64 * 1024,
    maxMetaBytes: 8 * 1024,
    maxArtifactBytes: 1024 * 1024,
    maxAggregateBytes: 4 * 1024 * 1024,
    maxEntries: 64,
    maxRecords: 128,
};

const created: string[] = [];
afterEach(() => { while (created.length) rmSync(created.pop()!, { recursive: true, force: true }); });

/** A transcript the pinned derivation accepts: one `Agent` call, one artifact. */
const ARTIFACT_BYTES = 'BIGLINE' + String.fromCharCode(10);

function transcript(over: { withArtifact?: boolean } = {}): string {
    const rows: unknown[] = [
        {
            type: 'assistant', sessionId: NATIVE, uuid: 'a1',
            message: { role: 'assistant', content: [{
                type: 'tool_use', id: 'toolu_agent_1', name: 'Agent',
                input: { description: 'x', prompt: 'y', subagent_type: 'general-purpose', run_in_background: false },
            }] },
        },
        {
            type: 'user', sessionId: NATIVE, uuid: 'a2', sourceToolAssistantUUID: 'a1',
            toolUseResult: { agentId: AGENT, agentType: 'general-purpose', status: 'completed' },
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_1', content: 'ok' }] },
        },
    ];
    if (over.withArtifact) {
        rows.push(
            {
                type: 'assistant', sessionId: NATIVE, uuid: 'b1',
                message: { role: 'assistant', content: [{
                    type: 'tool_use', id: 'toolu_big_1', name: 'Bash',
                    input: { command: 'seq 1 1000', run_in_background: false },
                }] },
            },
            {
                type: 'user', sessionId: NATIVE, uuid: 'b2', sourceToolAssistantUUID: 'b1',
                toolUseResult: {
                    stdout: 'BIGLINE',
                    persistedOutputPath:
                        `/workspace/.codex/.claude/projects/${MANAGED_CLAUDE_PROJECT_SLUG}/${NATIVE}/tool-results/${SEGMENT}`,
                    persistedOutputSize: Buffer.byteLength(ARTIFACT_BYTES),
                },
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_big_1', content: 'ok' }] },
            },
        );
    }
    return rows.map((row) => JSON.stringify(row)).join(String.fromCharCode(10)) + String.fromCharCode(10);
}

function childTranscript(): string {
    const rows = [
        { type: 'user', isSidechain: true, agentId: AGENT, sessionId: NATIVE, uuid: 'c1', message: { role: 'user', content: 'go' } },
        { type: 'assistant', isSidechain: true, agentId: AGENT, sessionId: NATIVE, uuid: 'c2', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ];
    return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function childMeta(): string {
    return JSON.stringify({
        agentType: 'general-purpose',
        description: 'probe subagent',
        toolUseId: 'toolu_agent_1',
        spawnDepth: 1,
        requestShape: 'foreground',
        requestNonInteractive: true,
    });
}

/** A provider home on disk, served under the canonical path by the seam below. */
function providerTree(over: {
    withArtifact?: boolean;
    withSibling?: boolean;
    withNeverFiles?: boolean;
    extraCandidate?: boolean;
} = {}) {
    const root = mkdtempSync(join(tmpdir(), 'collector-home-'));
    created.push(root);
    mkdirSync(join(root, P), { recursive: true });
    writeFileSync(join(root, `${P}/${NATIVE}.jsonl`), transcript({ withArtifact: over.withArtifact }));
    mkdirSync(join(root, `${P}/${NATIVE}/subagents`), { recursive: true });
    writeFileSync(join(root, `${P}/${NATIVE}/subagents/agent-${AGENT}.jsonl`), childTranscript());
    writeFileSync(join(root, `${P}/${NATIVE}/subagents/agent-${AGENT}.meta.json`), childMeta());
    if (over.withArtifact) {
        mkdirSync(join(root, `${P}/${NATIVE}/tool-results`), { recursive: true });
        writeFileSync(join(root, `${P}/${NATIVE}/tool-results/${SEGMENT}`), ARTIFACT_BYTES);
    }
    if (over.withSibling) {
        mkdirSync(join(root, '.claude/projects/-workspace-other'), { recursive: true });
        writeFileSync(join(root, '.claude/projects/-workspace-other/x.jsonl'), '{}\n');
    }
    if (over.withNeverFiles) {
        writeFileSync(join(root, '.claude.json'), '{"secret":1}');
        writeFileSync(join(root, '.claude/settings.local.json'), '{}');
        writeFileSync(join(root, 'config.toml'), 'k=1');
        writeFileSync(join(root, '.claude/history.jsonl'), '{}\n');
        mkdirSync(join(root, '.claude/sessions'), { recursive: true });
        writeFileSync(join(root, '.claude/sessions/x.key'), 'KEY');
        mkdirSync(join(root, '.happy'), { recursive: true });
        writeFileSync(join(root, '.happy/access.key'), 'KEY');
    }
    if (over.extraCandidate) writeFileSync(join(root, `${P}/${NATIVE}.jsonl.tmp`), 'x');
    return root;
}

type SeamCounters = { opens: string[]; dirs: string[]; order: string[] };

/**
 * The filesystem the module talks to, backed by `root`.
 *
 * Paths arrive canonical (`/workspace/.codex/...`); the mapping to `root` happens
 * **here**, in the test's filesystem, never inside the module.
 */
function seam(root: string, over: {
    uidFor?: (path: string) => number;
    modeFor?: (path: string) => number | undefined;
    ancestorsTrusted?: boolean;
    onOpen?: (path: string) => void;
} = {}): ClaudeCollectorObservation & { counters: SeamCounters } {
    const fsp = require('node:fs') as typeof import('node:fs');
    const counters: SeamCounters = { opens: [], dirs: [], order: [] };
    const local = (path: string): string => {
        if (path === MANAGED_CLAUDE_PROVIDER_HOME) return root;
        const rel = relative(MANAGED_CLAUDE_PROVIDER_HOME, path);
        return join(root, rel);
    };
    const decorate = (path: string, stat: { uid: number; mode: number }) => ({
        ...stat,
        uid: over.uidFor ? over.uidFor(path) : PROVIDER_UID,
        mode: over.modeFor?.(path) ?? stat.mode,
    });
    return {
        counters,
        ancestorRefusal: () => (over.ancestorsTrusted === false ? 'untrusted' : null),
        lstat: (path: string) => {
            counters.order.push(`lstat ${path}`);
            const stat = fsp.lstatSync(local(path));
            const based = decorate(path, { uid: stat.uid, mode: stat.mode });
            return {
                uid: based.uid,
                mode: based.mode,
                size: stat.size,
                dev: stat.dev,
                ino: stat.ino,
                mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs,
                isDirectory: stat.isDirectory(),
                isFile: stat.isFile(),
                isSymbolicLink: stat.isSymbolicLink(),
            };
        },
        opendir: (path: string) => {
            counters.dirs.push(path);
            counters.order.push(`opendir ${path}`);
            const handle = fsp.opendirSync(local(path));
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
        open: (path: string) => {
            counters.opens.push(path);
            counters.order.push(`open ${path}`);
            over.onOpen?.(path);
            return fsp.openSync(local(path), fsp.constants.O_RDONLY | fsp.constants.O_NOFOLLOW);
        },
        fstat: (fd: number) => {
            const stat = fsp.fstatSync(fd);
            return {
                uid: over.uidFor ? over.uidFor('fd') : PROVIDER_UID,
                mode: stat.mode,
                size: stat.size,
                dev: stat.dev,
                ino: stat.ino,
                mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs,
                isFile: stat.isFile(),
            };
        },
        read: (fd, buffer, offset, length, position) => fsp.readSync(fd, buffer, offset, length, position),
        close: (fd: number) => fsp.closeSync(fd),
    };
}

function collect(root: string, over: {
    observation?: ReturnType<typeof seam>;
    stillProven?: () => boolean;
    limits?: Partial<typeof LIMITS>;
    sources?: { attemptId: string; currentNativeId: string; retainedNativeIds: string[] }[];
} = {}) {
    const observation = over.observation ?? seam(root);
    const result = collectClaudeProviderState({
        providerHome: MANAGED_CLAUDE_PROVIDER_HOME,
        canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD,
        providerUid: PROVIDER_UID,
        sources: over.sources ?? [{ attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [] }],
        window: { stillProven: over.stillProven ?? (() => true) },
        limits: { ...LIMITS, ...(over.limits ?? {}) },
        observation,
    });
    return { result, observation };
}

describe('what the collector returns for a tree it can account for', () => {
    it('shouldCollectTheTranscriptBothChildFilesAndTheArtifactWithDigestsOfTheBytesItRead', () => {
        const root = providerTree({ withArtifact: true });
        const { result } = collect(root);
        if (!result.collected) throw new Error(`unexpected refusal: ${result.refusal}`);

        const byPath = new Map(result.entries.map((entry) => [entry.path, entry]));
        expect([...byPath.keys()].sort()).toEqual([
            '.claude',
            '.claude/projects',
            P,
            `${P}/${NATIVE}`,
            `${P}/${NATIVE}.jsonl`,
            `${P}/${NATIVE}/subagents`,
            `${P}/${NATIVE}/subagents/agent-${AGENT}.jsonl`,
            `${P}/${NATIVE}/subagents/agent-${AGENT}.meta.json`,
            `${P}/${NATIVE}/tool-results`,
            `${P}/${NATIVE}/tool-results/${SEGMENT}`,
        ].sort());

        // A directory is required for its existence, not for content.
        expect(byPath.get('.claude')).toMatchObject({ kind: 'ancestry', bytes: null, sha256: null });
        // Digests are of the bytes that were read.
        const transcriptEntry = byPath.get(`${P}/${NATIVE}.jsonl`)!;
        expect(transcriptEntry.sha256)
            .toBe(createHash('sha256').update(transcript({ withArtifact: true })).digest('hex'));
        expect(transcriptEntry.bytes).toBe(Buffer.byteLength(transcript({ withArtifact: true })));

        // Every transcript input the derivation reasoned over, meta included.
        expect(result.derivedFrom.map((entry) => entry.path).sort()).toEqual([
            `${P}/${NATIVE}.jsonl`,
            `${P}/${NATIVE}/subagents/agent-${AGENT}.jsonl`,
            `${P}/${NATIVE}/subagents/agent-${AGENT}.meta.json`,
        ].sort());
        expect(result.artifactDigests.map((entry) => entry.path))
            .toEqual([`${P}/${NATIVE}/tool-results/${SEGMENT}`]);
    });

    it('shouldKeepEveryAssociationThatRequiresAPath', () => {
        const root = providerTree();
        const { result } = collect(root, {
            sources: [
                { attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [] },
                { attemptId: 'att_2', currentNativeId: NATIVE, retainedNativeIds: [] },
            ],
        });
        if (!result.collected) throw new Error(`unexpected refusal: ${result.refusal}`);

        const transcriptEntry = result.entries.find((entry) => entry.path === `${P}/${NATIVE}.jsonl`)!;
        expect(transcriptEntry.requiredBy).toEqual([
            { attemptId: 'att_1', nativeId: NATIVE, role: 'current' },
            { attemptId: 'att_2', nativeId: NATIVE, role: 'current' },
        ]);
    });
});

describe('what it refuses to touch', () => {
    it('shouldNeverOpenACredentialOrConfigFileItPassesWhileWalking', () => {
        const root = providerTree({ withNeverFiles: true });
        const { result, observation } = collect(root);
        if (!result.collected) throw new Error(`unexpected refusal: ${result.refusal}`);

        for (const path of observation.counters.opens) {
            expect(path).not.toContain('.claude.json');
            expect(path).not.toContain('settings');
            expect(path).not.toContain('config.toml');
            expect(path).not.toContain('history.jsonl');
            expect(path).not.toContain('sessions/');
            expect(path).not.toContain('.happy');
        }
    });

    it('shouldNotEvenEnumerateADirectoryTheNeverListNames', () => {
        const root = providerTree();
        mkdirSync(join(root, '.claude/statsig'), { recursive: true });
        writeFileSync(join(root, '.claude/statsig/cached.json'), '{}');
        const { result, observation } = collect(root);
        if (!result.collected) throw new Error(`unexpected refusal: ${result.refusal}`);
        expect(observation.counters.dirs.some((dir) => dir.includes('statsig'))).toBe(false);
        expect(observation.counters.order.some((step) => step.includes('statsig/'))).toBe(false);
    });

    it('shouldNotTouchACredentialDirectoryNestedInsideTheProjectsOwnTree', () => {
        /*
         * `.ssh` **under the project slug** is on a candidate path: the descent gate
         * alone would walk into it, and only the final classifier would drop what it
         * found. The never-list has to stop it at the dirent, before a single
         * `lstat`, `opendir` or read.
         */
        const root = providerTree();
        mkdirSync(join(root, `${P}/.ssh`), { recursive: true });
        writeFileSync(join(root, `${P}/.ssh/id_rsa`), 'PRIVATE');
        mkdirSync(join(root, `${P}/${NATIVE}/.aws`), { recursive: true });
        writeFileSync(join(root, `${P}/${NATIVE}/.aws/credentials`), 'SECRET');

        const { result, observation } = collect(root);
        if (!result.collected) throw new Error(`unexpected refusal: ${result.refusal}`);

        for (const step of [...observation.counters.order, ...observation.counters.opens]) {
            expect(step).not.toContain('.ssh');
            expect(step).not.toContain('.aws');
        }
    });

    it('shouldNotDescendIntoAnotherProjectsTree', () => {
        const root = providerTree({ withSibling: true });
        const { result, observation } = collect(root);
        if (!result.collected) throw new Error(`unexpected refusal: ${result.refusal}`);
        expect(observation.counters.dirs.some((dir) => dir.includes('-workspace-other'))).toBe(false);
    });

    it.each([
        ['.claude'],
        [`.claude/projects/${MANAGED_CLAUDE_PROJECT_SLUG}`],
        [`${P}/${NATIVE}/subagents`],
        [`${P}/${NATIVE}/tool-results`],
    ])('shouldRefuseTheSymlinkedComponent %s before reading anything below it', (linked) => {
        /*
         * A **real** symlink dirent at a component this collection would walk, with
         * a complete, valid, same-uid tree behind it. The leaf's `O_NOFOLLOW` says
         * nothing about its ancestors, so without a check here the collector would
         * read a whole session out of wherever the link points and only notice, if
         * at all, as a late `missing-required`.
         *
         * The assertion is therefore about the reads, not only the verdict: nothing
         * below the link is opened, and nothing below it is even stat-ed.
         */
        const real = providerTree({ withArtifact: true });
        const root = mkdtempSync(join(tmpdir(), 'collector-linked-'));
        created.push(root);
        // Everything above the linked component is genuine; the component itself is
        // a link into the complete tree.
        const parent = linked.split('/').slice(0, -1).join('/');
        if (parent.length > 0) mkdirSync(join(root, parent), { recursive: true });
        if (linked === `${P}/${NATIVE}/subagents` || linked === `${P}/${NATIVE}/tool-results`) {
            writeFileSync(join(root, `${P}/${NATIVE}.jsonl`), transcript({ withArtifact: true }));
        }
        symlinkSync(join(real, linked), join(root, linked));

        const { result, observation } = collect(root);

        expect(result).toEqual({ collected: false, refusal: 'component-symlink' });
        // Nothing behind the link — not a byte, and not a stat either.
        expect(observation.counters.opens.filter((path) => path.includes(linked))).toEqual([]);
        expect(observation.counters.order.filter((step) => step.includes(`${linked}/`))).toEqual([]);
    });

    it('shouldRefuseAComponentOwnedByAnotherUid', () => {
        const root = providerTree();
        const { result } = collect(root, {
            observation: seam(root, { uidFor: (path) => (path.endsWith('/projects') ? 0 : PROVIDER_UID) }),
        });
        expect(result).toEqual({ collected: false, refusal: 'component-foreign-uid' });
    });

    it('shouldRefuseAGroupWritableComponent', () => {
        const root = providerTree();
        const { result } = collect(root, {
            observation: seam(root, { modeFor: (path) => (path.endsWith('/projects') ? 0o40770 : undefined) }),
        });
        expect(result).toEqual({ collected: false, refusal: 'component-writable' });
    });

    it('shouldRefuseWhenTheAncestorsOfTheProviderHomeAreNotTrusted', () => {
        const root = providerTree();
        const { result, observation } = collect(root, {
            observation: seam(root, { ancestorsTrusted: false }),
        });
        expect(result).toEqual({ collected: false, refusal: 'provider-home-ancestor-untrusted' });
        expect(observation.counters.dirs).toEqual([]);
    });

    it('shouldLeaveAnUntouchedNeverEntryAloneEvenWhenItIsASymlink', () => {
        const root = providerTree();
        symlinkSync('/etc/shadow', join(root, '.claude.json'));
        const { result, observation } = collect(root);
        // Not refused: the collector is not following it, and refusing would let a
        // file it never touches fail a checkpoint.
        expect(result.collected).toBe(true);
        expect(observation.counters.opens.some((path) => path.includes('.claude.json'))).toBe(false);
    });
});

describe('the window it collects inside', () => {
    it('shouldRefuseBeforeReadingAnythingWhenTheProofIsNotHeld', () => {
        const root = providerTree();
        const { result, observation } = collect(root, { stillProven: () => false });
        expect(result).toEqual({ collected: false, refusal: 'window-not-proven' });
        expect(observation.counters.opens).toEqual([]);
        expect(observation.counters.dirs).toEqual([]);
    });

    it('shouldWithholdEverythingWhenTheProofIsLostDuringCollection', () => {
        const root = providerTree();
        let calls = 0;
        const { result } = collect(root, { stillProven: () => { calls += 1; return calls === 1; } });
        expect(result).toEqual({ collected: false, refusal: 'window-lost' });
    });
});

describe('the caps the caller sets', () => {
    it.each([
        ['maxTranscriptBytes', { maxTranscriptBytes: 8 }, 'too-large'],
        ['maxAggregateBytes', { maxAggregateBytes: 16 }, 'aggregate-too-large'],
        ['maxEntries', { maxEntries: 2 }, 'too-many-entries'],
    ])('shouldRefuseWhen %s is exceeded', (_name, limits, refusal) => {
        const root = providerTree({ withArtifact: true });
        const { result } = collect(root, { limits });
        expect(result).toEqual({ collected: false, refusal });
    });

    it.each([
        ['a missing cap', { maxEntries: undefined as unknown as number }],
        ['a zero cap', { maxRecords: 0 }],
        ['a fractional cap', { maxArtifactBytes: 1.5 }],
    ])('shouldRefuse %s rather than inventing one', (_name, limits) => {
        const root = providerTree();
        const { result } = collect(root, { limits });
        expect(result).toEqual({ collected: false, refusal: 'limits-invalid' });
    });

    it('shouldSpendTheBudgetOnEntriesItPrunesEvenWhenTheRequiredSetIsSmall', () => {
        /*
         * The required set here is tiny and the directory is full of files this
         * collector will never touch. If only retained entries counted, an
         * unbounded directory would pass by being entirely uninteresting.
         */
        const root = providerTree();
        for (let index = 0; index < 40; index += 1) {
            writeFileSync(join(root, `.claude/settings.${index}.json`), '{}');
        }
        const { result } = collect(root, { limits: { maxEntries: 20 } });
        expect(result).toEqual({ collected: false, refusal: 'too-many-entries' });
    });

    it('shouldRefuseWhenTheOpenHandleReportsMoreThanTheCapEvenThoughThePathDidNot', () => {
        // The `lstat` was of a path; the cap has to hold for what was opened.
        const root = providerTree();
        const base = seam(root);
        const observation = {
            ...base,
            counters: base.counters,
            fstat: (fd: number) => ({ ...base.fstat(fd), size: LIMITS.maxTranscriptBytes + 1 }),
        };
        const { result } = collect(root, { observation });
        expect(result).toEqual({ collected: false, refusal: 'too-large' });
    });

    it('shouldCountPrunedSiblingsAgainstTheSameBudget', () => {
        // The budget is consumed by what it observes, not only by what it keeps:
        // otherwise an unbounded directory passes by being entirely uninteresting.
        const root = providerTree({ withSibling: true, withNeverFiles: true });
        const { result } = collect(root, { limits: { maxEntries: 6 } });
        expect(result).toEqual({ collected: false, refusal: 'too-many-entries' });
    });
});

describe('identifiers and roots, before any filesystem call', () => {
    it.each([
        ['an unsupported home', { providerHome: '/workspace/.claude' }, 'home-unsupported'],
        ['an unsupported cwd', { canonicalCwd: '/workspace/other' }, 'cwd-unsupported'],
        ['a root provider uid', { providerUid: 0 }, 'provider-uid-invalid'],
        ['a fractional provider uid', { providerUid: 1.5 }, 'provider-uid-invalid'],
    ])('shouldRefuse %s without touching the filesystem', (_name, over, refusal) => {
        const root = providerTree();
        const observation = seam(root);
        const result = collectClaudeProviderState({
            providerHome: MANAGED_CLAUDE_PROVIDER_HOME,
            canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD,
            providerUid: PROVIDER_UID,
            sources: [{ attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [] }],
            window: { stillProven: () => true },
            limits: LIMITS,
            observation,
            ...over,
        });
        expect(result).toEqual({ collected: false, refusal });
        expect(observation.counters.dirs).toEqual([]);
        expect(observation.counters.opens).toEqual([]);
    });

    it('shouldRefuseASessionIdentifierTheLayoutDoesNotAccept', () => {
        const root = providerTree();
        const { result, observation } = collect(root, {
            sources: [{ attemptId: 'att_1', currentNativeId: 'not-a-uuid', retainedNativeIds: [] }],
        });
        expect(result).toEqual({ collected: false, refusal: 'requirements-refused:native-id-invalid' });
        expect(observation.counters.dirs).toEqual([]);
    });
});

describe('what the parent names, and nothing else', () => {
    it('shouldNeverOpenAChildTheTranscriptDidNotReference', () => {
        const root = providerTree();
        writeFileSync(join(root, `${P}/${NATIVE}/subagents/agent-ffffffffffffffff.jsonl`), childTranscript());
        const { result, observation } = collect(root);
        expect(observation.counters.opens.some((path) => path.includes('ffffffffffffffff'))).toBe(false);
        // It was seen, and nobody accounted for it.
        expect(result).toEqual({ collected: false, refusal: 'unknown-entry' });
    });

    it('shouldRefuseWhenARequiredLeafIsMissing', () => {
        const root = providerTree();
        rmSync(join(root, `${P}/${NATIVE}/subagents/agent-${AGENT}.meta.json`));
        const { result } = collect(root);
        expect(result).toEqual({ collected: false, refusal: 'missing-required' });
    });

    it('shouldCarryTheDiscoveryRefusalRatherThanInventOne', () => {
        const root = mkdtempSync(join(tmpdir(), 'collector-empty-'));
        created.push(root);
        mkdirSync(join(root, P), { recursive: true });
        writeFileSync(join(root, `${P}/${NATIVE}.jsonl`), '');
        const { result } = collect(root);
        expect(result).toEqual({ collected: false, refusal: 'discovery-refused:transcript-empty' });
    });
});

describe('reading a leaf', () => {
    it('shouldRefuseALeafThatChangedBetweenTheStatAndTheOpen', () => {
        const root = providerTree();
        const observation = seam(root, {
            onOpen: (path) => {
                if (path.endsWith(`${NATIVE}.jsonl`)) {
                    writeFileSync(join(root, `${P}/${NATIVE}.jsonl`), `${transcript()}extra\n`);
                }
            },
        });
        const { result } = collect(root, { observation });
        expect(result).toEqual({ collected: false, refusal: 'leaf-swapped' });
    });

    it('shouldCloseEveryDescriptorItOpens, including on a refusal', () => {
        const root = providerTree();
        const opened: number[] = [];
        const closed: number[] = [];
        const base = seam(root);
        const observation = {
            ...base,
            counters: base.counters,
            open: (path: string) => { const fd = base.open(path); opened.push(fd); return fd; },
            close: (fd: number) => { closed.push(fd); base.close(fd); },
        };
        collect(root, { observation });
        expect(closed.sort()).toEqual(opened.sort());
    });
});

describe('the chain it walks before it reads', () => {
    it('shouldHaveLstatAndOpendirTheWholeAncestryBeforeItsFirstContentOpen', () => {
        const root = providerTree({ withArtifact: true });
        const { result, observation } = collect(root);
        if (!result.collected) throw new Error(`unexpected refusal: ${result.refusal}`);

        const order = observation.counters.order;
        const firstOpen = order.findIndex((step) => step.startsWith('open '));
        expect(firstOpen).toBeGreaterThan(0);
        const before = order.slice(0, firstOpen);
        // Every directory on the way to the transcript was checked and enumerated
        // before a single byte was read.
        for (const directory of ['.claude', '.claude/projects', P]) {
            expect(before).toContain(`lstat ${MANAGED_CLAUDE_PROVIDER_HOME}/${directory}`);
            expect(before).toContain(`opendir ${MANAGED_CLAUDE_PROVIDER_HOME}/${directory}`);
        }
    });

    it('shouldEnumerateTheProviderHomeItselfSoItsOwnEntriesAreSeenAndCounted', () => {
        const root = providerTree({ withNeverFiles: true });
        const { result, observation } = collect(root);
        if (!result.collected) throw new Error(`unexpected refusal: ${result.refusal}`);
        // `.claude.json`, `config.toml` and `.happy` live at the home, not under
        // `.claude`; a walk that starts below them never sees them at all.
        expect(observation.counters.dirs).toContain(MANAGED_CLAUDE_PROVIDER_HOME);
    });
});

describe('an artifact the record described', () => {
    it('shouldRefuseWhenItsSizeIsNotTheSizeTheTranscriptRecorded', () => {
        const root = providerTree({ withArtifact: true });
        // The record says one thing, the file says another. The requirements only
        // name paths, so nothing downstream would notice.
        writeFileSync(join(root, `${P}/${NATIVE}/tool-results/${SEGMENT}`), 'BIGLINE-and-more' + String.fromCharCode(10));
        const { result } = collect(root);
        expect(result).toEqual({ collected: false, refusal: 'artifact-size-mismatch' });
    });
});

describe('a leaf that changes under the read', () => {
    it('shouldRefuseAFileThatEndsBeforeTheBytesItPromised', () => {
        // A short read is the file ending early — a different file from the one
        // that was measured, not a partial answer to accept.
        const root = providerTree();
        const base = seam(root);
        const observation = {
            ...base,
            counters: base.counters,
            read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => (
                position === 0 ? base.read(fd, buffer, offset, Math.min(4, length), position) : 0
            ),
        };
        const { result } = collect(root, { observation });
        expect(result).toEqual({ collected: false, refusal: 'leaf-shrank' });
    });

    it('shouldRefuseWhenTheOwnerChangesBetweenTheTwoHandleStats', () => {
        const root = providerTree();
        let stats = 0;
        const base = seam(root);
        const observation = {
            ...base,
            counters: base.counters,
            fstat: (fd: number) => {
                const stat = base.fstat(fd);
                stats += 1;
                // The second stat of the first leaf reports a different owner.
                return stats === 2 ? { ...stat, uid: PROVIDER_UID + 1 } : stat;
            },
        };
        const { result } = collect(root, { observation });
        expect(result).toEqual({ collected: false, refusal: 'leaf-swapped' });
    });
});

describe('the filesystem it uses when nobody injects one', () => {
    it('shouldGoToTheRealFilesystemAndRefuseOnThisMachinesMissingWorkspace', () => {
        /*
         * No `observation`: the module's own defaults. On a developer machine
         * `/workspace` does not exist, so the ancestor check refuses — which is the
         * evidence that the default is `node:fs` and `trustedPathRefusal`, not a
         * double left behind. A machine that *does* have a `/workspace` owned by
         * root would refuse at the provider home instead; both are refusals, and
         * neither reads anything.
         */
        const result = collectClaudeProviderState({
            providerHome: MANAGED_CLAUDE_PROVIDER_HOME,
            canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD,
            providerUid: PROVIDER_UID,
            sources: [{ attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [] }],
            window: { stillProven: () => true },
            limits: LIMITS,
        });
        expect(result.collected).toBe(false);
        expect(['provider-home-ancestor-untrusted', 'provider-home-untrusted'])
            .toContain((result as { refusal: string }).refusal);
    });
});

/*
 * Adopted from Astra's independent review of the frozen collector
 * (`296cace3…`), unchanged in substance: exact-buffer bindings for every kind,
 * associations across current and retained, one open per path, populated static
 * symlinks, descriptor closure on each refusal class, exact caps and one byte
 * under, the entry budget stopping at the first dirent past it with every handle
 * closed, and short reads accumulating rather than truncating.
 */
describe('Astra frozen collector review',()=>{
 it('binds every exact buffer and retains current/retained associations with one open per path',()=>{
  const root=providerTree({withArtifact:true}),observation=seam(root);
  const {result}=collect(root,{observation,sources:[{attemptId:'a',currentNativeId:NATIVE,retainedNativeIds:[NATIVE]},{attemptId:'b',currentNativeId:NATIVE,retainedNativeIds:[]}]});
  expect(result.collected).toBe(true);if(!result.collected)throw Error();
  for(const entry of result.entries){
   expect(entry.requiredBy).toEqual([{attemptId:'a',nativeId:NATIVE,role:'current'},{attemptId:'a',nativeId:NATIVE,role:'retained'},{attemptId:'b',nativeId:NATIVE,role:'current'}]);
   if(entry.kind==='ancestry'){expect(entry.bytes).toBeNull();expect(entry.sha256).toBeNull();continue;}
   const bytes=require('node:fs').readFileSync(join(root,entry.path)),digest=createHash('sha256').update(bytes).digest('hex');
   expect(entry.bytes).toBe(bytes.length);expect(entry.sha256).toBe(digest);
   const source=entry.kind==='artifact'?result.artifactDigests:result.derivedFrom;
   expect(source.filter(x=>x.path===entry.path)).toEqual([{path:entry.path,sha256:digest}]);
   expect(observation.counters.opens.filter(x=>x===MANAGED_CLAUDE_PROVIDER_HOME+'/'+entry.path)).toHaveLength(1);
  }
 });
 it.each(['.claude',P,`${P}/${NATIVE}/subagents`,`${P}/${NATIVE}/tool-results`])('refuses populated static symlink %s before content opens',path=>{
  const root=providerTree({withArtifact:true}),fs=require('node:fs'),destination=mkdtempSync(join(tmpdir(),'astra-linked-'));created.push(destination);fs.rmSync(destination,{recursive:true});fs.renameSync(join(root,path),destination);symlinkSync(destination,join(root,path));
  const {result,observation}=collect(root);expect(result).toEqual({collected:false,refusal:'component-symlink'});expect(observation.counters.opens).toEqual([]);
 });
 it.each(['eof','growth','throw','aggregate'])('closes descriptors on %s refusal',mode=>{
  const root=providerTree(),base=seam(root),opened:number[]=[],closed:number[]=[];
  const observation={...base,open:(p:string)=>{const fd=base.open(p);opened.push(fd);return fd;},close:(fd:number)=>{closed.push(fd);base.close(fd);},read:(fd:number,b:Buffer,o:number,l:number,p:number)=>{if(mode==='throw')throw Error('injected read');if(mode==='eof')return 0;const n=base.read(fd,b,o,l,p);return mode==='growth'&&n===0?1:n;}};
  if(mode==='throw')expect(collect(root,{observation}).result).toEqual({collected:false,refusal:'read-failed'});else expect(collect(root,{observation,limits:mode==='aggregate'?{maxAggregateBytes:1}:{}}).result).toEqual({collected:false,refusal:mode==='eof'?'leaf-shrank':mode==='growth'?'leaf-grew':'aggregate-too-large'});
  expect(opened.length).toBeGreaterThan(0);expect(closed).toEqual(opened);
 });
 it('accepts exact byte caps and refuses one less per leaf class and aggregate',()=>{
  const root=providerTree({withArtifact:true});const transcriptCap=Math.max(Buffer.byteLength(transcript({withArtifact:true})),Buffer.byteLength(childTranscript())),metaCap=Buffer.byteLength(childMeta()),aggregate=Buffer.byteLength(transcript({withArtifact:true}))+Buffer.byteLength(childTranscript())+metaCap+8;
  const limits={maxTranscriptBytes:transcriptCap,maxMetaBytes:metaCap,maxArtifactBytes:8,maxAggregateBytes:aggregate};expect(collect(root,{limits}).result.collected).toBe(true);
  for(const key of Object.keys(limits) as (keyof typeof limits)[])expect(collect(root,{limits:{...limits,[key]:limits[key]-1}}).result).toEqual({collected:false,refusal:key==='maxAggregateBytes'?'aggregate-too-large':'too-large'});
 });
});

describe('Astra enumeration and short reads',()=>{
 it('closes all ancestor directory handles at the first entry beyond budget',()=>{
  const root=providerTree({withNeverFiles:true}),base=seam(root);let opened=0,closed=0,entries=0;
  const observation={...base,opendir:(path:string)=>{const dir=base.opendir(path);opened++;return {read:()=>{const entry=dir.read();if(entry)entries++;return entry;},close:()=>{closed++;dir.close();}};}};
  expect(collect(root,{observation,limits:{maxEntries:3}}).result).toEqual({collected:false,refusal:'too-many-entries'});expect(entries).toBe(4);expect(opened).toBeGreaterThan(0);expect(closed).toBe(opened);expect(base.counters.opens).toEqual([]);
 });
 it('accumulates short reads and preserves the meta digest',()=>{
  const root=providerTree(),base=seam(root);const {result}=collect(root,{observation:{...base,read:(fd,b,o,l,p)=>base.read(fd,b,o,Math.min(l,3),p)}});expect(result.collected).toBe(true);if(!result.collected)throw Error();expect(result.entries.find(x=>x.kind==='subagent-meta')?.sha256).toBe(createHash('sha256').update(childMeta()).digest('hex'));
 });
});

describe('a failure this module did not classify', () => {
    it.each(['EIO', 'EACCES'])('shouldAnswerOneFixedCodeForAn %s and name no path', (code) => {
        /*
         * `node:fs` errors carry the absolute path they failed on, and this walk is
         * inside the provider's home. Letting one escape would hand the caller —
         * and any log it reaches — the names of files in a tree it is not entitled
         * to read. The answer is one closed code, and never a success.
         */
        const root = providerTree({ withArtifact: true });
        const base = seam(root);
        const opened: number[] = [];
        const closed: number[] = [];
        const dirs: number[] = [];
        const dirsClosed: number[] = [];
        let handle = 0;
        const secret = '/workspace/.codex/.claude/projects/-workspace-project/SECRET-NAME.jsonl';
        const observation = {
            ...base,
            counters: base.counters,
            opendir: (path: string) => {
                const dir = base.opendir(path);
                const id = handle += 1;
                dirs.push(id);
                return { read: () => dir.read(), close: () => { dirsClosed.push(id); dir.close(); } };
            },
            open: (path: string) => { const fd = base.open(path); opened.push(fd); return fd; },
            close: (fd: number) => { closed.push(fd); base.close(fd); },
            read: () => {
                throw Object.assign(new Error(`${code}: i/o error, read '${secret}'`), { code, path: secret });
            },
        };

        const { result } = collect(root, { observation });

        expect(result).toEqual({ collected: false, refusal: 'read-failed' });
        expect(JSON.stringify(result)).not.toContain('SECRET-NAME');
        expect(JSON.stringify(result)).not.toContain(code);
        // Everything it opened, it closed — descriptors and directory handles.
        expect(closed).toEqual(opened);
        // Closed as the walk unwinds, so the order is reversed — every one of them.
        expect([...dirsClosed].sort()).toEqual([...dirs].sort());
    });
});

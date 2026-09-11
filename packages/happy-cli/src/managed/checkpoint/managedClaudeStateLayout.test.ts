/**
 * The layout, against the shapes that were actually measured.
 *
 * Names here are the pinned Linux fixture's own — session
 * `d6da1867-afd5-4637-bd7e-52a3e28c2fb8`, agent `a4ec78d2c4e3608ba`, artifact
 * `bwmc1gbmg.txt` — so a test failing means the module disagrees with a real
 * provider run rather than with something invented for it.
 */
import { describe, expect, it } from 'vitest';

import {
    claudeStateRequirements,
    classifyClaudeStateEntry,
    reconcileClaudeState,
    MANAGED_CLAUDE_CANONICAL_CWD,
    MANAGED_CLAUDE_PROVIDER_HOME,
    MANAGED_CLAUDE_PROJECT_SLUG,
} from './managedClaudeStateLayout';

const NATIVE = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';
const OTHER_NATIVE = '11111111-2222-4333-8444-555555555555';
const AGENT = 'a4ec78d2c4e3608ba';
const SEGMENT = 'bwmc1gbmg.txt';
const P = `.claude/projects/${MANAGED_CLAUDE_PROJECT_SLUG}`;

function roots() {
    return { providerHome: MANAGED_CLAUDE_PROVIDER_HOME, canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD };
}

function complete(overrides: {
    subagents?: { agentId: string }[];
    references?: { segment: string; size: number }[];
} = {}) {
    return {
        complete: true as const,
        subagents: overrides.subagents ?? [{ agentId: AGENT }],
        references: overrides.references ?? [{ segment: SEGMENT, size: 214893 }],
    };
}

function requirements(input: {
    sources?: { attemptId: string; currentNativeId: string; retainedNativeIds: string[] }[];
    dependencies?: Map<string, ReturnType<typeof complete> | { complete: false }>;
} = {}) {
    return claudeStateRequirements({
        ...roots(),
        sources: input.sources ?? [{ attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [] }],
        dependencies: input.dependencies ?? new Map([[NATIVE, complete()]]),
    });
}

describe('the required set for a measured session', () => {
    it('shouldNameTheTranscriptBothSubagentFilesTheArtifactAndEveryAncestorIncludingTheSessionDirectory', () => {
        const result = requirements();
        if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);

        expect(result.entries.map((entry) => `${entry.kind} ${entry.path}`).sort()).toEqual([
            `ancestry .claude`,
            `ancestry .claude/projects`,
            `ancestry ${P}`,
            `ancestry ${P}/${NATIVE}`,
            `ancestry ${P}/${NATIVE}/subagents`,
            `ancestry ${P}/${NATIVE}/tool-results`,
            `artifact ${P}/${NATIVE}/tool-results/${SEGMENT}`,
            `subagent-meta ${P}/${NATIVE}/subagents/agent-${AGENT}.meta.json`,
            `subagent-records ${P}/${NATIVE}/subagents/agent-${AGENT}.jsonl`,
            `transcript ${P}/${NATIVE}.jsonl`,
        ].sort());
    });

    it('shouldRequireOnlyTheAncestorsOfLeavesThatExistForABasicParentOnlySession', () => {
        // The canonical minimal case: one transcript, no subagent, no artifact.
        // The session directory is never created, so requiring it would report a
        // healthy session as missing state it never had.
        const result = requirements({
            dependencies: new Map([[NATIVE, complete({ subagents: [], references: [] })]]),
        });
        if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);

        expect(result.entries.map((entry) => `${entry.kind} ${entry.path}`).sort()).toEqual([
            'ancestry .claude',
            'ancestry .claude/projects',
            `ancestry ${P}`,
            `transcript ${P}/${NATIVE}.jsonl`,
        ].sort());
    });

    it('shouldRequireTheSessionDirectoryForSubagentsWithoutRequiringToolResults', () => {
        const result = requirements({
            dependencies: new Map([[NATIVE, complete({ references: [] })]]),
        });
        if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
        const paths = result.entries.map((entry) => entry.path);
        expect(paths).toContain(`${P}/${NATIVE}`);
        expect(paths).toContain(`${P}/${NATIVE}/subagents`);
        expect(paths).not.toContain(`${P}/${NATIVE}/tool-results`);
    });

    it('shouldRequireToolResultsWithoutRequiringSubagents', () => {
        const result = requirements({
            dependencies: new Map([[NATIVE, complete({ subagents: [] })]]),
        });
        if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
        const paths = result.entries.map((entry) => entry.path);
        expect(paths).toContain(`${P}/${NATIVE}`);
        expect(paths).toContain(`${P}/${NATIVE}/tool-results`);
        expect(paths).not.toContain(`${P}/${NATIVE}/subagents`);
    });

    it('shouldRefuseWhenNoSourceNamedASession', () => {
        // Absence of a scope is not evidence that a run held no provider state,
        // and an `ok` with no entries would be read as "nothing to carry".
        expect(claudeStateRequirements({
            ...roots(), sources: [], dependencies: new Map(),
        })).toEqual({ ok: false, refusal: 'sources-absent' });
    });

    it('shouldRefuseASessionWhoseDependenciesAreNotComplete', () => {
        // A derivation that refused says nothing about what the session needs.
        // Treating its partial answer as the required set would turn "we do not
        // know" into "this is everything", which is the coverage claim this
        // module must never make on its own.
        const result = requirements({ dependencies: new Map([[NATIVE, { complete: false }]]) });
        expect(result).toEqual({ ok: false, refusal: 'dependencies-incomplete' });
    });

    it('shouldRefuseASessionWithNoDependencyEntryAtAll', () => {
        const result = requirements({ dependencies: new Map() });
        expect(result).toEqual({ ok: false, refusal: 'dependencies-missing' });
    });
});

describe('current and retained sessions across sources', () => {
    it('shouldKeepEveryNativeIdAndRecordWhichSourceAndRoleRequiredIt', () => {
        const result = requirements({
            sources: [
                { attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [OTHER_NATIVE] },
                { attemptId: 'att_2', currentNativeId: OTHER_NATIVE, retainedNativeIds: [] },
            ],
            dependencies: new Map([
                [NATIVE, complete()],
                [OTHER_NATIVE, complete({ subagents: [], references: [] })],
            ]),
        });
        if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);

        expect(result.entries.some((entry) => entry.path === `${P}/${OTHER_NATIVE}.jsonl`)).toBe(true);
        const shared = result.entries.find((entry) => entry.path === `${P}/${OTHER_NATIVE}.jsonl`)!;
        // One physical path, both associations kept: retained by att_1 and
        // current for att_2. Collapsing them would lose the reason a file is
        // carried, which is what a later coverage answer has to cite.
        expect(shared.requiredBy).toEqual([
            { attemptId: 'att_1', nativeId: OTHER_NATIVE, role: 'retained' },
            { attemptId: 'att_2', nativeId: OTHER_NATIVE, role: 'current' },
        ]);
    });

    it('shouldListEachPathOnceEvenWhenManySessionsShareItsAncestors', () => {
        const result = requirements({
            sources: [{ attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [OTHER_NATIVE] }],
            dependencies: new Map([
                [NATIVE, complete()],
                [OTHER_NATIVE, complete({ subagents: [], references: [] })],
            ]),
        });
        if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);

        const paths = result.entries.map((entry) => entry.path);
        expect(new Set(paths).size).toBe(paths.length);
        const ancestor = result.entries.find((entry) => entry.path === P)!;
        expect(ancestor.requiredBy.map((by) => `${by.attemptId}:${by.nativeId}`)).toEqual([
            `att_1:${NATIVE}`, `att_1:${OTHER_NATIVE}`,
        ]);
    });
});

describe('the roots this module supports', () => {
    it.each([
        ['/workspace/other', 'slug-unsupported-cwd'],
        ['/workspace/project/', 'slug-unsupported-cwd'],
        ['workspace/project', 'slug-unsupported-cwd'],
    ])('shouldRefuseTheUnmeasuredWorkingDirectory %s', (canonicalCwd, refusal) => {
        expect(claudeStateRequirements({
            providerHome: MANAGED_CLAUDE_PROVIDER_HOME,
            canonicalCwd,
            sources: [{ attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [] }],
            dependencies: new Map([[NATIVE, complete()]]),
        })).toEqual({ ok: false, refusal });
    });

    it.each(['/workspace/.claude', '/home/agent', '/workspace/.codex/'])(
        'shouldRefuseTheUnmeasuredProviderHome %s',
        (providerHome) => {
            expect(claudeStateRequirements({
                providerHome,
                canonicalCwd: MANAGED_CLAUDE_CANONICAL_CWD,
                sources: [{ attemptId: 'att_1', currentNativeId: NATIVE, retainedNativeIds: [] }],
                dependencies: new Map([[NATIVE, complete()]]),
            })).toEqual({ ok: false, refusal: 'state-root-unsupported' });
        },
    );
});

describe('identifiers and names', () => {
    it('shouldRefuseANativeIdOutsideTheUuidGrammar', () => {
        expect(requirements({
            sources: [{ attemptId: 'att_1', currentNativeId: 'not-a-uuid', retainedNativeIds: [] }],
            dependencies: new Map([['not-a-uuid', complete()]]),
        })).toEqual({ ok: false, refusal: 'native-id-invalid' });
    });

    it('shouldRefuseAnAgentIdOutsideTheMeasuredGrammar', () => {
        expect(requirements({
            dependencies: new Map([[NATIVE, complete({ subagents: [{ agentId: 'Agent-One' }] })]]),
        })).toEqual({ ok: false, refusal: 'agent-id-invalid' });
    });

    it.each(['../escape', 'a/b', '.hidden', ''])('shouldRefuseTheArtifactName %s', (segment) => {
        expect(requirements({
            dependencies: new Map([[NATIVE, complete({ references: [{ segment, size: 1 }] })]]),
        })).toEqual({ ok: false, refusal: 'reference-segment-invalid' });
    });

    it.each([0, -1, 1.5, Number.NaN])('shouldRefuseTheRecordedArtifactSize %s', (size) => {
        // Aligned with the derivation: strictly positive, so a zero-byte artifact
        // is refused rather than required.
        expect(requirements({
            dependencies: new Map([[NATIVE, complete({ references: [{ segment: SEGMENT, size }] })]]),
        })).toEqual({ ok: false, refusal: 'reference-size-invalid' });
    });

    it('shouldNotMatchASessionDirectoryThatDiffersOnlyInCase', () => {
        const result = requirements();
        if (!result.ok) throw new Error('unexpected refusal');
        const verdict = classifyClaudeStateEntry(
            { path: `${P}/${NATIVE.toUpperCase()}.jsonl`, type: 'file' },
            result,
        );
        // The id grammar ignores case; the value never does. A folded match here
        // would carry one session's file as another's.
        expect(verdict.kind).not.toBe('required');
    });
});

describe('classifying an enumerated entry', () => {
    function verdictFor(path: string, type: 'file' | 'directory' | 'symlink' | 'other' = 'file') {
        const result = requirements();
        if (!result.ok) throw new Error('unexpected refusal');
        return classifyClaudeStateEntry({ path, type }, result);
    }

    it('shouldCallEveryRequiredPathRequiredAndSayWhichKind', () => {
        expect(verdictFor(`${P}/${NATIVE}.jsonl`)).toMatchObject({ kind: 'required', required: 'transcript' });
        expect(verdictFor(`${P}/${NATIVE}/subagents`, 'directory'))
            .toMatchObject({ kind: 'required', required: 'ancestry' });
    });

    it.each([
        '.claude/.credentials.json',
        '.codex/auth.json',
        'auth.json',
        '.netrc',
        '.git-credentials',
        'history.jsonl',
        '.claude.json',
        '.claude/settings.json',
        '.claude/settings.local.json',
        '.happy/access.key',
        '.ssh/id_rsa',
        // Not covered by the product's list — excluded here by name.
        '.claude/sessions/abc.key',
        '.claude/sessions/another-session.key',
        'config.toml',
        '.claude/history.jsonl',
        '.claude/statsig/statsig.cached.evaluations',
        '.happy',
    ])('shouldCall %s never, whatever else it might look like', (path) => {
        expect(verdictFor(path).kind).toBe('never');
    });

    it('shouldReportWhichRuleExcludedEachOfTheContractsOwnEntries', () => {
        expect(verdictFor('.claude/sessions/abc.key')).toEqual({ kind: 'never', rule: 'session-key' });
        expect(verdictFor('config.toml')).toEqual({ kind: 'never', rule: 'provider-config' });
        expect(verdictFor('.claude/history.jsonl')).toEqual({ kind: 'never', rule: 'personal-history' });
        expect(verdictFor('.happy/access.key')).toEqual({ kind: 'never', rule: 'runtime-state' });
    });

    it('shouldAnswerNeverBeforeRequiredWhenARequiredSetNamesAnExcludedPath', () => {
        // The order is the policy, so it is asserted where it is observable: a
        // requirements document naming an excluded path must not admit it.
        const verdict = classifyClaudeStateEntry({ path: '.claude/sessions/abc.key', type: 'file' }, {
            ok: true,
            slug: MANAGED_CLAUDE_PROJECT_SLUG,
            entries: [{ path: '.claude/sessions/abc.key', kind: 'transcript', requiredBy: [] }],
        });
        expect(verdict).toEqual({ kind: 'never', rule: 'session-key' });
    });

    it('shouldNeverLetANeverListPathBeRequired', () => {
        const result = requirements();
        if (!result.ok) throw new Error('unexpected refusal');
        for (const entry of result.entries) {
            const type = entry.kind === 'ancestry' ? 'directory' as const : 'file' as const;
            // Not never even when asked without the requirements, which is the
            // order that matters: never is decided before required.
            expect(classifyClaudeStateEntry({ path: entry.path, type }).kind).not.toBe('never');
            expect(classifyClaudeStateEntry({ path: entry.path, type }, result).kind).toBe('required');
        }
    });

    it('shouldCallAnotherProjectsTreeOutOfScopeRatherThanDroppingIt', () => {
        expect(verdictFor('.claude/projects/-workspace-other/x.jsonl'))
            .toMatchObject({ kind: 'out-of-scope' });
        expect(verdictFor('.claude/todos/x.json')).toMatchObject({ kind: 'out-of-scope' });
    });

    it.each([
        [`${P}/${NATIVE}.jsonl.tmp`],
        [`${P}/${NATIVE}/subagents/agent-${AGENT}.jsonl.lock`],
        [`${P}/${NATIVE}/subagents/nested/agent-${AGENT}.jsonl`],
        [`${P}/${NATIVE}/tool-results/other.txt`],
        [`${P}/${OTHER_NATIVE}.jsonl`],
    ])('shouldCall %s unknown rather than excluded', (path) => {
        // Inside this project's own tree and nobody decided about it. Excluded
        // means someone decided; unknown means nobody has, and a reader who sees
        // "excluded" stops asking whether the file was load-bearing.
        expect(verdictFor(path).kind).toBe('unknown');
    });

    it('shouldCallAnIrregularEntryUnknownEvenAtARequiredPath', () => {
        expect(verdictFor(`${P}/${NATIVE}.jsonl`, 'symlink').kind).toBe('unknown');
        expect(verdictFor(`${P}/${NATIVE}.jsonl`, 'other').kind).toBe('unknown');
    });

    it.each(['/absolute', '../up', 'a//b', 'a/./b', 'a/../b'])(
        'shouldCall the unsafe path %s unsafe, not unknown',
        (path) => {
            expect(verdictFor(path).kind).toBe('unsafe');
        },
    );
});

describe('reconciling a whole enumeration', () => {
    it('shouldReportMissingRequiredPathsAndUnknownsAsPathsNotCounts', () => {
        const result = requirements();
        if (!result.ok) throw new Error('unexpected refusal');
        const present = result.entries
            .filter((entry) => entry.kind !== 'artifact')
            .map((entry) => ({ path: entry.path, type: entry.kind === 'ancestry' ? 'directory' as const : 'file' as const }));

        const reconciliation = reconcileClaudeState([
            ...present,
            { path: `${P}/${NATIVE}/tool-results/stray.txt`, type: 'file' },
            { path: '.claude/.credentials.json', type: 'file' },
            { path: '.claude/projects/-workspace-other/y.jsonl', type: 'file' },
        ], result);

        expect(reconciliation.missing.map((entry) => entry.path))
            .toEqual([`${P}/${NATIVE}/tool-results/${SEGMENT}`]);
        expect(reconciliation.unknown).toEqual([`${P}/${NATIVE}/tool-results/stray.txt`]);
        expect(reconciliation.outOfScope).toEqual(['.claude/projects/-workspace-other/y.jsonl']);
        expect(reconciliation.never).toEqual([{ path: '.claude/.credentials.json', rule: 'credential' }]);
        expect(reconciliation.complete).toBe(false);
    });

    it('shouldBeCompleteOnlyWhenNothingIsMissingAndNothingIsUnknown', () => {
        const result = requirements();
        if (!result.ok) throw new Error('unexpected refusal');
        const inventory = result.entries.map((entry) => ({
            path: entry.path,
            type: entry.kind === 'ancestry' ? 'directory' as const : 'file' as const,
        }));

        const reconciliation = reconcileClaudeState(inventory, result);
        expect(reconciliation.missing).toEqual([]);
        expect(reconciliation.unknown).toEqual([]);
        expect(reconciliation.complete).toBe(true);
    });

    it('shouldStillGiveAVerdictForEveryEnumeratedEntry', () => {
        const result = requirements();
        if (!result.ok) throw new Error('unexpected refusal');
        const inventory = [
            { path: `${P}/${NATIVE}.jsonl`, type: 'file' as const },
            { path: '../escape', type: 'file' as const },
            { path: 'history.jsonl', type: 'file' as const },
        ];
        const reconciliation = reconcileClaudeState(inventory, result);
        expect(reconciliation.verdicts).toHaveLength(inventory.length);
        expect(reconciliation.unsafe).toEqual(['../escape']);
    });
});

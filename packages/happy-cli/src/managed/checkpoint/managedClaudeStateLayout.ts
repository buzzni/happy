/**
 * Where a Claude session's state lives, and a verdict for everything else beside it.
 *
 * The measured Linux layout is `<state root>/projects/<slug>/<UUID>.jsonl`, with
 * the session's own directory holding `subagents/agent-<id>.{jsonl,meta.json}` and
 * `tool-results/<name>`. `managedCheckpointScope.ts` admits provider state only
 * under `sessions/<id>/…`, which no Claude path matches; this module is the pure
 * half of that replacement and replaces nothing yet.
 *
 * Contract:
 *
 * - No filesystem access. Requirements come from identifiers; a verdict is a
 *   function of a path and an entry type the caller enumerated.
 * - The caller enumerates and every entry gets a verdict. A module consulting only
 *   its own required set could not report an unexpected file.
 * - Five verdicts, kept distinct: `required`, `never`, `out-of-scope`, `unknown`,
 *   `unsafe`. `never` is an explicit exclusion; `unknown` is nobody having decided.
 * - `never` is answered before `required`, so an overlap resolves to exclusion.
 * - Only the ancestors of paths actually required are required.
 * - Nothing here decides whether provider state may be archived.
 */
import {
    classifyCheckpointEntry,
    type CheckpointEntryType,
} from './managedCheckpointScope';

/**
 * The working directory and provider home this module supports.
 *
 * The product derives a project slug by rewriting every character outside
 * `[A-Za-z0-9-]` (`src/claude/utils/path.ts:4`, relied on by eight modules). What
 * that rule does to punctuation has not been measured against an installed
 * consumer, so the slug is held as data for the one measured pair and any other
 * working directory is refused rather than encoded.
 *
 * The state root is `<provider home>/.claude`: the product reads
 * `CLAUDE_CONFIG_DIR` first, and on the managed provider child that variable is
 * not set (`managedRunConfig.ts:130` builds the environment from an empty object,
 * `supervisor.ts:754` replaces rather than inherits, and both exec helpers
 * `execv` their own `environ`). Another configuration is not impossible, it is
 * unmeasured — which is why it is refused rather than guessed.
 */
export const MANAGED_CLAUDE_CANONICAL_CWD = '/workspace/project';
export const MANAGED_CLAUDE_PROVIDER_HOME = '/workspace/.codex';
export const MANAGED_CLAUDE_PROJECT_SLUG = '-workspace-project';

/** The state directory, relative to the `provider-state` area root. */
const STATE_ROOT = '.claude';
const PROJECTS = `${STATE_ROOT}/projects`;

/** Grammars taken from the derivation rather than restated. */
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[a-z0-9]{1,64}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Paths that never travel, whatever else they are.
 *
 * `classifyCheckpointEntry` is asked as well, so the product's credential and
 * personal-history rules are not restated here. It does **not** cover the entries
 * below — `.claude/sessions/*.key`, a root `config.toml`, `.claude/history.jsonl`
 * (its list holds a root `history.jsonl` only), the provider's global config, and
 * this runtime's own state — which are excluded here by name, each with its own
 * table test.
 */
const NEVER_PATHS = new Map<string, ClaudeStateNeverRule>([
    ['.claude.json', 'provider-config'],
    ['.claude/settings.json', 'provider-config'],
    ['.claude/settings.local.json', 'provider-config'],
    ['.claude/config.json', 'provider-config'],
    ['config.toml', 'provider-config'],
    ['.claude/history.jsonl', 'personal-history'],
]);
const NEVER_PREFIXES = new Map<string, ClaudeStateNeverRule>([
    ['.happy', 'runtime-state'],
    ['.claude/statsig', 'provider-config'],
]);

/** Session key material: `.claude/sessions/<name>.key`. */
const NEVER_SESSION_KEY = /^\.claude\/sessions\/[^/]+\.key$/;

export type ClaudeStateNeverRule =
    /** The product's own credential list. */
    | 'credential'
    /** The product's own personal-history list. */
    | 'personal-history'
    /** Provider configuration and telemetry: not this session's state. */
    | 'provider-config'
    /** This runtime's own keys and receipts. */
    | 'runtime-state'
    /** Session key material under `.claude/sessions`. */
    | 'session-key';

export type ClaudeStateRequiredKind =
    /** A directory admitted only because a required leaf needs it. */
    | 'ancestry'
    /** The conversation itself. */
    | 'transcript'
    /** One subagent's own records. */
    | 'subagent-records'
    /** That subagent's meta, which the derivation also reads. */
    | 'subagent-meta'
    /** A tool output that lives in a file. */
    | 'artifact';

/** Which source, and in what role, made a path required. */
export type ClaudeStateAssociation = {
    attemptId: string;
    nativeId: string;
    role: 'current' | 'retained';
};

export type ClaudeStateRequiredEntry = {
    path: string;
    kind: ClaudeStateRequiredKind;
    /**
     * Every association that needs this path, not just the first.
     *
     * One physical file can be the current session of one attempt and a retained
     * session of another. Collapsing that loses the reason it is carried, which
     * is exactly what a coverage answer has to be able to cite.
     */
    requiredBy: readonly ClaudeStateAssociation[];
};

/**
 * What the derivation concluded for one session.
 *
 * `complete: false` is not a partial answer to work from. A derivation that
 * refused knows nothing about the session's dependencies, and treating its
 * silence as "there were none" would turn "we do not know" into a coverage
 * claim.
 */
export type ClaudeSessionDependencies =
    | {
        complete: true;
        subagents: readonly { agentId: string }[];
        references: readonly { segment: string; size: number }[];
    }
    | { complete: false };

export type ClaudeStateRequirementsRefusal =
    /** No source named a session. Absence is not "there was nothing to carry". */
    | 'sources-absent'
    | 'slug-unsupported-cwd'
    | 'state-root-unsupported'
    | 'native-id-invalid'
    | 'agent-id-invalid'
    | 'reference-segment-invalid'
    | 'reference-size-invalid'
    | 'dependencies-missing'
    | 'dependencies-incomplete';

export type ClaudeStateRequirements = {
    ok: true;
    slug: string;
    entries: readonly ClaudeStateRequiredEntry[];
};

export type ClaudeStateVerdict =
    | { kind: 'required'; required: ClaudeStateRequiredKind }
    | { kind: 'never'; rule: ClaudeStateNeverRule }
    /** Not this project's state at all: another project, another tenant, elsewhere. */
    | { kind: 'out-of-scope' }
    /** Inside this project's own tree and nobody has decided about it. */
    | { kind: 'unknown' }
    /** Not a path this runtime will reason about. */
    | { kind: 'unsafe' };

export type ClaudeStateReconciliation = {
    verdicts: readonly { path: string; verdict: ClaudeStateVerdict }[];
    missing: readonly ClaudeStateRequiredEntry[];
    unknown: readonly string[];
    outOfScope: readonly string[];
    unsafe: readonly string[];
    never: readonly { path: string; rule: ClaudeStateNeverRule }[];
    /** Nothing required is absent and nothing unaccounted for was found. */
    complete: boolean;
};

/** Only the fields of a scope source this module needs; the type is the scope's. */
type ClaudeStateSource = {
    attemptId: string;
    currentNativeId: string;
    retainedNativeIds: readonly string[];
};

function refuse(refusal: ClaudeStateRequirementsRefusal): { ok: false; refusal: ClaudeStateRequirementsRefusal } {
    return { ok: false, refusal };
}

export function claudeStateRequirements(input: {
    providerHome: string;
    canonicalCwd: string;
    sources: readonly ClaudeStateSource[];
    /** Native id to what the derivation concluded for it. */
    dependencies: ReadonlyMap<string, ClaudeSessionDependencies>;
}): ClaudeStateRequirements | { ok: false; refusal: ClaudeStateRequirementsRefusal } {
    /*
     * An empty source list is not an empty required set: nothing here can tell
     * "this run had no provider state" from "the scope never arrived", and
     * answering `ok` with no entries lets a caller read the second as the first.
     */
    if (input.sources.length === 0) return refuse('sources-absent');
    if (input.canonicalCwd !== MANAGED_CLAUDE_CANONICAL_CWD) return refuse('slug-unsupported-cwd');
    if (input.providerHome !== MANAGED_CLAUDE_PROVIDER_HOME) return refuse('state-root-unsupported');

    /*
     * Insertion order is the order the sources named them, and an association is
     * appended to a path that is already required rather than replacing it.
     */
    const entries = new Map<string, { kind: ClaudeStateRequiredKind; requiredBy: ClaudeStateAssociation[] }>();
    const add = (path: string, kind: ClaudeStateRequiredKind, association: ClaudeStateAssociation): void => {
        const existing = entries.get(path);
        if (existing === undefined) {
            entries.set(path, { kind, requiredBy: [association] });
            return;
        }
        const already = existing.requiredBy.some((by) => (
            by.attemptId === association.attemptId
            && by.nativeId === association.nativeId
            && by.role === association.role
        ));
        if (!already) existing.requiredBy.push(association);
    };

    const project = `${PROJECTS}/${MANAGED_CLAUDE_PROJECT_SLUG}`;
    for (const source of input.sources) {
        const named: { nativeId: string; role: 'current' | 'retained' }[] = [
            { nativeId: source.currentNativeId, role: 'current' },
            ...source.retainedNativeIds.map((nativeId) => ({ nativeId, role: 'retained' as const })),
        ];
        for (const { nativeId, role } of named) {
            if (!NATIVE_ID.test(nativeId)) return refuse('native-id-invalid');
            const dependencies = input.dependencies.get(nativeId);
            if (dependencies === undefined) return refuse('dependencies-missing');
            if (!dependencies.complete) return refuse('dependencies-incomplete');

            const association: ClaudeStateAssociation = { attemptId: source.attemptId, nativeId, role };
            const session = `${project}/${nativeId}`;
            add(STATE_ROOT, 'ancestry', association);
            add(PROJECTS, 'ancestry', association);
            add(project, 'ancestry', association);
            add(`${project}/${nativeId}.jsonl`, 'transcript', association);
            /*
             * The session directory and the two below it are required only when a
             * leaf inside them is. A parent-only conversation creates none of
             * them, and requiring them would report a healthy session as missing
             * state it never had.
             */
            if (dependencies.subagents.length > 0) {
                add(session, 'ancestry', association);
                add(`${session}/subagents`, 'ancestry', association);
            }
            // Both halves of the measured depth-1 pair: the records resume the
            // child, and the meta is what the derivation reads to bind it.
            for (const subagent of dependencies.subagents) {
                if (!AGENT_ID.test(subagent.agentId)) return refuse('agent-id-invalid');
                add(`${session}/subagents/agent-${subagent.agentId}.jsonl`, 'subagent-records', association);
                add(`${session}/subagents/agent-${subagent.agentId}.meta.json`, 'subagent-meta', association);
            }
            if (dependencies.references.length > 0) {
                add(session, 'ancestry', association);
                add(`${session}/tool-results`, 'ancestry', association);
            }
            for (const reference of dependencies.references) {
                if (!SEGMENT.test(reference.segment)) return refuse('reference-segment-invalid');
                // Strictly positive, as the derivation requires.
                if (!Number.isSafeInteger(reference.size) || reference.size <= 0) {
                    return refuse('reference-size-invalid');
                }
                add(`${session}/tool-results/${reference.segment}`, 'artifact', association);
            }
        }
    }

    return {
        ok: true,
        slug: MANAGED_CLAUDE_PROJECT_SLUG,
        entries: [...entries].map(([path, entry]) => ({
            path,
            kind: entry.kind,
            requiredBy: entry.requiredBy,
        })),
    };
}

/** Unsafe by the same rule the archive uses, asked without throwing. */
function unsafe(path: string): boolean {
    try {
        classifyCheckpointEntry({ area: 'provider-state', path, type: 'file', bytes: 0 });
        return false;
    } catch {
        return true;
    }
}

function neverRule(path: string): ClaudeStateNeverRule | null {
    // The product's own lists first, so there is one of them rather than two.
    const scope = classifyCheckpointEntry({ area: 'provider-state', path, type: 'file', bytes: 0 });
    if (!scope.include && (scope.reason === 'credential' || scope.reason === 'personal-history')) {
        return scope.reason;
    }
    const exact = NEVER_PATHS.get(path);
    if (exact !== undefined) return exact;
    for (const [prefix, rule] of NEVER_PREFIXES) {
        if (path === prefix || path.startsWith(`${prefix}/`)) return rule;
    }
    if (NEVER_SESSION_KEY.test(path)) return 'session-key';
    return null;
}

export function classifyClaudeStateEntry(
    entry: { path: string; type: CheckpointEntryType },
    requirements?: ClaudeStateRequirements,
): ClaudeStateVerdict {
    if (unsafe(entry.path)) return { kind: 'unsafe' };
    /*
     * Never is answered before required, so an overlap can only ever resolve the
     * safe way. A required set that happened to name a credential would otherwise
     * carry it, and the whole point of the allowlist is that the answer does not
     * depend on nobody having made that mistake.
     */
    const rule = neverRule(entry.path);
    if (rule !== null) return { kind: 'never', rule };

    const required = requirements?.entries.find((candidate) => candidate.path === entry.path);
    if (required !== undefined) {
        const wanted = required.kind === 'ancestry' ? 'directory' : 'file';
        // The right path holding the wrong kind of thing is not that path.
        if (entry.type !== wanted) return { kind: 'unknown' };
        return { kind: 'required', required: required.kind };
    }

    const project = `${PROJECTS}/${requirements?.slug ?? MANAGED_CLAUDE_PROJECT_SLUG}`;
    const inThisProject = entry.path === project || entry.path.startsWith(`${project}/`);
    return inThisProject ? { kind: 'unknown' } : { kind: 'out-of-scope' };
}

export function reconcileClaudeState(
    inventory: readonly { path: string; type: CheckpointEntryType }[],
    requirements: ClaudeStateRequirements,
): ClaudeStateReconciliation {
    const verdicts = inventory.map((entry) => ({
        path: entry.path,
        verdict: classifyClaudeStateEntry(entry, requirements),
    }));
    const satisfied = new Set(
        verdicts.filter(({ verdict }) => verdict.kind === 'required').map(({ path }) => path),
    );
    const missing = requirements.entries.filter((entry) => !satisfied.has(entry.path));
    const of = (kind: ClaudeStateVerdict['kind']): string[] => verdicts
        .filter(({ verdict }) => verdict.kind === kind)
        .map(({ path }) => path);

    return {
        verdicts,
        missing,
        unknown: of('unknown'),
        outOfScope: of('out-of-scope'),
        unsafe: of('unsafe'),
        never: verdicts
            .filter(({ verdict }) => verdict.kind === 'never')
            .map(({ path, verdict }) => ({ path, rule: (verdict as { rule: ClaudeStateNeverRule }).rule })),
        // Paths, not counts: a count was satisfied once in this pipeline by an
        // empty directory standing in for a session's state.
        complete: missing.length === 0 && of('unknown').length === 0 && of('unsafe').length === 0,
    };
}

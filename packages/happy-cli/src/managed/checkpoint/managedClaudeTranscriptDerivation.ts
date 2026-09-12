/**
 * What one Claude session's transcript says it depends on.
 *
 * A transcript is not self-contained. Two other kinds of file can sit beside
 * it, and the transcript is the only thing that knows they exist:
 *
 *   <S>/<id>/subagents/agent-<agentId>.jsonl       an `Agent` call's conversation
 *   <S>/<id>/subagents/agent-<agentId>.meta.json   its binding to the parent's tool_use
 *   <S>/<id>/tool-results/<segment>                the real output of a tool call the
 *                                                  transcript only summarises
 *
 * Both were measured on the image's own CLI (2.1.268, `sha256:2620ac92...`):
 * without the subagent pair a `SendMessage` to that agent answers "No transcript
 * found for agent ID"; without the artifact a `Read` of the referenced path
 * answers "File does not exist" with `is_error: true` - while the resumed run
 * itself looks identical either way. That last part is why this exists: the loss
 * is invisible to anything that checks whether the run succeeded.
 *
 * Pure on purpose. It reads no filesystem and takes no signed scope: the caller
 * says which session this is, where the canonical workspace and provider home
 * are, and hands over the parsed records. Everything it returns is a claim about
 * what must be present, for the caller to check - so a reference survives even
 * when the directory that would hold it does not exist at all, which is exactly
 * the case a directory walk has nothing to report.
 *
 * The record vocabulary is **not** a safety claim on its own. Knowing a record's
 * `type` says nothing about what it references, so every record is also read
 * structurally: a tool result must bind to a tool call this transcript made, and
 * a call this code cannot account for refuses rather than passing unexamined.
 *
 * ## What this is not
 *
 * **It is an extractor, not an envelope validator.** It answers "which files does
 * this transcript commit to", and it refuses when it meets something it cannot
 * account for. It does **not** decide whether a conversation is resumable, and
 * production acceptance still needs a supported-transcript predicate beside it.
 *
 * It does require the file to contain a **turn** - see `isTurn` - because
 * refusing a metadata-only file while accepting a message-less one was the same
 * question answered two ways. That is a floor, not a guarantee.
 *
 * No claim is made that every record shape is validated - only that no record
 * this code does not understand passes unexamined.
 */
import { posix } from 'node:path';

/** One parsed line of a `.jsonl` transcript. Shape is checked, not assumed. */
export type ClaudeTranscriptRecord = Record<string, unknown>;

/** An `Agent` call, and the child files it commits the session to. */
export type DerivedSubagent = { nativeId: string; toolUseId: string; agentId: string };

/** A tool output that lives in a file, and the size the record recorded. */
export type DerivedReference = { nativeId: string; toolUseId: string; segment: string; size: number };

export type ClaudeDerivationRefusal =
    /** A record type this code cannot account for. */
    | 'record-unrecognised'
    /** No records at all: not a conversation this can vouch for. */
    | 'transcript-empty'
    /** Records, but no turn: bookkeeping rather than a conversation. */
    | 'transcript-not-a-conversation'
    /** A tool call with no result. Incomplete, not closed. */
    | 'tool-result-missing'
    /** A row names a different session, or names one that is not a string. */
    | 'transcript-session-mismatch'
    /** The session or agent identifier is not of the measured shape. */
    | 'identifier-invalid'
    /** A tool call this code has never been shown the consequences of. */
    | 'tool-unsupported'
    /** A tool result binding to no call, or to one already answered. */
    | 'tool-binding-invalid'
    /** The `Agent` result arrived and named no child: errored, not truncated. */
    | 'agent-result-errored'
    /** A call row with no `uuid`: its second link can never be checked. */
    | 'call-row-unidentified'
    /** Parent rows flagged as a sidechain: that is a child's own file. */
    | 'transcript-not-a-parent'
    /** Two `Agent` calls claiming the same child. */
    | 'agent-duplicate'
    /** A structured result's two links to its call disagree. */
    | 'result-binding-conflict'
    /** The child's records or meta were not provided. */
    | 'subagent-missing'
    /** The child transcript has no records. */
    | 'subagent-empty'
    /** A child row names a session other than this parent. */
    | 'subagent-session-mismatch'
    /** A child row disowns its own agent, or is not a sidechain. */
    | 'subagent-identity-inconsistent'
    /** The child's meta binds a different `tool_use`. */
    | 'subagent-binding-mismatch'
    /** The child is outside the envelope that was measured. */
    | 'subagent-unsupported-shape'
    /** A reference pointing anywhere but this session's own directory. */
    | 'reference-foreign'
    /** The workspace or provider root was not an absolute path. */
    | 'root-not-absolute'
    /** It was absolute, but not in the form it would be compared in. */
    | 'root-not-canonical'
    /** The referenced name is not a single ordinary file name. */
    | 'reference-segment-invalid'
    /** The recorded size is not a plausible byte count. */
    | 'reference-size-invalid'
    /** The same artifact referenced with two different sizes. */
    | 'reference-conflict';

export type ClaudeDerivation =
    | { derived: true; subagents: readonly DerivedSubagent[]; references: readonly DerivedReference[] }
    | { derived: false; refusal: ClaudeDerivationRefusal };

/**
 * What a parent transcript **named**, read without its children.
 *
 * A caller that has to fetch the child files cannot get this from
 * `deriveClaudeTranscriptDependencies`: that refuses `subagent-missing` as soon as
 * a call has no child offered, and never says which `agentId` it wanted. So the
 * result is a distinct shape — `discovered`, not `derived` — because it is a
 * weaker statement: these are the names this transcript referenced, and nothing is
 * claimed about whether those files exist, agree with it, or are of a shape this
 * code supports. Only the full derivation says that.
 */
export type ClaudeDiscovery =
    | {
        discovered: true;
        /** `agentId` per `Agent` call, in the order the transcript made them. */
        agentIds: readonly string[];
        references: readonly { segment: string; size: number }[];
    }
    | { discovered: false; refusal: ClaudeDerivationRefusal };

/** The parent alone: the same fields as a derivation, minus the children. */
export type ClaudeDiscoveryInput = Omit<ClaudeDerivationInput, 'children'>;

export type ClaudeDerivationInput = {
    /** The session being derived. Every row that names one must name this. */
    nativeId: string;
    /** The workspace directory the project slug is computed from. */
    canonicalCwd: string;
    /** The base the projects tree hangs from. A home is never slugged. */
    providerHome: string;
    records: readonly ClaudeTranscriptRecord[];
    /** `agentId` to that child's parsed records and its parsed meta. */
    children?: ReadonlyMap<string, { records: readonly ClaudeTranscriptRecord[]; meta: unknown }>;
};

/**
 * The record types the pinned Linux seed actually contains.
 *
 * Counted from it rather than guessed: `queue-operation` 2, `user` 2,
 * `attachment` 10, `atis-latch` 2, `assistant` 2, `last-prompt` 1. An earlier
 * guess here admitted `summary` - which no fixture holds - and refused three
 * types every fixture holds, so it would have rejected both positive cases
 * while accepting something unmeasured.
 *
 * A type outside this set refuses. That is deliberately not a compaction
 * detector: nothing pinned carries a compaction marker, and claiming to
 * recognise a feature never seen would be worse than refusing what cannot be
 * accounted for.
 */
const KNOWN_RECORD_TYPES = new Set([
    'queue-operation', 'user', 'attachment', 'atis-latch', 'assistant', 'last-prompt',
]);

/**
 * The tools whose on-disk consequences have actually been measured.
 *
 * Exactly the two the pinned seeds contain: `Agent`, which writes a child pair,
 * and `Bash`, whose large output becomes a persisted-output file. Everything
 * else refuses.
 *
 * A denylist was the wrong shape here and Astra found it: naming `TaskOutput`
 * and `TaskStop` left every tool nobody has run yet - including ones that write
 * files of their own - passing as harmless. Claiming coverage of consequences
 * never observed is the failure this whole module exists to prevent, so the set
 * is what has been seen, and it grows when something is measured rather than
 * when something is imagined.
 */
const MEASURED_TOOLS = new Set(['Agent', 'Bash']);

/** The turn types that make a transcript a conversation rather than bookkeeping. */
const CONVERSATION_TYPES = new Set(['user', 'assistant']);

/**
 * A turn: a `user` or `assistant` row of **this** session carrying a message
 * with something in it.
 *
 * The row type alone is not enough, and freeze80 proved it by refusing a
 * queue-operation-only file while accepting `[{type:'assistant'}]` - a row with
 * no message at all - as a conversation. Those are the same question, and an
 * empty-but-well-formed file would have passed as a covered session.
 *
 * Both measured shapes are accepted as written: `user` carries a plain string
 * (and, on a tool result, an array), `assistant` carries an array of blocks.
 * Neither is inspected further - this is a check that a turn exists, not a
 * judgement about whether the conversation is resumable.
 */
function isTurn(record: ClaudeTranscriptRecord, sessionId: string): boolean {
    if (!CONVERSATION_TYPES.has(record.type as string)) return false;
    // The turn itself has to name the session; a row that merely does not
    // contradict it is not a row that claims it.
    if (record.sessionId !== sessionId) return false;
    const message = record.message;
    if (!isRecord(message)) return false;
    const content = message.content;
    if (typeof content === 'string') return content.length > 0;
    return Array.isArray(content) && content.length > 0;
}

/** The session id grammar, matching `claudeSessionTransfer.ts` and `apiMachine.ts`. */
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Observed `a4ec78d2c4e3608ba`. Not a UUID, and not to be checked as one. */
const AGENT_ID = /^[a-z0-9]{1,64}$/;

/**
 * One ordinary file name.
 *
 * No separator, no traversal, no control character, bounded. The value comes
 * from a transcript, and a transcript is written by a process this runtime does
 * not control.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The product's own rule, applied to values passed in rather than to the
 * environment.
 *
 * `resolve()` is deliberately not used. It fills a relative path in from the
 * process cwd, so a caller that forgot to say where the workspace is would get
 * a slug for wherever this daemon happens to be running - and the references
 * would then be compared against a directory belonging to no runtime in
 * particular. The caller is required to pass an absolute path instead; see
 * `root-not-absolute`.
 */
function projectSlug(canonicalCwd: string): string {
    return canonicalCwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

function contentBlocks(record: ClaudeTranscriptRecord): Record<string, unknown>[] {
    const message = record.message;
    if (!isRecord(message)) return [];
    const content = message.content;
    return Array.isArray(content) ? content.filter(isRecord) : [];
}

type Scan = {
    /** toolUseId -> tool name, for every call this transcript made. */
    calls: Map<string, string>;
    /** toolUseId -> the uuid of the assistant row that wrote the call. */
    callRowUuid: Map<string, string>;
    /** toolUseId -> the call's own `run_in_background`, when it carried one. */
    callBackground: Map<string, unknown>;
    /** toolUseId that already has a result. A second one is not a second call. */
    answered: Set<string>;
    /** toolUseId -> agentId, for `Agent` calls whose result has arrived. */
    agents: Map<string, string>;
    references: DerivedReference[];
    refusal: ClaudeDerivationRefusal | null;
};

/**
 * One transcript's own rows, parent or child, by the same rules.
 *
 * Every tool result is bound to a call this transcript made, and each call is
 * answered at most once - not only the `Agent` ones. An artifact reference that
 * belonged to no call would be a file this session is asked to carry on the say
 * so of a record nothing else accounts for.
 */
function scanRecords(
    records: readonly ClaudeTranscriptRecord[],
    expectedSessionId: string,
    artifactDir: string,
): Scan {
    const scan: Scan = {
        calls: new Map(), callRowUuid: new Map(), callBackground: new Map(), answered: new Set(),
        agents: new Map(), references: [], refusal: null,
    };
    const refuse = (refusal: ClaudeDerivationRefusal): Scan => {
        scan.refusal = scan.refusal ?? refusal;
        return scan;
    };

    for (const record of records) {
        const type = record.type;
        if (typeof type !== 'string' || !KNOWN_RECORD_TYPES.has(type)) return refuse('record-unrecognised');
        /*
         * A row may omit `sessionId`; one that carries anything else - a
         * different id, or a value that is not an id at all - is not this
         * session's row. One comparison covers both, and a separate `typeof`
         * check ahead of it was dead: every value it would have caught is
         * already unequal here.
         */
        if (record.sessionId !== undefined && record.sessionId !== expectedSessionId) {
            return refuse('transcript-session-mismatch');
        }

        const blocks = contentBlocks(record);
        for (const block of blocks) {
            if (block.type !== 'tool_use') continue;
            const id = block.id;
            const name = block.name;
            if (typeof id !== 'string' || typeof name !== 'string') return refuse('record-unrecognised');
            if (!MEASURED_TOOLS.has(name)) return refuse('tool-unsupported');
            if (scan.calls.has(id)) return refuse('tool-binding-invalid');
            scan.calls.set(id, name);
            /*
             * A call row has to be pointable-at. The `sourceToolAssistantUUID`
             * comparison is written as "check when both are present", so a row
             * with no `uuid` silently drops the second link instead of failing
             * it - Fable deleted one and the conflict check simply stopped
             * running.
             */
            if (typeof record.uuid !== 'string') return refuse('call-row-unidentified');
            scan.callRowUuid.set(id, record.uuid);
            /*
             * Background is outside the measured envelope for **every** tool,
             * not only `Agent`. The flag used to be captured for all and
             * enforced for one, so a backgrounded `Bash` derived cleanly -
             * Astra found it. Nothing here has measured what a background call
             * writes or when it finishes, and a checkpoint taken while one is
             * still running is precisely the case this module cannot see.
             *
             * Absent is the seed's own default (`Agent` carries an explicit
             * `false`), so silence is accepted and only a positive `true` -
             * or anything that is not `false` - refuses.
             */
            if (isRecord(block.input) && 'run_in_background' in block.input) {
                if (block.input.run_in_background !== false) return refuse('tool-unsupported');
                scan.callBackground.set(id, block.input.run_in_background);
            }
        }

        const results = blocks.filter((block) => block.type === 'tool_result');
        for (const result of results) {
            const boundTo = result.tool_use_id;
            if (typeof boundTo !== 'string' || !scan.calls.has(boundTo)) return refuse('tool-binding-invalid');
            if (scan.answered.has(boundTo)) return refuse('tool-binding-invalid');
            scan.answered.add(boundTo);
        }

        const structured = record.toolUseResult;
        if (!isRecord(structured)) continue;
        // Exactly one call is being answered here; the structured payload
        // belongs to it and to nothing else.
        if (results.length !== 1) return refuse('tool-binding-invalid');
        const toolUseId = results[0]!.tool_use_id as string;

        /*
         * The row carries two links to its call, and the seed has both:
         * `tool_result.tool_use_id`, and `sourceToolAssistantUUID` pointing at
         * the `uuid` of the assistant row that wrote the call (`a8a65a11...` ->
         * `toolu_agent_1`). Checked together when both are present; absent is
         * not evidence, so the second is never required.
         *
         * Checked **here**, for every structured result, rather than inside the
         * `Agent` branch where it started. The links belong to the record, not
         * to the tool - root's raw probe put `sourceToolAssistantUUID:
         * 'wrong-source'` on an artifact result and it derived anyway, because
         * the one kind of result that names a file to carry was the kind the
         * check did not cover.
         */
        if ('sourceToolAssistantUUID' in record && record.sourceToolAssistantUUID !== undefined) {
            /*
             * Present means checked. `typeof source === 'string'` let a
             * malformed value - Astra's `42` - be read as "no link offered",
             * so the one way to switch the second check off was to write
             * something nonsensical into it. Absent is a link nobody claimed;
             * present is a claim, and a claim has to hold.
             */
            const source = record.sourceToolAssistantUUID;
            if (typeof source !== 'string' || source !== scan.callRowUuid.get(toolUseId)) {
                return refuse('result-binding-conflict');
            }
        }

        if (typeof structured.agentId === 'string') {
            if (scan.calls.get(toolUseId) !== 'Agent') return refuse('tool-binding-invalid');
            if (!AGENT_ID.test(structured.agentId)) return refuse('identifier-invalid');
            for (const already of scan.agents.values()) {
                if (already === structured.agentId) return refuse('agent-duplicate');
            }
            scan.agents.set(toolUseId, structured.agentId);
        }

        if (structured.persistedOutputPath === undefined && structured.persistedOutputSize === undefined) {
            continue;
        }
        const path = structured.persistedOutputPath;
        const size = structured.persistedOutputSize;
        if (typeof path !== 'string' || typeof size !== 'number') return refuse('record-unrecognised');
        // A byte count, and one that was actually written: the measured case is
        // 214,893, and a zero-byte artifact is the same fact as a missing one.
        if (!Number.isSafeInteger(size) || size <= 0) return refuse('reference-size-invalid');
        /*
         * Checked, never opened, and never parsed out of the stub text beside
         * it: these are structured fields, and reading a path out of prose is
         * how a wording change upstream becomes a silently dropped dependency.
         */
        /*
         * **Equal to**, not "normalises to". `dirname`/`basename` quietly
         * absorb a trailing separator, a doubled one or a `.` segment, and the
         * derivation would hand back a tidy segment for a reference the
         * consumer opens verbatim - root's probe: a trailing `/` was accepted,
         * and `Read` of the original string answers ENOTDIR while the artifact
         * sits there, present and uncarried.
         *
         * The segment is validated first so the comparison is against a name
         * this module would itself produce.
         */
        const segment = posix.basename(path);
        if (!SEGMENT.test(segment)) return refuse('reference-segment-invalid');
        if (path !== `${artifactDir}/${segment}`) return refuse('reference-foreign');
        const seen = scan.references.find((reference) => reference.segment === segment);
        if (seen && seen.size !== size) return refuse('reference-conflict');
        if (!seen) {
            scan.references.push({ nativeId: expectedSessionId, toolUseId, segment, size });
        }
    }

    /*
     * A conversation, not a ledger. A file of `queue-operation` rows is
     * bookkeeping with nothing resumable in it, and calling it a covered
     * session would put an empty claim in the manifest.
     */
    if (!records.some((record) => isTurn(record, expectedSessionId))) {
        return refuse('transcript-not-a-conversation');
    }
    /*
     * Every call answered - not only the `Agent` ones. An unanswered `Bash` is
     * a truncated transcript, and reading it as a closed call would let a file
     * that stops mid-tool pass as a finished session.
     */
    for (const id of scan.calls.keys()) {
        if (!scan.answered.has(id)) return refuse('tool-result-missing');
    }
    return scan;
}

/**
 * The envelope that was actually measured: one foreground, non-interactive child.
 *
 * `background` asks a second question the caller answers - the call's own
 * `run_in_background` flag, which the seed carries as `false`. The two have to
 * agree; a `true` on either side is outside what was measured rather than a
 * second supported mode.
 */
function metaAccepts(meta: unknown, toolUseId: string, background: unknown): ClaudeDerivationRefusal | null {
    if (!isRecord(meta)) return 'subagent-missing';
    if (meta.toolUseId !== toolUseId) return 'subagent-binding-mismatch';
    if (background !== false && background !== undefined) return 'subagent-unsupported-shape';
    if (meta.spawnDepth !== 1) return 'subagent-unsupported-shape';
    if (meta.requestShape !== 'foreground') return 'subagent-unsupported-shape';
    if (meta.requestNonInteractive !== true) return 'subagent-unsupported-shape';
    return null;
}

/**
 * Every row of a child says whose it is.
 *
 * In the pinned child all nine rows carry `agentId`, `isSidechain: true` and the
 * **parent's** `sessionId`. Checking only the first would accept a file whose
 * tail belongs to someone else, and the tail is exactly where that shows.
 */
function childIdentityRefusal(
    records: readonly ClaudeTranscriptRecord[],
    agentId: string,
    parentSessionId: string,
): ClaudeDerivationRefusal | null {
    if (records.length === 0) return 'subagent-empty';
    for (const record of records) {
        // Required, not merely un-contradicted. Checking only rows that carried
        // a field made silence the way past it: a row saying nothing about whose
        // it is used to be accepted as this agent's. Every measured row says.
        if (record.sessionId !== parentSessionId) return 'subagent-session-mismatch';
        if (record.agentId !== agentId) return 'subagent-identity-inconsistent';
        if (record.isSidechain !== true) return 'subagent-identity-inconsistent';
    }
    return null;
}

/**
 * Everything both entry points decide about the parent, in one place.
 *
 * Shared so the two cannot drift on what a parent is; it deliberately stops at the
 * scan, because what each does with the result is where they differ.
 */
function scanParent(input: ClaudeDiscoveryInput): { refusal: ClaudeDerivationRefusal } | {
    refusal: null;
    artifactDir: string;
    parent: Scan;
} {
    // Checked before either becomes a path component.
    if (!NATIVE_ID.test(input.nativeId)) return { refusal: 'identifier-invalid' };
    if (!posix.isAbsolute(input.canonicalCwd) || !posix.isAbsolute(input.providerHome)) {
        return { refusal: 'root-not-absolute' };
    }
    /*
     * Already in the form it will be compared in - `/a//b`, `/a/./b` and
     * `/a/b/` all mean the same directory and all produce a different slug or a
     * different artifact prefix if used as written. Normalising them here would
     * make this module agree with a caller that has not said what it thinks it
     * said, and the slug is the one value where a near-miss surfaces as
     * "session not found" rather than as an error anybody sees.
     */
    const canonicalRoot = (root: string): boolean => (
        // `normalize` keeps a trailing separator, and `${root}/...` would then
        // carry a doubled one into every comparison.
        posix.normalize(root) === root && (root === '/' || !root.endsWith('/'))
    );
    if (!canonicalRoot(input.canonicalCwd) || !canonicalRoot(input.providerHome)) {
        return { refusal: 'root-not-canonical' };
    }
    if (input.records.length === 0) return { refusal: 'transcript-empty' };

    const artifactDir = posix.join(
        input.providerHome,
        '.claude',
        'projects',
        projectSlug(input.canonicalCwd),
        input.nativeId,
        'tool-results',
    );
    /*
     * A sidechain is a child's own file. Reading one as a parent would derive
     * its `Agent` calls as though the session had made them - the parent/child
     * confusion the descent exists to prevent, arriving through the front door.
     */
    if (input.records.some((record) => record.isSidechain === true)) {
        return { refusal: 'transcript-not-a-parent' };
    }
    const parent = scanRecords(input.records, input.nativeId, artifactDir);
    if (parent.refusal) return { refusal: parent.refusal };
    return { refusal: null, artifactDir, parent };
}

/**
 * The names a parent commits to, without reading a single child.
 *
 * `agent-result-errored` is refused here as it is in the full derivation: a call
 * that was answered with no child is not a session with one fewer child, and
 * reporting the remaining names would hand a caller a list to fetch that is
 * quietly short.
 */
export function discoverClaudeTranscriptDependencies(input: ClaudeDiscoveryInput): ClaudeDiscovery {
    const scanned = scanParent(input);
    if (scanned.refusal !== null) return { discovered: false, refusal: scanned.refusal };

    const agentIds: string[] = [];
    for (const [toolUseId, name] of scanned.parent.calls) {
        if (name !== 'Agent') continue;
        const agentId = scanned.parent.agents.get(toolUseId);
        if (agentId === undefined) return { discovered: false, refusal: 'agent-result-errored' };
        agentIds.push(agentId);
    }
    return {
        discovered: true,
        agentIds,
        references: scanned.parent.references.map((reference) => ({
            segment: reference.segment,
            size: reference.size,
        })),
    };
}

export function deriveClaudeTranscriptDependencies(input: ClaudeDerivationInput): ClaudeDerivation {
    /*
     * The parent prelude is shared; the walk below is not. Answering every
     * parent-level question first and then looping would report a later call's
     * `agent-result-errored` before an earlier call's `subagent-missing`, which is
     * a different code for the same transcript than callers read today.
     */
    const scanned = scanParent(input);
    if (scanned.refusal !== null) return { derived: false, refusal: scanned.refusal };
    const { artifactDir, parent } = scanned;

    const subagents: DerivedSubagent[] = [];
    for (const [toolUseId, name] of parent.calls) {
        if (name !== 'Agent') continue;
        // The call was answered - `tool-result-missing` covers the truncated
        // case - and the answer named no child. The result arrived and failed,
        // so saying "missing" would send a reader looking for a cut-off file.
        const agentId = parent.agents.get(toolUseId);
        if (agentId === undefined) return { derived: false, refusal: 'agent-result-errored' };

        const child = input.children?.get(agentId);
        if (child === undefined) return { derived: false, refusal: 'subagent-missing' };

        const metaRefusal = metaAccepts(child.meta, toolUseId, parent.callBackground.get(toolUseId));
        if (metaRefusal) return { derived: false, refusal: metaRefusal };

        const identityRefusal = childIdentityRefusal(child.records, agentId, input.nativeId);
        if (identityRefusal) return { derived: false, refusal: identityRefusal };

        /*
         * The child's own rows, by the same rules. A grandchild, an unsupported
         * tool, or an artifact of the child's own is a shape nobody measured -
         * each surfaces here as a refusal rather than as more files to carry.
         */
        const descent = scanRecords(child.records, input.nativeId, artifactDir);
        if (descent.refusal === 'transcript-session-mismatch') {
            return { derived: false, refusal: 'subagent-session-mismatch' };
        }
        if (descent.refusal) return { derived: false, refusal: descent.refusal };
        if ([...descent.calls.values()].includes('Agent') || descent.references.length > 0) {
            return { derived: false, refusal: 'subagent-unsupported-shape' };
        }

        subagents.push({ nativeId: input.nativeId, toolUseId, agentId });
    }

    return { derived: true, subagents, references: parent.references };
}

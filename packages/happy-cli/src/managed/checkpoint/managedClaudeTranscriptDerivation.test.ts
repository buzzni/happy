/**
 * What one Claude transcript says it depends on - derived, not guessed.
 *
 * Record shapes come from the pinned fixtures (`/tmp/pr3557-op2-resume-probe3`,
 * `/tmp/pr3557-op2-tool-artifact`, image `sha256:2620ac92...`, CLI 2.1.268),
 * not from a shape invented here.
 */
import { describe, expect, it } from 'vitest';

import {
    deriveClaudeTranscriptDependencies,
    type ClaudeTranscriptRecord,
    discoverClaudeTranscriptDependencies,
} from './managedClaudeTranscriptDerivation';
import {
    PINNED_CHILD,
    PINNED_CHILD_META,
    PINNED_PARENT_WITH_AGENT,
    PINNED_PARENT_WITH_ARTIFACTS,
} from './managedClaudeTranscriptFixtures';

const ID = '330a1f93-cda9-4080-89a3-c780c9ade479';
const AGENT = 'a4ec78d2c4e3608ba';
const TOOL_USE = 'toolu_agent_1';
/** The assistant row's own uuid, which the result row points back at. */
const ASSISTANT_UUID = 'a8a65a11-72f4-46e5-86d3-ffd76469b66f';
const CWD = '/fixture/work';
const HOME = '/fixture/home';
/** `resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-')`, as the product helper computes it. */
const ARTIFACT_DIR = `${HOME}/.claude/projects/-fixture-work/${ID}/tool-results`;

type Child = { records: ClaudeTranscriptRecord[]; meta: unknown };

function agentCall(over: { id?: string; uuid?: string; sourceToolAssistantUUID?: string | null; input?: object } = {}): ClaudeTranscriptRecord[] {
    const uuid = over.uuid ?? ASSISTANT_UUID;
    const source = over.sourceToolAssistantUUID === null ? {} : { sourceToolAssistantUUID: over.sourceToolAssistantUUID ?? uuid };
    return [
        {
            type: 'assistant',
            sessionId: ID,
            uuid,
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: over.id ?? TOOL_USE,
                    name: 'Agent',
                    input: { description: '[redacted]', prompt: '[redacted]', subagent_type: 'general-purpose', run_in_background: false, ...(over.input ?? {}) },
                }],
            },
        },
        {
            type: 'user',
            sessionId: ID,
            uuid: 'b2ce9716-dd13-45b5-aad7-9199cceaa500',
            ...source,
            toolUseResult: { agentId: AGENT, agentType: 'general-purpose', status: 'completed' },
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: over.id ?? TOOL_USE, content: 'ok' }],
            },
        },
    ] as unknown as ClaudeTranscriptRecord[];
}

function child(over: { meta?: object; extraRecords?: ClaudeTranscriptRecord[] } = {}): Child {
    return {
        records: [
            { type: 'user', isSidechain: true, agentId: AGENT, sessionId: ID, message: { role: 'user', content: 'go' } },
            {
                type: 'assistant',
                isSidechain: true,
                agentId: AGENT,
                sessionId: ID,
                message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
            },
            // Carrying the child's identity, so a test about descent is about
            // descent rather than about the identity check ahead of it.
            ...(over.extraRecords ?? []).map((record) => ({
                ...(record as Record<string, unknown>), isSidechain: true, agentId: AGENT, sessionId: ID,
            })),
        ] as unknown as ClaudeTranscriptRecord[],
        meta: {
            agentType: 'general-purpose',
            description: 'probe subagent',
            toolUseId: TOOL_USE,
            spawnDepth: 1,
            requestShape: 'foreground',
            requestNonInteractive: true,
            ...(over.meta ?? {}),
        },
    };
}

function derive(records: ClaudeTranscriptRecord[], children: Record<string, Child> = {}) {
    return deriveClaudeTranscriptDependencies({
        nativeId: ID,
        canonicalCwd: CWD,
        providerHome: HOME,
        records,
        children: new Map(Object.entries(children)),
    });
}

describe('subagents a transcript names', () => {
    it('shouldDeriveTheAgentPairTheTranscriptItselfRecords', () => {
        expect(derive(agentCall(), { [AGENT]: child() })).toEqual({
            derived: true,
            subagents: [{ nativeId: ID, toolUseId: TOOL_USE, agentId: AGENT }],
            references: [],
        });
    });

    it('shouldBindOnBothLinksTheRecordActuallyCarries', () => {
        /*
         * The fixture's result row carries **two** links to the call: the
         * `tool_result.tool_use_id`, and `sourceToolAssistantUUID` pointing at
         * the assistant row's own `uuid` (`a8a65a11...` -> row 12 in
         * `/tmp/pr3557-op2-resume-probe3`). Both are checked when present, so a
         * result cannot be paired with a call the transcript did not pair it
         * with.
         */
        expect(derive(agentCall(), { [AGENT]: child() })).toMatchObject({
            derived: true,
            subagents: [{ toolUseId: TOOL_USE, agentId: AGENT }],
        });
    });

    it('shouldRefuseWhenTheTwoLinksInAnAgentRecordDisagree', () => {
        // `tool_use_id` says one call, `sourceToolAssistantUUID` says another
        // row wrote it. One of them is wrong and nothing here can say which.
        const records = agentCall({ sourceToolAssistantUUID: 'ffffffff-0000-4000-8000-000000000000' });
        expect(derive(records, { [AGENT]: child() }))
            .toEqual({ derived: false, refusal: 'result-binding-conflict' });
    });

    it('shouldStillBindWhenOnlyTheToolUseIdIsPresent', () => {
        // `sourceToolAssistantUUID` is used when present and never required:
        // its absence is not evidence of anything.
        expect(derive(agentCall({ sourceToolAssistantUUID: null }), { [AGENT]: child() })).toMatchObject({
            derived: true,
            subagents: [{ toolUseId: TOOL_USE, agentId: AGENT }],
        });
    });

    it('shouldRefuseAnAgentCallWhoseResultNeverArrived', () => {
        /*
         * An `Agent` tool_use with no matching result is an incomplete record,
         * not an absence of subagents. Omitting it silently would archive a
         * session whose child files were never even looked for.
         */
        // The general rule reaches it first now: an unanswered call of any tool
        // is a truncated transcript.
        const [call] = agentCall();
        expect(derive([call!])).toEqual({ derived: false, refusal: 'tool-result-missing' });
    });

    it('shouldRefuseAnAgentCallAnsweredWithoutNamingItsChild', () => {
        // Answered, so not truncated - but the result carries no `agentId`, so
        // the session commits to a child nobody can name.
        const records = agentCall();
        delete (records[1] as Record<string, unknown>).toolUseResult;
        expect(derive(records)).toEqual({ derived: false, refusal: 'agent-result-errored' });
    });

    it('shouldRefuseWhenTheChildFilesWereNotProvided', () => {
        expect(derive(agentCall())).toEqual({ derived: false, refusal: 'subagent-missing' });
    });

    it('shouldRefuseAChildWhoseRowsNameAnotherSession', () => {
        // Not the first row only: a child that changes session part-way is not
        // this parent's child, and the tail is where that shows.
        const stray = child();
        (stray.records[1] as unknown as Record<string, unknown>).sessionId = 'ffffffff-0000-4000-8000-000000000000';
        expect(derive(agentCall(), { [AGENT]: stray }))
            .toEqual({ derived: false, refusal: 'subagent-session-mismatch' });
    });

    it('shouldRefuseAChildWhoseMetaBindsADifferentToolUse', () => {
        expect(derive(agentCall(), { [AGENT]: child({ meta: { toolUseId: 'toolu_other' } }) }))
            .toEqual({ derived: false, refusal: 'subagent-binding-mismatch' });
    });

    it.each([
        ['a nested spawn', { spawnDepth: 2 }],
        ['a background request', { requestShape: 'background' }],
        ['an interactive request', { requestNonInteractive: false }],
    ])('shouldRefuseAChildOutsideTheMeasuredEnvelope(%s)', (_name, meta) => {
        expect(derive(agentCall(), { [AGENT]: child({ meta }) }))
            .toEqual({ derived: false, refusal: 'subagent-unsupported-shape' });
    });

    it('shouldRefuseTwoAgentCallsClaimingTheSameChild', () => {
        const records = [...agentCall(), ...agentCall({ id: 'toolu_agent_2' })];
        expect(derive(records, { [AGENT]: child() }))
            .toEqual({ derived: false, refusal: 'agent-duplicate' });
    });

    it('shouldDescendIntoAChildAndRefuseAnAgentCallInsideIt', () => {
        // A grandchild is outside the envelope, and a guard that only listed
        // directories would never see that it was missing.
        expect(derive(agentCall(), { [AGENT]: child({ extraRecords: agentCall() }) }))
            .toEqual({ derived: false, refusal: 'subagent-unsupported-shape' });
    });
});

describe('persisted outputs a transcript references', () => {
    const persisted = (over: { path?: string; size?: number } = {}): ClaudeTranscriptRecord[] => ([
        {
            type: 'assistant',
            sessionId: ID,
            uuid: 'c1111111-0000-4000-8000-000000000001',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: '[redacted]' } }],
            },
        },
        {
            type: 'user',
            sessionId: ID,
            toolUseResult: {
                interrupted: false,
                persistedOutputPath: over.path ?? `${ARTIFACT_DIR}/bwmc1gbmg.txt`,
                persistedOutputSize: over.size ?? 214893,
                stdout: 'BIGLINE-1',
            },
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_bash_1', content: 'stub' }],
            },
        },
    ] as unknown as ClaudeTranscriptRecord[]);

    it('shouldDeriveTheReferenceFromTheStructuredFieldsNotTheStubText', () => {
        /*
         * `toolUseResult.persistedOutputPath` / `persistedOutputSize` are real
         * fields on the record. The `<persisted-output>` stub in the message is
         * prose for the model, and parsing a path out of prose is how a rename
         * upstream becomes a silently dropped dependency.
         */
        expect(derive(persisted())).toEqual({
            derived: true,
            subagents: [],
            references: [{ nativeId: ID, toolUseId: 'toolu_bash_1', segment: 'bwmc1gbmg.txt', size: 214893 }],
        });
    });

    it('shouldKeepTheReferenceEvenThoughNothingOnDiskWasConsulted', () => {
        // The derivation never touches a filesystem. A reference survives into
        // the result precisely so a missing artifact can be refused later -
        // including when no `tool-results/` directory exists at all, which a
        // directory walk would have nothing to report.
        const result = derive(persisted());
        expect(result.derived && result.references).toHaveLength(1);
    });

    it.each([
        ['another session', `${HOME}/.claude/projects/-fixture-work/ffffffff-0000-4000-8000-000000000000/tool-results/x.txt`],
        ['another project', `${HOME}/.claude/projects/-other-project/${ID}/tool-results/x.txt`],
        ['another home', `/elsewhere/.claude/projects/-fixture-work/${ID}/tool-results/x.txt`],
        ['a relative path', 'tool-results/x.txt'],
    ])('shouldRefuseAReferenceOutsideThisSessionsDirectory(%s)', (_name, path) => {
        expect(derive(persisted({ path }))).toEqual({ derived: false, refusal: 'reference-foreign' });
    });

    it.each([
        ['a traversal', `${ARTIFACT_DIR}/../../escape.txt`],
        ['a nested segment', `${ARTIFACT_DIR}/sub/x.txt`],
        ['an empty segment', `${ARTIFACT_DIR}/`],
        ['an overlong segment', `${ARTIFACT_DIR}/${'x'.repeat(200)}.txt`],
    ])('shouldRefuseASegmentThatIsNotOneOrdinaryName(%s)', (_name, path) => {
        expect(derive(persisted({ path })).derived).toBe(false);
    });

    it('shouldRefuseASegmentCarryingAControlCharacter', () => {
        // Built rather than written literally: a control character in source is
        // invisible in review, which is the same reason it must not reach a path.
        const path = `${ARTIFACT_DIR}/x${String.fromCharCode(1)}.txt`;
        expect(derive(persisted({ path })).derived).toBe(false);
    });

    it('shouldRefuseAnArtifactResultWhoseSourceLinkPointsElsewhere', () => {
        /*
         * Root's raw probe: with `sourceToolAssistantUUID: 'wrong-source'` the
         * artifact still derived. The two-link check was written inside the
         * `Agent` branch, so it guarded one kind of structured result and left
         * every other kind - including the one that names a file to carry -
         * bound on a single link.
         *
         * The links belong to the record, not to the tool, so the check belongs
         * where the record is read.
         */
        const records = persisted().map((row) => {
            const copy = { ...(row as Record<string, unknown>) };
            if (copy.toolUseResult) copy.sourceToolAssistantUUID = 'wrong-source';
            return copy;
        }) as unknown as ClaudeTranscriptRecord[];
        expect(derive(records)).toEqual({ derived: false, refusal: 'result-binding-conflict' });
    });

    it('shouldStillDeriveWhenTheArtifactSourceLinkAgrees', () => {
        // The same record with the link the transcript actually wrote.
        const records = persisted().map((row) => {
            const copy = { ...(row as Record<string, unknown>) };
            if (copy.toolUseResult) copy.sourceToolAssistantUUID = 'c1111111-0000-4000-8000-000000000001';
            return copy;
        }) as unknown as ClaudeTranscriptRecord[];
        expect(derive(records)).toMatchObject({ derived: true, references: [{ segment: 'bwmc1gbmg.txt' }] });
    });

    it('shouldRefuseAReferenceThatOnlyNormalisesToTheRightPath', () => {
        /*
         * Root's path probe: a trailing separator was accepted, because
         * `dirname`/`basename` normalise it away - and the derivation then
         * returned a clean segment for a reference the consumer would open
         * verbatim. `Read` of the original string gives ENOTDIR while the
         * artifact itself sits there, present and uncarried.
         *
         * So the reference must **equal** the canonical path this runtime
         * constructs, character for character. Normalising a foreign shape into
         * an acceptable one is how the two sides stop agreeing about what the
         * file is called.
         */
        expect(derive(persisted({ path: `${ARTIFACT_DIR}/bwmc1gbmg.txt/` })))
            .toEqual({ derived: false, refusal: 'reference-foreign' });
    });

    it.each([
        ['a doubled separator', `${ARTIFACT_DIR}//bwmc1gbmg.txt`],
        ['a dot segment', `${ARTIFACT_DIR}/./bwmc1gbmg.txt`],
        ['a trailing dot', `${ARTIFACT_DIR}/bwmc1gbmg.txt/.`],
    ])('shouldRefuseAReferenceThatIsMerelyEquivalent(%s)', (_name, path) => {
        expect(derive(persisted({ path })).derived).toBe(false);
    });

    it('shouldRefuseTwoRecordsClaimingTheSameArtifactWithDifferentSizes', () => {
        // Two distinct calls, one file name, two sizes. Whichever were carried,
        // the other record describes a file that is not the one on disk.
        const second = persisted({ size: 99 }).map((row, index) => {
            const copy = { ...(row as Record<string, unknown>) };
            const message = copy.message as { role: string; content: Record<string, unknown>[] };
            copy.message = {
                ...message,
                content: message.content.map((block) => ({
                    ...block,
                    ...(block.type === 'tool_use' ? { id: 'toolu_bash_2' } : {}),
                    ...(block.type === 'tool_result' ? { tool_use_id: 'toolu_bash_2' } : {}),
                })),
            };
            if (index === 0) copy.uuid = 'c1111111-0000-4000-8000-000000000002';
            return copy;
        }) as unknown as ClaudeTranscriptRecord[];
        expect(derive([...persisted(), ...second]))
            .toEqual({ derived: false, refusal: 'reference-conflict' });
    });

    it('shouldRefuseAnArtifactReferenceInsideAChild', () => {
        // Not measured, so not claimed: a child's own persisted output is an
        // unsupported shape rather than a second reference to carry.
        expect(derive(agentCall(), { [AGENT]: child({ extraRecords: persisted() }) }))
            .toEqual({ derived: false, refusal: 'subagent-unsupported-shape' });
    });
});

describe('records this derivation does not understand', () => {
    it('shouldRefuseAnUnrecognisedRecordRatherThanWalkPastIt', () => {
        /*
         * No compaction detector is claimed: nothing in the pinned fixtures
         * carries a compaction marker - the only `compact` strings there are
         * inside a tool schema's description - and `{type:'summary'}` exists in
         * `claude/types.ts` with no measured relation to `/compact`.
         *
         * So the rule is about what this code can account for, not about naming
         * a feature it has never seen: a record type outside the set below
         * refuses, and an unknown compaction record would be refused as one of
         * those rather than recognised as compaction.
         */
        const odd = [{ type: 'something-new', sessionId: ID }] as unknown as ClaudeTranscriptRecord[];
        expect(derive(odd)).toEqual({ derived: false, refusal: 'record-unrecognised' });
    });

    it('shouldAcceptTheRecordTypesTheFixturesActuallyContain', () => {
        const ordinary = [
            { type: 'user', sessionId: ID, message: { role: 'user', content: 'hi' } },
            {
                type: 'assistant',
                sessionId: ID,
                message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            },
            { type: 'attachment', sessionId: ID },
            { type: 'queue-operation', sessionId: ID },
            { type: 'atis-latch', sessionId: ID },
            { type: 'last-prompt', sessionId: ID },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(ordinary)).toEqual({ derived: true, subagents: [], references: [] });
    });

    it('shouldRefuseARowThatNamesAnotherSession', () => {
        const strayParent = [
            { type: 'user', sessionId: 'ffffffff-0000-4000-8000-000000000000', message: { role: 'user', content: 'hi' } },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(strayParent)).toEqual({ derived: false, refusal: 'transcript-session-mismatch' });
    });
});

describe('the records the CLI actually writes', () => {
    /*
     * Driven by the pinned Linux seed rather than by shapes invented here. The
     * guessed vocabulary this file started with admitted `summary`, which no
     * fixture contains, and refused `queue-operation`, `atis-latch` and
     * `last-prompt`, which every fixture contains - so both positive cases
     * below would have been refused while something unmeasured was accepted.
     */
    const SEED_ID = '330a1f93-cda9-4080-89a3-c780c9ade479';
    const ARTIFACT_ID = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';

    function deriveSeed(records: ClaudeTranscriptRecord[], nativeId: string, children: Record<string, unknown> = {}) {
        return deriveClaudeTranscriptDependencies({
            nativeId,
            canonicalCwd: '/fixture/work',
            providerHome: '/fixture/home',
            records,
            children: new Map(Object.entries(children)) as never,
        });
    }

    it('shouldDeriveTheAgentPairOutOfThePinnedLinuxSeed', () => {
        expect(deriveSeed(PINNED_PARENT_WITH_AGENT, SEED_ID, {
            a4ec78d2c4e3608ba: { records: PINNED_CHILD, meta: PINNED_CHILD_META },
        })).toEqual({
            derived: true,
            subagents: [{ nativeId: SEED_ID, toolUseId: 'toolu_agent_1', agentId: 'a4ec78d2c4e3608ba' }],
            references: [],
        });
    });

    it('shouldRefuseThePinnedSeedWhenItsChildFilesAreNotOffered', () => {
        // The same transcript, nothing else changed: the session commits to a
        // child, so a checkpoint that cannot produce it is not complete.
        expect(deriveSeed(PINNED_PARENT_WITH_AGENT, SEED_ID))
            .toEqual({ derived: false, refusal: 'subagent-missing' });
    });

    it('shouldDeriveThePersistedOutputOutOfThePinnedArtifactSeed', () => {
        expect(deriveSeed(PINNED_PARENT_WITH_ARTIFACTS, ARTIFACT_ID)).toEqual({
            derived: true,
            subagents: [],
            references: [{
                nativeId: ARTIFACT_ID,
                toolUseId: 'toolu_big_1',
                segment: 'bwmc1gbmg.txt',
                size: 214893,
            }],
        });
    });

    it('shouldRefuseThePinnedSeedWithItsCallRowsIdentityRemoved', () => {
        // The same real transcript, one field deleted: without the assistant
        // row's `uuid` the second link cannot be checked at all.
        const stripped = PINNED_PARENT_WITH_AGENT.map((row) => {
            const record = row as Record<string, unknown>;
            const blocks = (record.message as { content?: unknown })?.content;
            const isCall = Array.isArray(blocks)
                && blocks.some((block) => (block as { type?: string }).type === 'tool_use');
            if (!isCall) return row;
            const copy = { ...record };
            delete copy.uuid;
            return copy as unknown as ClaudeTranscriptRecord;
        });
        expect(deriveSeed(stripped, SEED_ID, {
            a4ec78d2c4e3608ba: { records: PINNED_CHILD, meta: PINNED_CHILD_META },
        })).toEqual({ derived: false, refusal: 'call-row-unidentified' });
    });

    it('shouldRefuseThePinnedSeedIfItWerePresentedAsASidechain', () => {
        // Real rows, one flag flipped: a child's file offered as the session's.
        const asChild = PINNED_PARENT_WITH_AGENT.map((row) => (
            { ...(row as Record<string, unknown>), isSidechain: true }
        )) as unknown as ClaudeTranscriptRecord[];
        expect(deriveSeed(asChild, SEED_ID, {
            a4ec78d2c4e3608ba: { records: PINNED_CHILD, meta: PINNED_CHILD_META },
        })).toEqual({ derived: false, refusal: 'transcript-not-a-parent' });
    });

    it('shouldRefuseAPinnedChildWhoseTailDisownsItsAgent', () => {
        // Every one of the nine rows carries `agentId` and `isSidechain`; the
        // last one is where a first-row-only check would let a stranger in.
        const tampered = PINNED_CHILD.map((row, index) => (
            index === PINNED_CHILD.length - 1 ? { ...row, agentId: 'b0000000000000000' } : row
        ));
        expect(deriveSeed(PINNED_PARENT_WITH_AGENT, SEED_ID, {
            a4ec78d2c4e3608ba: { records: tampered, meta: PINNED_CHILD_META },
        })).toEqual({ derived: false, refusal: 'subagent-identity-inconsistent' });
    });
});

describe('the inputs this runtime is handed', () => {
    it.each([
        ['a relative cwd', { canonicalCwd: 'work' }],
        ['a relative home', { providerHome: 'home' }],
        ['an empty cwd', { canonicalCwd: '' }],
    ])('shouldRefuseARootThatIsNotAbsolute(%s)', (_name, over) => {
        /*
         * `resolve()` would quietly fill a relative path in from whatever the
         * process cwd happens to be, and the derivation would then compare
         * references against a directory belonging to no runtime in particular.
         * These are explicit contracts; a caller that cannot say where the
         * workspace is has not said it.
         */
        expect(deriveClaudeTranscriptDependencies({
            nativeId: ID, canonicalCwd: CWD, providerHome: HOME, ...over,
            records: [{ type: 'user', sessionId: ID, message: { role: 'user', content: 'hi' } }] as unknown as ClaudeTranscriptRecord[],
        })).toEqual({ derived: false, refusal: 'root-not-absolute' });
    });
});

describe('roots that are absolute but not canonical', () => {
    it.each([
        ['a doubled separator', { canonicalCwd: '/fixture//work' }],
        ['a dot segment', { canonicalCwd: '/fixture/./work' }],
        ['a traversal', { canonicalCwd: '/fixture/other/../work' }],
        ['a trailing separator', { providerHome: '/fixture/home/' }],
    ])('shouldRefuseRatherThanTidyTheCallersPath(%s)', (_name, over) => {
        /*
         * Each of these resolves to the value the caller meant, and each would
         * produce a different slug or a different artifact directory if it were
         * used as written. Tidying it up silently makes the module agree with a
         * caller that has not said what it thinks it said - and the slug is the
         * one value where a near-miss means "session not found" rather than an
         * error anyone sees.
         */
        expect(deriveClaudeTranscriptDependencies({
            nativeId: ID, canonicalCwd: CWD, providerHome: HOME, ...over,
            records: [{ type: 'user', sessionId: ID, message: { role: 'user', content: 'hi' } }] as unknown as ClaudeTranscriptRecord[],
        })).toEqual({ derived: false, refusal: 'root-not-canonical' });
    });
});

describe('confusions between a parent and its children', () => {
    it('shouldRefuseACallRowWithNoIdentityOfItsOwn', () => {
        /*
         * Fable B3: deleting the assistant row's `uuid` disables the
         * `sourceToolAssistantUUID` comparison entirely - the check is written
         * as "compare when both are present", so removing one side turns it
         * off. A call row that cannot be pointed at is a row whose second link
         * can never be verified, so it refuses rather than quietly dropping to
         * one link.
         */
        const records = agentCall();
        delete (records[0] as Record<string, unknown>).uuid;
        expect(derive(records, { [AGENT]: child() }))
            .toEqual({ derived: false, refusal: 'call-row-unidentified' });
    });

    it('shouldRefuseAParentTranscriptFlaggedAsASidechain', () => {
        /*
         * Fable B8: `isSidechain: true` on parent rows was accepted. A sidechain
         * is a child's own file, and a child read as a parent would have its
         * `Agent` calls derived as if they were the session's - the exact
         * parent/child confusion the descent exists to prevent.
         */
        const records = agentCall().map((row) => ({ ...(row as Record<string, unknown>), isSidechain: true })) as unknown as ClaudeTranscriptRecord[];
        expect(derive(records, { [AGENT]: child() }))
            .toEqual({ derived: false, refusal: 'transcript-not-a-parent' });
    });

    it('shouldRefuseACompactedTranscriptWithoutClaimingToDetectCompaction', () => {
        /*
         * A `system` row refuses as an unrecognised type, which is the right
         * outcome and is all this delta claims. Fable identified a real marker
         * (`system` with `subtype: 'compact_boundary'`) from their own local
         * transcripts, but that is not pinned consumer evidence, so it gets no
         * named code here: a detector nobody has measured would be a claim
         * about a feature this module has never seen.
         *
         * RUN.md's statement stands as written - no *pinned fixture* carries a
         * compaction marker.
         */
        const compacted = [
            { type: 'user', sessionId: ID, message: { role: 'user', content: 'hi' } },
            { type: 'system', subtype: 'compact_boundary', sessionId: ID, uuid: 'u1' },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(compacted)).toEqual({ derived: false, refusal: 'record-unrecognised' });
    });

    it('shouldSayAnAgentResultErroredRatherThanThatItNeverArrived', () => {
        // Fable: the result did arrive and carried no `agentId`. Calling that
        // "missing" sends the reader looking for a truncated file.
        const records = agentCall();
        delete (records[1] as Record<string, unknown>).toolUseResult;
        expect(derive(records)).toEqual({ derived: false, refusal: 'agent-result-errored' });
    });
});

describe('a transcript has to contain a turn, not merely a row that could hold one', () => {
    /*
     * freeze80 refused a queue-operation-only file as `not-a-conversation` and
     * in the same breath accepted `[{type:'assistant'}]` - a row with no
     * message at all - and pinned that as deliberate. Those are the same
     * question answered two ways, and the second answer was wrong: an
     * empty-but-well-formed file would have passed as a covered session.
     *
     * The fix is bounded on purpose. At least one `user` or `assistant` row
     * must carry this session's id and an actual message with content. It is
     * still not a consumer validator and guarantees nothing about
     * resumability; it only stops this module calling a file with no turn in
     * it a conversation.
     */
    const withRows = (...rows: unknown[]) => derive(rows as ClaudeTranscriptRecord[]);

    it('shouldRefuseARowThatIsAnAssistantInNameOnly', () => {
        expect(withRows({ type: 'assistant' }))
            .toEqual({ derived: false, refusal: 'transcript-not-a-conversation' });
    });

    it.each([
        ['no message at all', { type: 'user', sessionId: ID }],
        ['a message that is not an object', { type: 'user', sessionId: ID, message: 'hello' }],
        ['a message with no content', { type: 'user', sessionId: ID, message: { role: 'user' } }],
        ['empty string content', { type: 'user', sessionId: ID, message: { role: 'user', content: '' } }],
        ['empty array content', { type: 'assistant', sessionId: ID, message: { role: 'assistant', content: [] } }],
        ['content of the wrong kind', { type: 'user', sessionId: ID, message: { role: 'user', content: 42 } }],
    ])('shouldRefuseAMessageThatCarriesNothing(%s)', (_name, row) => {
        expect(withRows(row)).toEqual({ derived: false, refusal: 'transcript-not-a-conversation' });
    });

    it('shouldRequireTheTurnItselfToNameThisSession', () => {
        // A row that merely does not contradict the session is not a row that
        // claims it. The measured turns all carry the id.
        expect(withRows(
            { type: 'queue-operation', sessionId: ID },
            { type: 'user', message: { role: 'user', content: 'hi' } },
        )).toEqual({ derived: false, refusal: 'transcript-not-a-conversation' });
    });

    it.each([
        ['a plain user string, as the seeds carry it', { type: 'user', sessionId: ID, message: { role: 'user', content: 'hi' } }],
        ['an assistant block array, as the seeds carry it', { type: 'assistant', sessionId: ID, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }],
    ])('shouldAcceptTheTurnShapesTheSeedsActuallyContain(%s)', (_name, row) => {
        expect(withRows(row)).toEqual({ derived: true, subagents: [], references: [] });
    });
});

describe('shapes that must not pass unexamined', () => {
    const base = (blocks: unknown[]): ClaudeTranscriptRecord[] => ([
        { type: 'assistant', sessionId: ID, uuid: 'c1', message: { role: 'assistant', content: blocks } },
    ] as unknown as ClaudeTranscriptRecord[]);

    it.each([['TaskOutput'], ['TaskStop']])('shouldRefuseAToolWhoseStateWasNeverMeasured(%s)', (name) => {
        expect(derive(base([{ type: 'tool_use', id: 't1', name, input: {} }])))
            .toEqual({ derived: false, refusal: 'tool-unsupported' });
    });

    it('shouldRefuseAToolResultBindingToNoCall', () => {
        const orphan = [
            { type: 'user', sessionId: ID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nobody', content: 'x' }] } },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(orphan)).toEqual({ derived: false, refusal: 'tool-binding-invalid' });
    });

    it('shouldRefuseASecondResultForOneCall', () => {
        const twice = [
            ...base([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
            { type: 'user', sessionId: ID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }] } },
            { type: 'user', sessionId: ID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'b' }] } },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(twice)).toEqual({ derived: false, refusal: 'tool-binding-invalid' });
    });

    it('shouldRefuseAnEmptyTranscript', () => {
        // Nothing to vouch for is not the same as nothing being needed.
        expect(derive([])).toEqual({ derived: false, refusal: 'transcript-empty' });
    });

    it('shouldRefuseAnEmptyChildTranscript', () => {
        expect(derive(agentCall(), { [AGENT]: { records: [], meta: child().meta } }))
            .toEqual({ derived: false, refusal: 'subagent-empty' });
    });

    it('shouldRefuseASessionIdThatIsNotEvenAString', () => {
        const odd = [{ type: 'user', sessionId: 7, message: { role: 'user', content: 'hi' } }] as unknown as ClaudeTranscriptRecord[];
        expect(derive(odd)).toEqual({ derived: false, refusal: 'transcript-session-mismatch' });
    });

    it.each([
        ['not a uuid', 'not-a-session'],
        ['a traversal', '../../etc'],
        ['a separator', 'a/b'],
    ])('shouldRefuseASessionIdentifierBeforeItBecomesAPathComponent(%s)', (_name, nativeId) => {
        expect(deriveClaudeTranscriptDependencies({
            nativeId, canonicalCwd: CWD, providerHome: HOME,
            records: [{ type: 'user', message: { role: 'user', content: 'hi' } }] as unknown as ClaudeTranscriptRecord[],
        })).toEqual({ derived: false, refusal: 'identifier-invalid' });
    });

    it('shouldRefuseAnAgentIdentifierOfTheWrongShape', () => {
        const records = agentCall();
        (records[1] as Record<string, unknown>).toolUseResult = { agentId: '../escape' };
        expect(derive(records)).toEqual({ derived: false, refusal: 'identifier-invalid' });
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['fractional', 1.5],
        ['beyond safe integers', Number.MAX_SAFE_INTEGER + 2],
    ])('shouldRefuseARecordedSizeThatIsNotAByteCount(%s)', (_name, size) => {
        const records = [
            { type: 'assistant', sessionId: ID, uuid: 'c1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: '[redacted]' } }] } },
            {
                type: 'user',
                sessionId: ID,
                toolUseResult: { persistedOutputPath: `${ARTIFACT_DIR}/x.txt`, persistedOutputSize: size },
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'stub' }] },
            },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(records)).toEqual({ derived: false, refusal: 'reference-size-invalid' });
    });

    it('shouldRefuseAPersistedOutputBoundToNoToolCall', () => {
        const unbound = [
            {
                type: 'user',
                sessionId: ID,
                toolUseResult: { persistedOutputPath: `${ARTIFACT_DIR}/x.txt`, persistedOutputSize: 10 },
                message: { role: 'user', content: 'no blocks at all' },
            },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(unbound)).toEqual({ derived: false, refusal: 'tool-binding-invalid' });
    });
});

describe('the accepted native envelope, as measured', () => {
    /*
     * Astra's five gaps. Each was a shape that derived cleanly and should not
     * have: a checkpoint reading `derived: true` as coverage readiness would
     * have carried, or refused to carry, the wrong thing in every one of them.
     */
    const row = (over: object): ClaudeTranscriptRecord => ({ type: 'user', sessionId: ID, ...over }) as unknown as ClaudeTranscriptRecord;

    it('shouldRefuseATranscriptWithNoUserOrAssistantTurnAtAll', () => {
        // A queue-operation-only file is bookkeeping, not a conversation, and
        // nothing in it could be resumed.
        const queueOnly = [
            { type: 'queue-operation', sessionId: ID },
            { type: 'queue-operation', sessionId: ID },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(queueOnly)).toEqual({ derived: false, refusal: 'transcript-not-a-conversation' });
    });

    it('shouldRefuseAToolThisEnvelopeHasNeverSeen', () => {
        /*
         * The measured set is exactly `Agent` and `Bash`. A tool nobody has run
         * here may write files of its own, and accepting it would be claiming
         * coverage of consequences never observed. Unknown refuses until it is
         * measured, rather than being assumed harmless.
         */
        const unknown = [
            { type: 'assistant', sessionId: ID, uuid: 'c1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'FutureProviderTool', input: {} }] } },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(unknown)).toEqual({ derived: false, refusal: 'tool-unsupported' });
    });

    it('shouldRefuseAnOrdinaryToolCallThatWasNeverAnswered', () => {
        // An unanswered `Bash` is an incomplete record, exactly as an unanswered
        // `Agent` is. Reading it as a closed call mistakes a truncated
        // transcript for a finished one.
        const dangling = [
            { type: 'assistant', sessionId: ID, uuid: 'c1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: '[redacted]' } }] } },
            { type: 'user', sessionId: ID, message: { role: 'user', content: 'no result ever came' } },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(dangling)).toEqual({ derived: false, refusal: 'tool-result-missing' });
    });

    it('shouldRefuseABackgroundAgentCall', () => {
        /*
         * The meta says `requestShape: 'foreground'`; the call itself carries
         * `run_in_background`. Measured value is `false`, and background agents
         * are untested - so the two must agree and `true` is outside the
         * envelope rather than a second supported mode.
         */
        expect(derive(agentCall({ input: { run_in_background: true } }), { [AGENT]: child() }))
            .toEqual({ derived: false, refusal: 'tool-unsupported' });
    });

    it('shouldRefuseWhenTheMetaClaimsBackgroundThoughTheCallDidNot', () => {
        // The other direction: the call is foreground - or silent, which the
        // seed's explicit `false` makes the default - and the meta disagrees.
        expect(derive(agentCall(), { [AGENT]: child({ meta: { requestShape: 'background' } }) }))
            .toEqual({ derived: false, refusal: 'subagent-unsupported-shape' });
    });

    it('shouldRefuseABackgroundCallOfAnyTool', () => {
        /*
         * Astra: the flag was captured for every tool and enforced only for
         * `Agent`, so a backgrounded `Bash` derived cleanly. Nothing has
         * measured what a background call writes or when it finishes, and a
         * checkpoint taken while one is still running is exactly the case this
         * module cannot see.
         */
        const records = [
            { type: 'user', sessionId: ID, message: { role: 'user', content: 'hi' } },
            { type: 'assistant', sessionId: ID, uuid: 'c1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: '[redacted]', run_in_background: true } }] } },
            { type: 'user', sessionId: ID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(records)).toEqual({ derived: false, refusal: 'tool-unsupported' });
    });

    it('shouldRefuseASourceLinkThatIsPresentButNotAnIdentifier', () => {
        /*
         * Astra: `sourceToolAssistantUUID: 42` was read as absent, because the
         * check was "compare when it is a string". A present-but-malformed link
         * is a record this module does not understand, not a record that
         * declined to link - and treating the two alike is how the second link
         * stops being a check at all.
         */
        const records = [
            { type: 'user', sessionId: ID, message: { role: 'user', content: 'hi' } },
            { type: 'assistant', sessionId: ID, uuid: 'c1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: '[redacted]' } }] } },
            {
                type: 'user',
                sessionId: ID,
                sourceToolAssistantUUID: 42,
                toolUseResult: { persistedOutputPath: `${ARTIFACT_DIR}/x.txt`, persistedOutputSize: 10 },
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'stub' }] },
            },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(derive(records)).toEqual({ derived: false, refusal: 'result-binding-conflict' });
    });

    it.each([
        ['omits agentId', 'agentId', 'subagent-identity-inconsistent'],
        ['omits isSidechain', 'isSidechain', 'subagent-identity-inconsistent'],
        ['omits sessionId', 'sessionId', 'subagent-session-mismatch'],
    ])('shouldRefuseAChildMessageRowThatDropsItsIdentity(%s)', (_name, field, refusal) => {
        /*
         * Every message row of the measured child carries all three. A row that
         * simply leaves one out used to pass, because the check only looked at
         * rows that carried the field - so the way to smuggle a foreign row in
         * was to say nothing at all.
         */
        const tampered = child();
        const last = { ...(tampered.records[tampered.records.length - 1] as Record<string, unknown>) };
        delete last[field];
        tampered.records[tampered.records.length - 1] = last as unknown as ClaudeTranscriptRecord;
        expect(derive(agentCall(), { [AGENT]: tampered })).toEqual({ derived: false, refusal });
    });
});

describe('what a parent transcript names, read on its own', () => {
    /*
     * A collector cannot learn which children to read from the full derivation:
     * it refuses `subagent-missing` as soon as a call has no child offered, and it
     * never says which `agentId` it wanted. Discovery answers that one question —
     * what this parent referenced — and says nothing about whether those files
     * exist or agree, which stays the full derivation's job.
     */
    const PARENT_SEED_ID = '330a1f93-cda9-4080-89a3-c780c9ade479';
    const ARTIFACT_SEED_ID = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';
    const SECOND_AGENT = 'b7cd91ffaa2e4401c';

    function discover(records: ClaudeTranscriptRecord[], over: {
        nativeId?: string; cwd?: string; home?: string;
    } = {}) {
        return discoverClaudeTranscriptDependencies({
            nativeId: over.nativeId ?? ID,
            canonicalCwd: over.cwd ?? CWD,
            providerHome: over.home ?? HOME,
            records,
        });
    }

    /** A second `Agent` call, naming a different child. */
    function secondAgentCall(): ClaudeTranscriptRecord[] {
        const [call, result] = agentCall({ id: 'toolu_agent_2', uuid: 'b1b65a11-72f4-46e5-86d3-ffd76469b66f' });
        return [
            call,
            {
                ...(result as Record<string, unknown>),
                uuid: 'c3ce9716-dd13-45b5-aad7-9199cceaa500',
                toolUseResult: { agentId: SECOND_AGENT, agentType: 'general-purpose', status: 'completed' },
            } as unknown as ClaudeTranscriptRecord,
        ];
    }

    it('shouldNameTheChildOfThePinnedLinuxParentWithNoChildFilesOffered', () => {
        expect(discoverClaudeTranscriptDependencies({
            nativeId: PARENT_SEED_ID,
            canonicalCwd: '/fixture/work',
            providerHome: '/fixture/home',
            records: PINNED_PARENT_WITH_AGENT,
        })).toEqual({ discovered: true, agentIds: ['a4ec78d2c4e3608ba'], references: [] });
    });

    it('shouldStillRefuseTheSameParentInTheFullDerivationWithoutThatChild', () => {
        // Two different questions about the same bytes: discovery must not soften
        // the answer the publisher's coverage depends on.
        expect(deriveClaudeTranscriptDependencies({
            nativeId: PARENT_SEED_ID,
            canonicalCwd: '/fixture/work',
            providerHome: '/fixture/home',
            records: PINNED_PARENT_WITH_AGENT,
        })).toEqual({ derived: false, refusal: 'subagent-missing' });
    });

    it('shouldNameThePersistedOutputOfThePinnedArtifactParent', () => {
        expect(discoverClaudeTranscriptDependencies({
            nativeId: ARTIFACT_SEED_ID,
            canonicalCwd: '/fixture/work',
            providerHome: '/fixture/home',
            records: PINNED_PARENT_WITH_ARTIFACTS,
        })).toEqual({
            discovered: true,
            agentIds: [],
            references: [{ segment: 'bwmc1gbmg.txt', size: 214893 }],
        });
    });

    it('shouldNameBothChildrenOfATranscriptWithTwoCalls', () => {
        expect(discover([...agentCall(), ...secondAgentCall()])).toEqual({
            discovered: true,
            agentIds: [AGENT, SECOND_AGENT],
            references: [],
        });
    });

    it('shouldReportNothingForATurnThatCallsNoTool', () => {
        const records = [
            { type: 'user', sessionId: ID, uuid: 'd1', message: { role: 'user', content: 'hello' } },
            { type: 'assistant', sessionId: ID, uuid: 'd2', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(discover(records)).toEqual({ discovered: true, agentIds: [], references: [] });
    });

    it.each([
        ['a session id of the wrong shape', { nativeId: 'nope' }, 'identifier-invalid'],
        ['a relative working directory', { cwd: 'work' }, 'root-not-absolute'],
        ['an uncanonical provider home', { home: '/fixture/home/' }, 'root-not-canonical'],
    ])('shouldRefuse %s with the code the full derivation uses', (_name, over, refusal) => {
        expect(discover(agentCall(), over)).toEqual({ discovered: false, refusal });
    });

    it('shouldRefuseATranscriptWithNoRecords', () => {
        expect(discover([])).toEqual({ discovered: false, refusal: 'transcript-empty' });
    });

    it('shouldRefuseAChildsOwnFileReadAsAParent', () => {
        const asChild = agentCall().map((row) => ({
            ...(row as Record<string, unknown>), isSidechain: true,
        })) as unknown as ClaudeTranscriptRecord[];
        expect(discover(asChild)).toEqual({ discovered: false, refusal: 'transcript-not-a-parent' });
    });

    it('shouldRefuseAnAgentCallWhoseResultNamedNoChild', () => {
        // Answered and errored rather than truncated: there is no child to look
        // for, and reporting none would hide that the call failed.
        const [call, result] = agentCall();
        const errored = [call, {
            ...(result as Record<string, unknown>),
            toolUseResult: { agentType: 'general-purpose', status: 'failed' },
        }] as unknown as ClaudeTranscriptRecord[];
        expect(discover(errored)).toEqual({ discovered: false, refusal: 'agent-result-errored' });
    });

    it('shouldRefuseACallThisCodeHasNeverBeenShownTheConsequencesOf', () => {
        const records = [
            {
                type: 'assistant', sessionId: ID, uuid: 'e1',
                message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'WebFetch', input: {} }] },
            },
            {
                type: 'user', sessionId: ID, uuid: 'e2', sourceToolAssistantUUID: 'e1',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
            },
        ] as unknown as ClaudeTranscriptRecord[];
        expect(discover(records)).toEqual({ discovered: false, refusal: 'tool-unsupported' });
    });

    it('shouldKeepTheEarlierCallsChildFailureAheadOfALaterCallsErroredResult', () => {
        /*
         * The precedence that a shared prelude could quietly change: the first
         * call's child is simply not offered, and the *second* call was answered
         * with no child at all. Walking calls in order answers for the first pair —
         * `subagent-missing`. Deciding every parent-level fact up front and
         * answering from that would report `agent-result-errored` instead, a
         * different code for the same transcript.
         */
        const [secondCall, secondResult] = secondAgentCall();
        const records = [
            ...agentCall(),
            secondCall,
            {
                ...(secondResult as Record<string, unknown>),
                toolUseResult: { agentType: 'general-purpose', status: 'failed' },
            } as unknown as ClaudeTranscriptRecord,
        ];
        expect(derive(records, {})).toEqual({ derived: false, refusal: 'subagent-missing' });
        // Discovery, asked on its own, does answer for the errored call.
        expect(discover(records)).toEqual({ discovered: false, refusal: 'agent-result-errored' });
    });

    it('shouldNotChangeWhichRefusalTheFullDerivationReportsFirst', () => {
        /*
         * Two calls: neither child is offered. The full derivation walks calls in
         * order and answers for the first pair, so `subagent-missing` must still be
         * what surfaces — collecting every parent-level fact up front and answering
         * from that would reorder codes the callers already read.
         */
        const records = [...agentCall(), ...secondAgentCall()];
        expect(derive(records, {})).toEqual({ derived: false, refusal: 'subagent-missing' });
        expect(discover(records)).toEqual({
            discovered: true, agentIds: [AGENT, SECOND_AGENT], references: [],
        });
    });
});

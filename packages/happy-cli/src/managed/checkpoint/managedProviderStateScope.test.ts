/**
 * The provider-state scope, as it arrives on the wire.
 *
 * Parsing is not coverage. A scope that parses says the parent named some
 * sources and signed them with the rest of the params; it does not say the
 * runtime holds those files, that provider state may be archived, or that a
 * provider ever started. The publisher's fail-closed refusal is untouched by
 * everything here.
 */
import { describe, expect, it } from 'vitest';

import { handleIpcRequest } from '@/launcher/ipcServer';

import {
    MANAGED_TARGET_MAX_BASE64,
    MANAGED_TARGET_MAX_BYTES,
    parseProviderStateScope,
} from './managedProviderStateScope';

const RUNTIME = 'runtime-1';
const GENERATION = {
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    runtimeId: RUNTIME,
    epoch: 3,
    provisioningOperationId: 'op-1',
};
const NATIVE_A = '330a1f93-cda9-4080-89a3-c780c9ade479';
const NATIVE_B = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';

function source(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        attemptId: 'attempt-1',
        runId: 'run-1',
        happySessionId: 'sess-1',
        runtimeId: RUNTIME,
        epoch: 3,
        currentNativeId: NATIVE_A,
        retainedNativeIds: [],
        metadataVersion: 1,
        ...over,
    };
}

function scope(over: Record<string, unknown> = {}): unknown {
    return {
        version: 1,
        provider: 'claude',
        capability: 'native-resume',
        generation: GENERATION,
        sources: [source()],
        ...over,
    };
}

describe('the shape the parent signs', () => {
    it('shouldParseTheScopeTheContractDescribes', () => {
        expect(parseProviderStateScope(scope())).toEqual({
            version: 1,
            provider: 'claude',
            capability: 'native-resume',
            generation: GENERATION,
            sources: [{
                attemptId: 'attempt-1',
                runId: 'run-1',
                happySessionId: 'sess-1',
                runtimeId: RUNTIME,
                epoch: 3,
                currentNativeId: NATIVE_A,
                retainedNativeIds: [],
                metadataVersion: 1,
            }],
        });
    });

    it.each([
        ['a version nobody has agreed', { version: 2 }],
        ['a provider outside the envelope', { provider: 'codex' }],
        ['a capability nobody measured', { capability: 'project-only' }],
    ])('shouldRefuseALiteralThatIsNotTheOneMeasured(%s)', (_name, over) => {
        expect(() => parseProviderStateScope(scope(over))).toThrow(/scope/);
    });

    it.each([
        ['at the top level', { extra: 1 }],
        ['inside the generation', { generation: { ...GENERATION, extra: 1 } }],
        ['inside a source', { sources: [source({ extra: 1 })] }],
    ])('shouldRefuseAKeyThisParserDoesNotKnow(%s)', (_name, over) => {
        // A key nobody agreed is a field one side is acting on and the other is
        // ignoring, which is the shape of every wire disagreement.
        expect(() => parseProviderStateScope(scope(over))).toThrow(/unknown key/);
    });

    it('shouldRefuseAnAbsentScopeRatherThanInventOne', () => {
        expect(() => parseProviderStateScope(undefined)).toThrow(/scope/);
        expect(() => parseProviderStateScope(null)).toThrow(/scope/);
        expect(() => parseProviderStateScope([])).toThrow(/scope/);
    });
});

describe('identifiers and counters', () => {
    it.each([
        ['an empty attemptId', { attemptId: '' }],
        ['an empty runId', { runId: '' }],
        ['an empty happySessionId', { happySessionId: '' }],
        ['a non-string attemptId', { attemptId: 7 }],
    ])('shouldRefuseAnIdentifierThatNamesNothing(%s)', (_name, over) => {
        expect(() => parseProviderStateScope(scope({ sources: [source(over)] }))).toThrow(/scope/);
    });

    it.each([
        ['a slash', 'attempt/1'],
        ['a traversal', '../attempt'],
        ['a backslash', 'attempt\\1'],
        ['an inner space', 'attempt 1'],
        ['a leading space', ' attempt-1'],
        ['a trailing space', 'attempt-1 '],
        ['a tab', `attempt${String.fromCharCode(9)}1`],
        ['a newline', `attempt${String.fromCharCode(10)}1`],
        ['a NUL', `attempt${String.fromCharCode(0)}1`],
        ['a control character', `attempt${String.fromCharCode(1)}1`],
        ['a right-to-left override', `attempt${String.fromCharCode(0x202e)}1`],
        ['a zero-width space', `attempt${String.fromCharCode(0x200b)}1`],
        ['an accented letter', `attempt-${String.fromCharCode(0xe9)}`],
        ['an emoji', `attempt-${String.fromCodePoint(0x1f600)}`],
        ['201 characters', 'a'.repeat(201)],
    ])('shouldRefuseAnIdentifierOutsideTheRuntimesOwnGrammar(%s)', (_name, attemptId) => {
        /*
         * The grammar is not invented here: `isSafeManagedId` is what the
         * managed IPC already applies to `runId` and `attemptId`
         * (`ipcServer.ts`), so a scope naming a generation the IPC could never
         * name would be unmatchable by construction.
         *
         * Before this, both parsers took any non-empty string - a cross-parser
         * table over these exact values showed 22 of 22 agreeing to accept a
         * NUL, a newline, `../`, an RTL override and an emoji.
         */
        expect(() => parseProviderStateScope(scope({ sources: [source({ attemptId })] })))
            .toThrow(/scope/);
    });

    it.each([
        ['an ordinary id', 'attempt-1'],
        ['an underscore', 'attempt_1'],
        ['a cuid', 'cmtw9vz1100nbtciaau5ibkfv'],
        ['a uuid', NATIVE_A],
        ['200 characters', 'a'.repeat(200)],
    ])('shouldAcceptTheIdentifiersTheProductActuallyUses(%s)', (_name, attemptId) => {
        expect(parseProviderStateScope(scope({ sources: [source({ attemptId })] }))
            .sources[0]!.attemptId).toBe(attemptId);
    });

    it('shouldApplyTheGrammarToEveryIdentifierNotOnlyTheAttempt', () => {
        for (const field of ['runId', 'happySessionId', 'runtimeId'] as const) {
            expect(() => parseProviderStateScope(scope({
                sources: [source({ [field]: 'bad/value' })],
            }))).toThrow(/scope/);
        }
        for (const field of ['projectId', 'workspaceId', 'provisioningOperationId'] as const) {
            expect(() => parseProviderStateScope(scope({
                generation: { ...GENERATION, [field]: 'bad/value' },
            }))).toThrow(/scope/);
        }
    });

    it.each([
        ['not a uuid', 'session-one'],
        ['a traversal', '../../etc/passwd'],
        ['a separator', 'a/b'],
    ])('shouldRefuseANativeIdOfTheWrongGrammar(%s)', (_name, currentNativeId) => {
        expect(() => parseProviderStateScope(scope({ sources: [source({ currentNativeId })] })))
            .toThrow(/scope/);
    });

    it('shouldAcceptEitherCaseAndKeepTheSpellingItWasGiven', () => {
        // The grammar is case-insensitive because the product's own is. That is
        // not permission to fold the value: it becomes a path.
        const upper = NATIVE_A.toUpperCase();
        const parsed = parseProviderStateScope(scope({ sources: [source({ currentNativeId: upper })] }));
        expect(parsed.sources[0]!.currentNativeId).toBe(upper);
    });

    it.each([
        ['epoch', 'epoch'],
        ['metadataVersion', 'metadataVersion'],
    ])('shouldAcceptZeroFor(%s)', (_name, field) => {
        // Zero is a real epoch and a real version. Refusing it would reject the
        // first checkpoint a runtime ever takes.
        const parsed = parseProviderStateScope(scope({
            generation: { ...GENERATION, epoch: 0 },
            sources: [source({ epoch: 0, [field]: 0 })],
        }));
        expect(parsed.sources[0]![field as 'epoch']).toBe(0);
    });

    it.each([
        ['negative', -1],
        ['fractional', 1.5],
        ['beyond safe integers', Number.MAX_SAFE_INTEGER + 2],
        ['a string', '1'],
    ])('shouldRefuseACounterThatIsNotASafeNonNegativeInteger(%s)', (_name, value) => {
        expect(() => parseProviderStateScope(scope({ sources: [source({ metadataVersion: value })] })))
            .toThrow(/scope/);
    });
});

describe('the source list', () => {
    it('shouldRefuseAnEmptyList', () => {
        // An empty list is not "nothing to cover" — the parent does not issue
        // one, so its arrival means something upstream went wrong.
        expect(() => parseProviderStateScope(scope({ sources: [] }))).toThrow(/scope/);
    });

    it('shouldRequireAttemptIdsInAscendingOrder', () => {
        expect(() => parseProviderStateScope(scope({
            sources: [source({ attemptId: 'attempt-2' }), source({ attemptId: 'attempt-1' })],
        }))).toThrow(/ascending/);
    });

    it('shouldRefuseTheSameAttemptTwice', () => {
        expect(() => parseProviderStateScope(scope({
            sources: [source(), source()],
        }))).toThrow(/ascending/);
    });

    it('shouldAllowTwoAttemptsToNameTheSameNativeSession', () => {
        /*
         * The one that matters. A resumed session keeps its native id across
         * attempts, so demanding global uniqueness would read an ordinary
         * continuation as a defect — and the two parsers have to agree about
         * this or a normal resume is refused on one side only.
         */
        const parsed = parseProviderStateScope(scope({
            sources: [
                source({ attemptId: 'attempt-1' }),
                source({ attemptId: 'attempt-2', currentNativeId: NATIVE_A }),
            ],
        }));
        expect(parsed.sources.map((entry) => entry.currentNativeId)).toEqual([NATIVE_A, NATIVE_A]);
    });

    it('shouldRefuseARetainedListThatRepeatsItself', () => {
        expect(() => parseProviderStateScope(scope({
            sources: [source({ retainedNativeIds: [NATIVE_B, NATIVE_B] })],
        }))).toThrow(/retained/);
    });

    it('shouldRefuseACurrentIdThatAlsoAppearsAsRetained', () => {
        // Inside one source the two lists mean different things, and an id in
        // both is a source that cannot say which it is.
        expect(() => parseProviderStateScope(scope({
            sources: [source({ retainedNativeIds: [NATIVE_A] })],
        }))).toThrow(/retained/);
    });

    it('shouldRefuseMoreThanThirtyTwoRetainedIdsInOneSource', () => {
        const many = Array.from({ length: 33 }, (_, index) => (
            `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
        ));
        expect(() => parseProviderStateScope(scope({ sources: [source({ retainedNativeIds: many })] })))
            .toThrow(/retained/);
        const most = many.slice(0, 32);
        expect(parseProviderStateScope(scope({ sources: [source({ retainedNativeIds: most })] }))
            .sources[0]!.retainedNativeIds).toHaveLength(32);
    });
});

describe('the generation axis', () => {
    it('shouldRefuseASourceFromAnotherRuntime', () => {
        /*
         * Foreign-runtime history reaches this filesystem only through a
         * restore, and nothing here can verify that a restore happened — a file
         * bearing the right id is not proof of where it came from. So it is
         * refused until the source-checkpoint binding is verified, rather than
         * quietly narrowed.
         */
        expect(() => parseProviderStateScope(scope({ sources: [source({ runtimeId: 'runtime-2' })] })))
            .toThrow(/runtime/);
    });

    it('shouldAcceptASourceFromAnEarlierEpochOfThisRuntime', () => {
        // A past epoch of the same runtime can still be on that filesystem.
        const parsed = parseProviderStateScope(scope({ sources: [source({ epoch: 0 })] }));
        expect(parsed.sources[0]!.epoch).toBe(0);
    });

    it('shouldRefuseASourceFromAnEpochThatHasNotHappened', () => {
        expect(() => parseProviderStateScope(scope({ sources: [source({ epoch: 4 })] })))
            .toThrow(/epoch/);
    });
});

describe('the transport limits', () => {
    it('shouldStateTheLimitsTheContractFixes', () => {
        // 256 KiB of JSON, and the base64 that many bytes becomes.
        expect(MANAGED_TARGET_MAX_BYTES).toBe(262144);
        expect(MANAGED_TARGET_MAX_BASE64).toBe(4 * Math.ceil(262144 / 3));
        expect(MANAGED_TARGET_MAX_BASE64).toBe(349528);
    });
});

describe('the identifier grammar stays the wire\'s own', () => {
    /*
     * Behavioural, not textual. This used to compare the regex literal in this
     * file against the one in `ipcServer.ts` by reading both sources - which
     * mirrors the implementation rather than testing it, and would fail a
     * rename or a refactor that changed nothing about what either accepts.
     *
     * What actually matters is that a scope cannot name a generation the IPC
     * could never carry. So the same ids go through both: the real
     * `handleIpcRequest`, and the scope parser. Wherever they disagree, a scope
     * would name something unmatchable by construction.
     *
     * Driver this mirrors: `/tmp/pr3557-astra-control83/parity.cjs`.
     */
    const TOKEN = 'a'.repeat(43);

    const throughIpc = async (id: string): Promise<boolean> => {
        let reached = false;
        const answer = await handleIpcRequest({
            raw: JSON.stringify({
                op: 'prove-stopped', token: TOKEN, key: { runId: id, attemptId: id, epoch: 0 },
            }),
            token: TOKEN,
            handlers: {
                proveStopped: () => { reached = true; return { proven: true, detail: 'empty' }; },
            } as never,
        });
        // Both: an op that answered `ok` without reaching the handler would be
        // a pass this table should not count.
        return answer.ok === true && reached;
    };

    const throughScope = (id: string): boolean => {
        try {
            parseProviderStateScope(scope({ sources: [source({ attemptId: id, runId: id })] }));
            return true;
        } catch {
            return false;
        }
    };

    it.each([
        ['one character', 'a'],
        ['the full alphabet of the grammar', 'A_Z-09'],
        ['200 characters', 'a'.repeat(200)],
        ['201 characters', 'a'.repeat(201)],
        ['empty', ''],
        ['a leading space', ' a'],
        ['a trailing space', 'a '],
        ['an inner space', 'a b'],
        ['a tab', `a${String.fromCharCode(9)}b`],
        ['a newline', `a${String.fromCharCode(10)}b`],
        ['a slash', 'a/b'],
        ['a backslash', 'a\\b'],
        ['a traversal', '../a'],
        ['a NUL', `a${String.fromCharCode(0)}b`],
        ['a control character', `a${String.fromCharCode(1)}b`],
        ['an accented letter', `a${String.fromCharCode(0xe9)}`],
        ['an arabic-indic digit', `a${String.fromCharCode(0x660)}`],
        ['a right-to-left override', `a${String.fromCharCode(0x202e)}b`],
        ['a zero-width space', `a${String.fromCharCode(0x200b)}b`],
        ['an emoji', `a${String.fromCodePoint(0x1f600)}`],
    ])('shouldAgreeWithTheIpcAbout(%s)', async (_name, id) => {
        const ipc = await throughIpc(id);
        expect(throughScope(id)).toBe(ipc);
    });

    it('shouldActuallyDistinguishTheseIds', async () => {
        // The table is only worth anything if it is not uniformly one answer.
        expect(await throughIpc('a')).toBe(true);
        expect(await throughIpc('a/b')).toBe(false);
    });
});

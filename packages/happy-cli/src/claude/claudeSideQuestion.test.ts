import { describe, expect, it, vi } from 'vitest';

import {
    ClaudeSideQuestionBridge,
    createSideQuestionRpcHandler,
    modelUsageDelta,
    SIDE_QUESTION_MAX_CHARS,
    sideQuestionRequestOf,
    type ClaudeSideQuestionChannel,
} from './claudeSideQuestion';

const MODEL = 'claude-opus-5-5';
const usageReply = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
    session: { model_usage: { [MODEL]: { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite } } },
});

function channelWith(options: {
    answer?: unknown;
    usage?: Array<unknown>;
    turnInProgress?: boolean[];
    onSideQuestion?: () => void;
    fail?: Error;
}): { channel: ClaudeSideQuestionChannel; requests: Array<Record<string, unknown>> } {
    const requests: Array<Record<string, unknown>> = [];
    const usage = [...(options.usage ?? [])];
    const progress = [...(options.turnInProgress ?? [false])];
    return {
        requests,
        channel: {
            request: async (request) => {
                requests.push(request);
                if (request.subtype === 'get_usage') {
                    const next = usage.shift();
                    if (next instanceof Error) throw next;
                    return next;
                }
                options.onSideQuestion?.();
                if (options.fail) throw options.fail;
                return options.answer ?? { response: 'PELICAN', synthetic: false };
            },
            isTurnInProgress: () => (progress.length > 1 ? progress.shift()! : progress[0]),
        },
    };
}

describe('ClaudeSideQuestionBridge', () => {
    it('shouldSendTheBuiltInSideQuestionControlRequestAndReturnTheAnswer', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        const { channel, requests } = channelWith({ usage: [usageReply(10, 5, 100, 0), usageReply(20, 9, 150, 2)] });
        bridge.provide(channel);

        const outcome = await bridge.ask('  what word?  ');

        expect(requests).toContainEqual({ subtype: 'side_question', question: 'what word?' });
        expect(outcome).toEqual({
            ok: true,
            answer: 'PELICAN',
            synthetic: false,
            usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 50, cache_creation_input_tokens: 2 },
            usageQuality: 'exact',
            model: MODEL,
        });
    });

    it('shouldReportNotRunningWhenNoLiveQueryWasProvided', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        expect(await bridge.ask('q')).toEqual({ ok: false, error: 'not-running' });

        bridge.provide(channelWith({}).channel);
        bridge.clear();
        expect(await bridge.ask('q')).toEqual({ ok: false, error: 'not-running' });
    });

    it('shouldRejectEmptyAndOverlongQuestionsBeforeTouchingClaude', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        const { channel, requests } = channelWith({});
        bridge.provide(channel);

        expect(await bridge.ask('   ')).toEqual({ ok: false, error: 'empty-question' });
        expect(await bridge.ask('x'.repeat(SIDE_QUESTION_MAX_CHARS + 1))).toEqual({ ok: false, error: 'too-long' });
        expect(requests).toEqual([]);
    });

    it('shouldAllowOnlyOneSideQuestionAtATime', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        bridge.provide({
            request: async (request) => {
                if (request.subtype === 'side_question') await gate;
                return request.subtype === 'side_question' ? { response: 'A', synthetic: false } : usageReply(0, 0, 0, 0);
            },
            isTurnInProgress: () => false,
        });

        const first = bridge.ask('one');
        await vi.waitFor(async () => expect(await bridge.ask('two')).toEqual({ ok: false, error: 'busy' }));
        release();
        expect((await first).ok).toBe(true);
        expect((await bridge.ask('three')).ok).toBe(true);
    });

    it('shouldMarkUsageEstimatedAndSubtractMainTurnUsageObservedDuringTheWindow', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        const { channel } = channelWith({
            usage: [usageReply(100, 10, 1000, 0), usageReply(400, 60, 5000, 30)],
            turnInProgress: [true],
            onSideQuestion: () => {
                // The main turn streams one message twice (partial then final) while the fork runs.
                bridge.noteMainMessage({ type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } });
                bridge.noteMainMessage({ type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 3000, cache_creation_input_tokens: 10 } } });
                bridge.noteMainMessage({ type: 'user', message: { usage: { input_tokens: 999 } } });
            },
        });
        bridge.provide(channel);

        const outcome = await bridge.ask('status?');

        expect(outcome).toMatchObject({
            ok: true,
            usageQuality: 'estimated',
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 },
        });
    });

    it('shouldNotCountMainMessagesSeenOutsideAMeasurementWindow', async () => {
        let now = 0;
        const bridge = new ClaudeSideQuestionBridge(() => now);
        bridge.noteMainMessage({ type: 'assistant', message: { id: 'before', usage: { input_tokens: 50, output_tokens: 50 } } });
        now = 60_000;
        bridge.provide(channelWith({ usage: [usageReply(0, 0, 0, 0), usageReply(10, 10, 0, 0)] }).channel);

        expect(await bridge.ask('q')).toMatchObject({ usageQuality: 'exact', usage: { input_tokens: 10, output_tokens: 10 } });
    });

    it('shouldCallUsageEstimatedRightAfterTheMainConversationMoved', async () => {
        let now = 0;
        const bridge = new ClaudeSideQuestionBridge(() => now);
        // A turn just ended: Claude's own follow-up calls (prompt suggestion) can land in the same totals.
        bridge.noteMainMessage({ type: 'result', subtype: 'success' });
        now = 3_000;
        bridge.provide(channelWith({ usage: [usageReply(0, 0, 0, 0), usageReply(10, 10, 0, 0)] }).channel);

        expect(await bridge.ask('q')).toMatchObject({ usageQuality: 'estimated', usage: { input_tokens: 10, output_tokens: 10 } });
    });

    it('shouldStillMeasureUsageWhenTheAnswerUsedUpTheQuestionTimeout', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        let usageCalls = 0;
        let afterReadSignalAborted: boolean | undefined;
        bridge.provide({
            request: async (request, { signal }) => {
                if (request.subtype === 'get_usage') {
                    if (usageCalls++ === 0) return usageReply(0, 0, 0, 0);
                    afterReadSignalAborted = signal.aborted;
                    return usageReply(5, 5, 0, 0);
                }
                // The answer arrives just after the question window closed.
                await new Promise((resolve) => setTimeout(resolve, 40));
                return { response: 'A', synthetic: false };
            },
            isTurnInProgress: () => false,
        });

        expect(await bridge.ask('q', { timeoutMs: 20 })).toMatchObject({ ok: true, usage: { input_tokens: 5, output_tokens: 5 } });
        expect(afterReadSignalAborted).toBe(false);
    });

    it('shouldStillAnswerWhenUsageCannotBeMeasured', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        bridge.provide(channelWith({ usage: [new Error('unsupported control request: get_usage')] }).channel);

        expect(await bridge.ask('q')).toMatchObject({ ok: true, answer: 'PELICAN', usage: null, usageQuality: null });
    });

    it('shouldPassThroughClaudeSyntheticNotices', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        bridge.provide(channelWith({ answer: { response: '(API error: overloaded)', synthetic: true }, usage: [null, null] }).channel);

        expect(await bridge.ask('q')).toMatchObject({ ok: true, synthetic: true, answer: '(API error: overloaded)' });
    });

    it('shouldReportFailedWithTheProviderErrorAndFreeTheSlot', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        bridge.provide(channelWith({ fail: new Error('side_question is not supported'), usage: [null] }).channel);

        expect(await bridge.ask('q')).toEqual({ ok: false, error: 'failed', detail: 'side_question is not supported' });
        expect(await bridge.ask('q')).toMatchObject({ ok: false, error: 'failed' });
    });

    it('shouldTreatAnEmptyAnswerAsAFailureRatherThanAnEmptyCard', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        bridge.provide(channelWith({ answer: { response: null, synthetic: false }, usage: [null] }).channel);

        expect(await bridge.ask('q')).toMatchObject({ ok: false, error: 'failed' });
    });

    it('shouldTimeOutAndCancelTheControlRequest', async () => {
        const bridge = new ClaudeSideQuestionBridge();
        let seenSignal: AbortSignal | undefined;
        bridge.provide({
            request: (request, { signal }) => {
                if (request.subtype !== 'side_question') return Promise.resolve(null);
                seenSignal = signal;
                return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
            },
            isTurnInProgress: () => false,
        });

        expect(await bridge.ask('slow', { timeoutMs: 20 })).toEqual({ ok: false, error: 'timeout' });
        expect(seenSignal?.aborted).toBe(true);
    });
});

describe('modelUsageDelta', () => {
    it('shouldSumIncreasesAcrossModelsAndNameTheBusiestOne', () => {
        const delta = modelUsageDelta(
            { a: { inputTokens: 1, outputTokens: 1 } },
            { a: { inputTokens: 3, outputTokens: 2 }, b: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 7 } },
        );
        expect(delta).toEqual({
            usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 },
            model: 'b',
        });
    });
});

describe('sideQuestionRequestOf', () => {
    it('shouldCallTheSdkQueryRequestAndReturnTheResponseBody', async () => {
        const query = {
            calls: [] as unknown[],
            async request(this: { calls: unknown[] }, body: unknown) {
                this.calls.push(body);
                return { subtype: 'success', request_id: 'r1', response: { response: 'ok', synthetic: false } };
            },
        };
        const request = sideQuestionRequestOf(query);
        expect(await request!({ subtype: 'side_question', question: 'q' }, { signal: new AbortController().signal }))
            .toEqual({ response: 'ok', synthetic: false });
        expect(query.calls).toEqual([{ subtype: 'side_question', question: 'q' }]);
    });

    it('shouldReturnNullWhenTheSdkNoLongerExposesRequest', () => {
        expect(sideQuestionRequestOf({})).toBeNull();
        expect(sideQuestionRequestOf(null)).toBeNull();
    });
});

describe('createSideQuestionRpcHandler', () => {
    const answered = {
        ok: true as const, answer: 'A', synthetic: false, model: MODEL, usageQuality: 'exact' as const,
        usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    };
    const deps = (overrides: Partial<Parameters<typeof createSideQuestionRpcHandler>[0]> = {}) => ({
        bridge: { ask: vi.fn(async () => answered) },
        isManagedRun: () => false,
        gate: () => undefined,
        reportUsage: vi.fn(),
        newRequestId: () => 'req-1',
        ...overrides,
    });

    it('shouldAnswerAndReportTheSideQuestionUsageOnceUnderItsOwnId', async () => {
        const d = deps();
        const reply = await createSideQuestionRpcHandler(d)({ question: 'why?' });

        expect(d.bridge.ask).toHaveBeenCalledWith('why?', { timeoutMs: undefined });
        expect(reply).toEqual({
            success: true, answer: 'A', synthetic: false, model: MODEL, usageQuality: 'exact',
            usage: { input: 3, output: 4, cacheRead: 100, cacheWrite: 5, total: 112 },
        });
        expect(d.reportUsage).toHaveBeenCalledOnce();
        expect(d.reportUsage).toHaveBeenCalledWith({ requestId: 'req-1', usage: answered.usage, model: MODEL, quality: 'exact' });
    });

    it('shouldNotReportUsageItCouldNotMeasure', async () => {
        const d = deps({ bridge: { ask: vi.fn(async () => ({ ...answered, usage: null, usageQuality: null })) } });
        expect(await createSideQuestionRpcHandler(d)({ question: 'q' })).toMatchObject({ success: true, usage: null, usageQuality: null });
        expect(d.reportUsage).not.toHaveBeenCalled();
    });

    it('shouldRefuseAManagedRunBeforeAskingClaude', async () => {
        const d = deps({ isManagedRun: () => true });
        expect(await createSideQuestionRpcHandler(d)({ question: 'q' })).toEqual({ success: false, error: 'side-question:managed-run' });
        expect(d.bridge.ask).not.toHaveBeenCalled();
    });

    it('shouldRefuseOnceTheDrainGateClosedAndRunInsideItOtherwise', async () => {
        const closed = deps({ gate: () => ({ isClosed: () => true, admit: vi.fn() }) });
        expect(await createSideQuestionRpcHandler(closed)({ question: 'q' })).toEqual({ success: false, error: 'side-question:shutting-down' });

        const kinds: Array<string | undefined> = [];
        const open = deps({ gate: () => ({ isClosed: () => false, admit: <T,>(work: () => Promise<T>, kind?: 'input' | 'writer') => { kinds.push(kind); return work(); } }) });
        expect(await createSideQuestionRpcHandler(open)({ question: 'q' })).toMatchObject({ success: true });
        // Tracked for cleanup, but not as conversation input that would hold off a drain.
        expect(kinds).toEqual(['writer']);
    });

    it('shouldTurnBridgeFailuresIntoCodedErrorsWithTheirDetail', async () => {
        const d = deps({ bridge: { ask: vi.fn(async () => ({ ok: false as const, error: 'failed' as const, detail: 'boom' })) } });
        expect(await createSideQuestionRpcHandler(d)({ question: 'q' })).toEqual({ success: false, error: 'side-question:failed: boom' });

        const notRunning = deps({ bridge: { ask: vi.fn(async () => ({ ok: false as const, error: 'not-running' as const })) } });
        expect(await createSideQuestionRpcHandler(notRunning)({ question: 'q' })).toEqual({ success: false, error: 'side-question:not-running' });
    });

    it('shouldTreatAMissingQuestionAsEmpty', async () => {
        const d = deps();
        await createSideQuestionRpcHandler(d)({});
        expect(d.bridge.ask).toHaveBeenCalledWith('', { timeoutMs: undefined });
    });
});

import { HubInputGate, TurnInputEvidence, type EvidenceBatch } from '@/api/turnInputEvidence';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, mapClaudeChannelFinalAnswer,
    startClaudeInputTurn, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';
import type { SessionEnvelope, SessionTurnEndStatus, InputEvidenceV1 } from '@slopus/happy-wire';
import type { RawJSONLines } from './types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { CLAUDE_TRANSIENT_CONTINUE_PROMPT } from './claudeTransientRetry';
import { RuntimeProducerGate } from '@/sessionDrain/runtimeProducerGate';
import { ClaudeStandaloneDrain } from './claudeStandaloneDrain';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
// Real ladder, test-sized waits. `delay` is read when a test configures it.
const ladder = vi.hoisted(() => ({ delays: [20, 20, 20, 20, 20] as number[] }));
vi.mock('./claudeTransientRetry', async (original) => {
    const actual = await original<typeof import('./claudeTransientRetry')>();
    return { ...actual, get CLAUDE_TRANSIENT_RETRY_DELAYS_MS() { return ladder.delays; } };
});

afterEach(() => {
    ladder.delays = [20, 20, 20, 20, 20];
    vi.clearAllMocks();
});

const MODE: EnhancedMode = { permissionMode: 'default', model: 'claude-sonnet-5' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Shapes the bundled CLI produced against a server answering 503 (specs/claude-transient-retry).
const apiErrorMessage = { type: 'assistant', uuid: 'api-error', session_id: 'claude-1', parent_tool_use_id: null,
    error: 'server_error', is_api_error_message: true,
    message: { id: 'synthetic', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 503 boom' }],
        usage: { input_tokens: 0, output_tokens: 0 } } };
const failedResult = (uuid: string) => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: 503, api_error: null,
    terminal_reason: 'api_error', result: 'API Error: 503 boom', total_cost_usd: 0, num_turns: 1, duration_ms: 10,
    usage: { input_tokens: 0, output_tokens: 0 }, uuid, session_id: 'claude-1' });
const answer = (id: string) => ({ type: 'assistant', uuid: `uuid-${id}`, session_id: 'claude-1', parent_tool_use_id: null,
    message: { id, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 3 } } });
const okResult = (uuid: string) => ({ type: 'result', subtype: 'success', is_error: false, result: 'hi', uuid, session_id: 'claude-1',
    total_cost_usd: 0.001, num_turns: 1, duration_ms: 10, usage: { input_tokens: 5, output_tokens: 3 } });

type Step = (prompt: string, index: number) => Promise<'fail' | 'fail-then-exit' | 'answer' | 'answer-then-fail'>;
type Options = {
    /** Queues the first input; a plain 'hello' otherwise. */
    first?: (queue: MessageQueue2<EnhancedMode>) => void;
    session?: (queue: MessageQueue2<EnhancedMode>) => Record<string, unknown>;
};

/**
 * Runs the real launcher against a scripted provider. `step` decides each turn's outcome and
 * may act on the session meanwhile; the launcher is ended with `switch` once `done` resolves.
 */
async function runLauncher(step: Step, done: (prompts: string[]) => boolean, settleMs = 0, options: Options = {}) {
    const queue = new MessageQueue2<EnhancedMode>(hashObject);
    const handlers = new Map<string, () => Promise<unknown>>();
    const agentState: Record<string, unknown> = {};
    const evidenceEvents: SessionEnvelope[] = [];
    const evidence = new TurnInputEvidence('runtime-test', event => evidenceEvents.push(event));
    const gate = new HubInputGate('happy-session-1', 'runtime-test', false);
    gate.transition('remote');
    queue.setInputValidator(input => (!input.continuation || evidence.isContinuationCurrent(input.continuation))
        && gate.check(input)?.state !== 'rejected');
    const protocol: ClaudeSessionProtocolState = { currentTurnId: null };
    const acceptEnvelopes = (envelopes: SessionEnvelope[]) => { for (const envelope of envelopes) evidenceEvents.push(evidence.stamp(envelope)); };
    const client = {
        inputEvidence: evidence,
        setInputMode: (mode: 'remote' | 'local' | 'transitioning') => { gate.transition(mode); queue.discardInvalid(); },
        startClaudeInputEvidence: (batch: EvidenceBatch) => evidence.setPending(batch),
        continueClaudeInputEvidence: (kind: InputEvidenceV1['continuation']['kind']) => {
            if (!protocol.currentTurnId) acceptEnvelopes(startClaudeInputTurn(protocol).envelopes);
            evidence.continuePending(kind);
        },
        sessionId: 'happy-session-1',
        rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
        setTransientRetryPending: vi.fn(),
        noteTransientRetryDispatched: vi.fn(),
        updateAgentState: vi.fn((update: (current: Record<string, unknown>) => Record<string, unknown>) => {
            Object.assign(agentState, update({ ...agentState }));
        }),
        updateMetadata: vi.fn(), getMetadata: () => ({}),
        setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn((body: RawJSONLines) => {
            acceptEnvelopes(mapClaudeLogMessageToSessionEnvelopes(body, protocol).envelopes);
        }), sendStreamDelta: vi.fn(),
        setPendingTurnRequestId: vi.fn((id: string | null) => { protocol.pendingRequestId = id; }),
        sendFinalAnswerForChannelTurn: vi.fn((text: string) => acceptEnvelopes(mapClaudeChannelFinalAnswer(protocol, text, true).envelopes)),
        applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn((status: SessionTurnEndStatus) => acceptEnvelopes(closeClaudeTurnWithStatus(protocol, status).envelopes)), sendSessionEvent: vi.fn(),
        failClaudeLaunchTurn: vi.fn(),
    };
    const sendSessionNotification = vi.fn();
    const prompts: string[] = [];
    let generations = 0;
    vi.mocked(query).mockImplementation(({ prompt }) => {
        generations += 1;
        const response = (async function* () {
            yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
            for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                const content = message.message.content;
                prompts.push(typeof content === 'string' ? content : JSON.stringify(content));
                const outcome = await step(prompts.at(-1)!, prompts.length - 1);
                if (outcome === 'answer-then-fail') yield answer(`partial-${prompts.length}`);
                if (outcome !== 'answer') {
                    yield apiErrorMessage;
                    yield failedResult(`result-${prompts.length}`);
                    // The provider process ends on its own while the retry waits.
                    if (outcome === 'fail-then-exit') return;
                } else {
                    yield answer(`msg-${prompts.length}`);
                    yield okResult(`result-${prompts.length}`);
                }
                if (done(prompts)) {
                    await sleep(settleMs);
                    void handlers.get('switch')!();
                    return;
                }
            }
        })();
        return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
    });
    if (options.first) options.first(queue); else queue.push('hello', MODE, undefined, undefined, undefined, undefined, { ref: { kind: 'rest', serverMessageId: 'original-input', serverSeq: 7 } });
    const session: Record<string, unknown> = {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: vi.fn(), onAbort: vi.fn(),
        sessionId: 'claude-1', path: process.cwd(), queue, client, mcpServers: {},
        api: { push: () => ({ sendSessionNotification }) },
        consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        ...options.session?.(queue),
    };
    const run = claudeRemoteLauncher(session as unknown as Session);
    return { run, queue, handlers, client, agentState, prompts, evidenceEvents, sendSessionNotification, generations: () => generations };
}

const retryStates = (client: { updateAgentState: ReturnType<typeof vi.fn> }) =>
    client.updateAgentState.mock.calls
        .map(([update]) => (update as (current: Record<string, unknown>) => Record<string, unknown>)({}))
        .filter((state) => 'transientRetry' in state)
        .map((state) => state.transientRetry as { attempt: number } | null);

describe('Claude transient API failure retry in the remote launcher (specs/claude-transient-retry)', () => {
    it('returns only human items when local switch interrupts an already-dequeued batch preparation', async () => {
        let prepared!: () => void; const reachedPreparation = new Promise<void>(resolve => { prepared = resolve; });
        let release!: () => void; const preparation = new Promise<void>(resolve => { release = resolve; });
        const harness = await runLauncher(async () => 'answer', () => false, 0, {
            first: queue => {
                queue.push('hub secret', MODE, undefined, undefined, undefined, undefined, {
                    ref: { kind: 'rest', serverMessageId: 'hub', serverSeq: 1 },
                    guard: { v: 1, targetSessionId: 'happy-session-1', expectedRuntimeId: 'runtime-test', expectedMode: 'remote', expectedModeEpoch: 1 },
                });
                queue.push('human', MODE, undefined, undefined, undefined, undefined,
                    { ref: { kind: 'rest', serverMessageId: 'human', serverSeq: 2 } });
            },
            session: () => ({ checkpointComposition: { beforeTurn: async () => { prepared(); await preparation; } } }),
        });
        await reachedPreparation;
        const switching = harness.handlers.get('switch')!();
        expect(harness.queue.size()).toBe(1);
        release(); await switching; await harness.run;
        expect(harness.prompts).toEqual([]);
        const surviving = (await harness.queue.waitForMessagesAndGetAsString())!;
        expect(surviving).toMatchObject({ message: 'human', inputCount: 1,
            inputs: [{ kind: 'rest', serverMessageId: 'human', serverSeq: 2 }] });
        expect(harness.evidenceEvents.filter(event => event.ev.t === 'turn-start')).toEqual([]);
    });
    it('keeps a batch stopped during preparation out of the queue when the user then switches', async () => {
        let prepared!: () => void; const reachedPreparation = new Promise<void>(resolve => { prepared = resolve; });
        let release!: () => void; const preparation = new Promise<void>(resolve => { release = resolve; });
        const harness = await runLauncher(async () => 'answer', () => false, 0, {
            first: queue => queue.push('stop-me', MODE, undefined, undefined, undefined, undefined,
                { ref: { kind: 'rest', serverMessageId: 'stop-me', serverSeq: 1 } }),
            session: () => ({ checkpointComposition: { beforeTurn: async () => { prepared(); await preparation; } } }),
        });
        await reachedPreparation;
        const stopping = harness.handlers.get('abort')!();
        release(); await stopping;
        expect(harness.queue.size()).toBe(0);
        // Local mode reads what the switch hands back: a stopped prompt must not be among it.
        const switching = harness.handlers.get('switch')!();
        expect(harness.queue.size()).toBe(0);
        await switching; await harness.run;
        expect(harness.prompts).toEqual([]);
    });
    it('asks the same conversation again after a 503 that produced nothing, without resending the request', async () => {
        const harness = await runLauncher(async (_prompt, index) => index < 2 ? 'fail' : 'answer', (prompts) => prompts.length === 3);
        await harness.run;

        expect(harness.prompts).toEqual(['hello', CLAUDE_TRANSIENT_CONTINUE_PROMPT, CLAUDE_TRANSIENT_CONTINUE_PROMPT]);
        const ends = harness.evidenceEvents.filter(event => event.ev.t === 'turn-end');
        expect(ends).toHaveLength(3);
        for (const end of ends) expect(end.ev).toMatchObject({ inputEvidence: { inputCount: 1,
            inputs: [{ kind: 'rest', serverMessageId: 'original-input', serverSeq: 7 }] } });
        expect(ends[0].ev).toMatchObject({ inputEvidence: { terminal: false, continuation: { state: 'pending', kind: 'claude-transient' } } });
        expect(ends[2].ev).toMatchObject({ inputEvidence: { terminal: true, continuation: { state: 'completed' } } });
        // Same provider process and conversation: a retry is not a restart.
        expect(harness.generations()).toBe(1);
        expect(retryStates(harness.client)).toEqual([
            expect.objectContaining({ provider: 'claude', attempt: 1, maxAttempts: 5, reason: 'server_error', status: 503 }),
            null,
            expect.objectContaining({ attempt: 2 }),
            null,
        ]);
        // A scheduled run's failed turn waits for the retry (specs/_archive/automation-result-delivery).
        expect(harness.client.setTransientRetryPending.mock.calls).toEqual([[true], [false], [true], [false]]);
        expect(harness.client.noteTransientRetryDispatched).toHaveBeenCalledTimes(2);
        expect(harness.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message', message: expect.stringContaining('retrying automatically'),
        });
        // A failed attempt with a retry waiting is not "done"; only the answered turn notifies.
        expect(harness.sendSessionNotification).toHaveBeenCalledTimes(1);
        // Cost: the failed attempts carry zero usage and the answer is reported once with its own.
        expect(harness.client.applyClaudeTurnResult.mock.calls.map(([result]) => (result as { usage: unknown }).usage)).toEqual([
            { input_tokens: 0, output_tokens: 0 }, { input_tokens: 0, output_tokens: 0 }, { input_tokens: 5, output_tokens: 3 },
        ]);
    });

    it('lets a message the user sends during the wait replace the retry', async () => {
        ladder.delays = [5_000];
        let queueRef: MessageQueue2<EnhancedMode> | null = null;
        const harness = await runLauncher(async (_prompt, index) => {
            if (index === 0) {
                setTimeout(() => queueRef!.push('actually, do this instead', MODE), 30);
                return 'fail';
            }
            return 'answer';
        }, (prompts) => prompts.length === 2);
        queueRef = harness.queue;
        await harness.run;

        expect(harness.prompts).toEqual(['hello', 'actually, do this instead']);
        expect(retryStates(harness.client)).toEqual([expect.objectContaining({ attempt: 1 }), null]);
    });

    it('sends only the user message when it is queued as the retry falls due', async () => {
        // Barrier: the retry is due immediately and the user message is already waiting.
        ladder.delays = [0];
        let queueRef: MessageQueue2<EnhancedMode> | null = null;
        const harness = await runLauncher(async (_prompt, index) => {
            if (index === 0) {
                queueRef!.push('queued while failing', MODE);
                return 'fail';
            }
            // Room for a stray retry to arrive before the launcher is ended.
            await sleep(50);
            return 'answer';
        }, (prompts) => prompts.length === 2);
        queueRef = harness.queue;
        await harness.run;

        expect(harness.prompts).toEqual(['hello', 'queued while failing']);
        // Input was already waiting at the turn end: nothing is announced for it to replace.
        expect(retryStates(harness.client)).toEqual([]);
        expect(harness.client.sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message', message: expect.stringContaining('retrying automatically'),
        });
    });

    it('drops a waiting retry when the user stops the session', async () => {
        ladder.delays = [100];
        const harness = await runLauncher(async () => 'fail', () => false);
        await vi.waitFor(() => expect(retryStates(harness.client)).toHaveLength(1));
        await harness.handlers.get('abort')!();
        await sleep(200);
        await harness.handlers.get('switch')!();
        await harness.run;

        expect(harness.prompts).toEqual(['hello']);
        expect(retryStates(harness.client).at(-1)).toBeNull();
        // Only the wait was running: the idle provider is kept, and no turn is reported cancelled.
        expect(harness.generations()).toBe(1);
        expect(harness.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('cancelled');
        expect(harness.client.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'message', message: 'Aborted by user' });
    });

    it('ends a standalone drain that stops input while a retry waits, without retrying', async () => {
        ladder.delays = [5_000];
        let gate!: RuntimeProducerGate;
        let waits = 0;
        const harness = await runLauncher(async (_prompt, index) => {
            // The daemon drains the runtime during the wait.
            if (index === 0) setTimeout(() => gate.freeze(), 30);
            return 'fail';
        }, () => false, 0, {
            session: (queue) => {
                let drain!: ClaudeStandaloneDrain;
                gate = new RuntimeProducerGate({
                    hasUndeliveredInput: () => queue.size() > 0,
                    canFreezeInbound: () => true,
                    freezeInbound: () => true,
                    stopLoop: () => { drain.providerDeps().requestEndInput(); },
                });
                drain = new ClaudeStandaloneDrain(gate);
                const wait = queue.waitForMessagesAndGetAsString.bind(queue);
                // Safety valve: a spin on the closed queue starves every timer, this test's included.
                queue.waitForMessagesAndGetAsString = (signal, claim) => {
                    if (++waits > 50) throw new Error('wait loop spins on the closed queue');
                    return wait(signal, claim);
                };
                return { standaloneDrain: drain };
            },
        });

        await expect(harness.run).resolves.toBe('exit');
        expect(waits).toBeLessThan(10);
        expect(harness.prompts).toEqual(['hello']);
        expect(retryStates(harness.client).at(-1)).toBeNull();
    });

    it('keeps a waiting retry across a provider that exits on its own, and runs it in the next one', async () => {
        const harness = await runLauncher(async (_prompt, index) => index === 0 ? 'fail-then-exit' : 'answer',
            (prompts) => prompts.length === 2);
        await harness.run;

        expect(harness.prompts).toEqual(['hello', CLAUDE_TRANSIENT_CONTINUE_PROMPT]);
        expect(harness.generations()).toBe(2);
    });

    it('does not retry a channel request', async () => {
        const harness = await runLauncher(async () => 'fail', (prompts) => prompts.length === 1, 100, {
            first: (queue) => queue.pushIsolated('from slack', MODE, undefined, undefined, 'channel-req-1'),
            // The session admits the channel request, as runClaude does.
            session: () => ({ prepareChannelExecution: async () => true, beginChannelExecution: () => true }),
        });
        await harness.run;

        expect(harness.prompts).toEqual(['from slack']);
        expect(retryStates(harness.client)).toEqual([]);
    });

    it('does not retry a slash command', async () => {
        const harness = await runLauncher(async () => 'fail', (prompts) => prompts.length === 1, 100, {
            first: (queue) => queue.push('/compact', MODE),
        });
        await harness.run;

        expect(harness.prompts).toEqual(['/compact']);
        expect(retryStates(harness.client)).toEqual([]);
    });

    it('does not retry a run-once turn', async () => {
        const harness = await runLauncher(async () => 'fail', () => false, 0, {
            session: () => ({ exitAfterFirstTurn: true }),
        });

        await expect(harness.run).resolves.toBe('exit');
        expect(harness.prompts).toEqual(['hello']);
        expect(retryStates(harness.client)).toEqual([]);
    });

    it('does not retry a turn that already answered before the API failed', async () => {
        const harness = await runLauncher(async () => 'answer-then-fail', (prompts) => prompts.length === 1, 100);
        await harness.run;

        expect(harness.prompts).toEqual(['hello']);
        expect(retryStates(harness.client)).toEqual([]);
    });
});

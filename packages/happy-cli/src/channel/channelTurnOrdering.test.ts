import { describe, expect, it, vi } from 'vitest';
import { OutgoingMessageQueue } from '@/claude/utils/OutgoingMessageQueue';
import { SDKToLogConverter } from '@/claude/utils/sdkToLogConverter';
import { withContextUsageSignals } from '@/claude/claudeContextUsage';
import { TurnInputEvidence, type EvidenceBatch } from '@/api/turnInputEvidence';
import {
    closeClaudeTurnWithStatus,
    mapClaudeChannelFinalAnswer,
    mapClaudeLogMessageToSessionEnvelopes,
    mapClaudeStructuredOutput,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import type { SessionEnvelope, SessionTurnEndStatus } from '@slopus/happy-wire';
import {
    createOrderedTurnDispatcher,
    finalAnswerItem,
    pendingRequestItem,
    turnEndItem,
    permissionBindingItem,
    structuredOutputItem,
} from './channelTurnOrdering';
import { installChannelPermissionWiring } from './channelPermissionWiring';

/**
 * Drives the **real** dispatcher the launcher installs, against the **real** mapper, so the
 * ordering under test is the production one.
 *
 * The race this exists for cannot be seen from the mapper alone: by the time the mapper runs, the
 * queue has already decided the order. The launcher calls `onMessage(assistant)`,
 * `onMessage(result)` and `onReady()` in quick succession while the queue is still draining, and
 * the question is whether the envelopes come out as `turn-start → text → final-answer → turn-end`
 * under one request id.
 */
function harness(witnessed = false) {
    const envelopes: SessionEnvelope[] = [];
    const evidence = new TurnInputEvidence('host', envelope => envelopes.push(envelope));
    const append = (batch: SessionEnvelope[]) => envelopes.push(...batch.map(envelope => witnessed ? evidence.stamp(envelope) : envelope));
    const rearm = vi.fn((ids: string[]) => evidence.rearmBackground(ids));
    const state: ClaudeSessionProtocolState = { currentTurnId: null,
        ...(witnessed ? { onBackgroundInputLaunch: (id: string, turn: string) => evidence.rememberBackground(id, turn),
            onBackgroundInputRearm: rearm } : {}) };
    const bindings: {
        permissionId: string; toolName: string; instanceSeq: number;
        turnId: string | null; requestId: string | null;
    }[] = [];
    const target = {
        setPendingInputEvidence: (batch: EvidenceBatch) => evidence.setPending(batch),
        setPendingTurnRequestId: (requestId: string | null) => { state.pendingRequestId = requestId; },
        sendFinalAnswerForChannelTurn: (text: string) => {
            append(mapClaudeChannelFinalAnswer(state, text).envelopes);
        },
        sendStructuredOutput: (envelope: Parameters<typeof mapClaudeStructuredOutput>[1]) => {
            append(mapClaudeStructuredOutput(state, envelope).envelopes);
        },
        closeClaudeSessionTurn: (status: SessionTurnEndStatus) => {
            append(closeClaudeTurnWithStatus(state, status).envelopes);
        },
        sendClaudeSessionMessage: (logMessage: unknown) => {
            const mapped = mapClaudeLogMessageToSessionEnvelopes(logMessage as never, state);
            state.currentTurnId = mapped.currentTurnId;
            append(mapped.envelopes);
        },
        // Records the turn the binding was applied against, which is the whole question.
        bindChannelPermission: (permissionId: string, toolName: string, instanceSeq: number) => {
            bindings.push({
                permissionId,
                toolName,
                instanceSeq,
                turnId: state.currentTurnId,
                requestId: state.currentRequestId ?? null,
            });
        },
    };
    const queue = new OutgoingMessageQueue(withContextUsageSignals(createOrderedTurnDispatcher(target), () => {}));
    return { queue, envelopes, state, bindings, evidence, rearm };
}

const assistant = (text: string, uuid = 'a-1') => ({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text }] },
    timestamp: '2025-01-01T00:00:00.000Z',
});

function shape(envelopes: SessionEnvelope[]) {
    return envelopes.map((envelope) => (envelope.ev as { t: string }).t);
}

function requestIds(envelopes: SessionEnvelope[]) {
    return envelopes
        .map((envelope) => (envelope.ev as { requestId?: string }).requestId)
        .filter((id): id is string => typeof id === 'string');
}

describe('channel turn ordering through the launcher dispatcher', () => {
    it.each([false, true].flatMap(evicted => ['active', 'pending', 'idle'].map(phase => ({ evicted, phase }))))(
        'T2RT-02/03 delivers SDK notification before B ends (evicted=$evicted, phase=$phase)', async ({ evicted, phase }) => {
            const h = harness(true);
            const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
            const sdk = (message: Parameters<typeof converter.convert>[0], delay?: number) => {
                const log = converter.convert(message);
                expect(log).not.toBeNull(); h.queue.enqueue(log, { delay });
            };
            const batch = (id: string) => pendingRequestItem(null, {
                inputs: [{ kind: 'rest', serverMessageId: id, serverSeq: 1 }], inputCount: 1,
            });
            const text = (value: string) => ({ type: 'assistant' as const, parent_tool_use_id: null,
                message: { role: 'assistant', content: [{ type: 'text', text: value }] } } as Parameters<typeof converter.convert>[0]);
            try {
                h.queue.enqueue(batch('A'));
                sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                    { type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
                ] } } as Parameters<typeof converter.convert>[0], 250);
                sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'launch', content: 'Command running in background with ID: long-job.' },
                ] } });
                h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
                const original = h.evidence.snapshot()!;
                if (evicted) {
                    for (let i = 0; i < 128; i++) {
                        h.queue.enqueue(batch(`other-${i}`)); sdk(text(`other-${i}`)); h.queue.enqueue(turnEndItem('completed'));
                    }
                    await h.queue.flush(); expect(h.evidence.snapshot(original.turnId)).toBeNull();
                }
                if (phase !== 'idle') h.queue.enqueue(batch('B'));
                if (phase === 'active') sdk(text('B begins'), 250);
                sdk({ type: 'system', subtype: 'task_notification', task_id: 'long-job', tool_use_id: 'launch',
                    status: 'completed', session_id: 'sdk-session', uuid: '00000000-0000-4000-8000-000000000001',
                    output_file: '/tmp/long-job.output', summary: 'Background task completed' });
                // Unrelated system messages must remain filtered.
                sdk({ type: 'system', subtype: 'init', session_id: 'sdk-session' } as Parameters<typeof converter.convert>[0]);
                if (phase === 'idle') h.queue.enqueue(batch('B'));
                sdk(text('B finishes')); h.queue.enqueue(finalAnswerItem('B finishes')); h.queue.enqueue(turnEndItem('completed'));
                await h.queue.flush(); // The scanner has not run; B's durable terminal must already be safe.
                const terminal = h.envelopes.filter(envelope => envelope.ev.t === 'turn-end').at(-1)!;
                expect(terminal.ev).toMatchObject({ inputEvidence: { inputs: [{ kind: 'rest', serverMessageId: 'B', serverSeq: 1 }],
                    terminal: true, coverage: 'incomplete', incompleteReasons: expect.arrayContaining([
                        evicted ? 'background-source-unavailable' : 'background-co-consumption',
                    ]) } });
                expect(h.rearm).toHaveBeenCalledOnce();
                const receiptIndex = h.envelopes.findIndex(envelope => envelope.id.startsWith('task-notification:long-job:receipt'));
                expect(receiptIndex).toBeGreaterThan(-1);
                expect(receiptIndex).toBeLessThan(h.envelopes.indexOf(terminal));
            } finally { h.queue.destroy(); }
        },
    );

    it('emits start, text, final answer and terminal in order under one request id', async () => {
        const { queue, envelopes } = harness();

        // Exactly the launcher's sequence, all before the queue drains.
        queue.enqueue(pendingRequestItem('core-req-1'));
        queue.enqueue(assistant('the answer'));
        queue.enqueue(finalAnswerItem('the answer'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'final-answer', 'turn-end']);
        expect(new Set(requestIds(envelopes))).toEqual(new Set(['core-req-1']));
    });

    it('does not let the terminal close a turn before its transcript arrives', async () => {
        // The failure this replaces: the terminal ran synchronously, closing an empty correlated
        // turn, and the queued assistant log then opened a second, uncorrelated one.
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-req-1'));
        queue.enqueue(assistant('the answer'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'turn-end']);
        // One turn, not two.
        expect(new Set(envelopes.map((envelope) => envelope.turn)).size).toBe(1);
    });

    it('keeps back-to-back requests on their own turns and ids', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-req-A'));
        queue.enqueue(assistant('answer A', 'a-1'));
        queue.enqueue(finalAnswerItem('answer A'));
        queue.enqueue(turnEndItem('completed'));
        // B is consumed while A's output is still queued — the id must not overwrite A's.
        queue.enqueue(pendingRequestItem('core-req-B'));
        queue.enqueue(assistant('answer B', 'a-2'));
        queue.enqueue(finalAnswerItem('answer B'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual([
            'turn-start', 'text', 'final-answer', 'turn-end',
            'turn-start', 'text', 'final-answer', 'turn-end',
        ]);
        expect(requestIds(envelopes)).toEqual([
            'core-req-A', 'core-req-A', 'core-req-A',
            'core-req-B', 'core-req-B', 'core-req-B',
        ]);
        const turns = envelopes.map((envelope) => envelope.turn);
        expect(turns[0]).not.toBe(turns[4]);
    });

    it('ends a failed run as failed, with no final answer', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-req-1'));
        queue.enqueue(assistant('partial work'));
        // A failed SDK result enqueues no candidate, and the terminal says so.
        queue.enqueue(turnEndItem('failed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'turn-end']);
        expect(envelopes.at(-1)?.ev).toMatchObject({ status: 'failed', requestId: 'core-req-1' });
    });

    it('answers a run that produced no transcript at all', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-req-1'));
        queue.enqueue(turnEndItem('failed'));
        await queue.flush();

        // The terminal opens and closes a correlated turn rather than stranding the request.
        expect(shape(envelopes)).toEqual(['turn-start', 'turn-end']);
        expect(requestIds(envelopes)).toEqual(['core-req-1', 'core-req-1']);
    });

    it('preserves an authoritative successful result when no transcript opened the turn', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem('core-result-only'));
        queue.enqueue(finalAnswerItem('finished without a transcript'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'final-answer', 'turn-end']);
        expect(requestIds(envelopes)).toEqual([
            'core-result-only', 'core-result-only', 'core-result-only',
        ]);
        expect(envelopes[1].ev).toMatchObject({ text: 'finished without a transcript' });
    });

    it('publishes an ordinary final without a channel handle and keeps an empty channel result separate', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(finalAnswerItem('ordinary result'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();
        expect(shape(envelopes)).toEqual(['turn-start', 'final-answer', 'turn-end']);
        expect(requestIds(envelopes)).toEqual([]);
        envelopes.length = 0;
        queue.enqueue(pendingRequestItem('core-empty'));
        queue.enqueue(finalAnswerItem('   '));
        await queue.flush();
        expect(envelopes).toEqual([]);
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();
        expect(shape(envelopes)).toEqual(['turn-start', 'turn-end']);
        expect(requestIds(envelopes)).toEqual(['core-empty', 'core-empty']);
    });

    it('leaves an ordinary in-app turn uncorrelated', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(pendingRequestItem(null));
        queue.enqueue(assistant('an answer for the person at the keyboard'));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(requestIds(envelopes)).toEqual([]);
    });
});

describe('permission binding lands on the turn that raised the prompt', () => {
    /** The launcher's real shape: the tool-call message is delayed and released by the prompt. */
    function raiseToolCallPrompt(h: ReturnType<typeof harness>, toolCallId: string) {
        h.queue.enqueue(assistant('working on it', 'a-tool'), {
            delay: 250,
            toolCallIds: [toolCallId],
        });
    }

    it('is applied after the delayed tool-call message, so the turn is already open', async () => {
        const h = harness();
        h.queue.enqueue(pendingRequestItem('req-1'));
        raiseToolCallPrompt(h, 'tool-1');

        // Exactly what `installChannelPermissionWiring` does when the prompt fires.
        let onRequest: ((id: string, tool: string, seq: number) => void) | undefined;
        installChannelPermissionWiring({
            queue: h.queue,
            handler: {
                setOnPermissionRequest: (cb) => { onRequest = cb; },
                setChannelObservationPublisher: () => { },
                bindChannelPermission: () => { },
            },
            turnContextFor: () => { /* membership never resolves in this fixture */ },
            publish: () => { },
        });
        onRequest!('tool-1', 'Bash', 7);
        await h.queue.flush();

        expect(h.bindings).toHaveLength(1);
        // The turn exists, and it is the one the request opened.
        expect(h.bindings[0]?.turnId).toBe(h.state.currentTurnId);
        expect(h.bindings[0]?.turnId).not.toBeNull();
        expect(h.bindings[0]?.requestId).toBe('req-1');
        expect(h.bindings[0]?.toolName).toBe('Bash');
        expect(h.bindings[0]?.instanceSeq).toBe(7);
    });

    it('is held behind the unreleased tool-call message rather than applied early', async () => {
        // `processQueueInternal` stops at the first unreleased item, so nothing behind the delayed
        // message can be applied. That is what keeps the binding from seeing an unopened turn.
        const h = harness();
        h.queue.enqueue(pendingRequestItem('req-1'));
        raiseToolCallPrompt(h, 'tool-1');
        h.queue.enqueue(permissionBindingItem('tool-1', 'Bash', 1));
        // No release: the delayed message is still held, so only the binding can be applied.
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(h.bindings.map((binding) => binding.turnId)).toEqual([]);
    });

    it('keeps the four markers in enqueue order', async () => {
        const h = harness();
        h.queue.enqueue(pendingRequestItem('req-1'));
        h.queue.enqueue(assistant('hello'));
        h.queue.enqueue(permissionBindingItem('tool-1', 'Bash', 1));
        h.queue.enqueue(finalAnswerItem('done'));
        h.queue.enqueue(turnEndItem('completed'));
        await h.queue.flush();

        expect(h.bindings).toHaveLength(1);
        expect(shape(h.envelopes)).toEqual(['turn-start', 'text', 'final-answer', 'turn-end']);
    });
});

// Saycode specs/claude-cli-benchmark-followups R2.
describe('structured output lands inside the turn it judges', () => {
    it('emits the verdict after the turn text and before its terminal', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(assistant('{"answer":"ok"}'));
        queue.enqueue(structuredOutputItem({ v: 1, status: 'ok', value: { answer: 'ok' } }));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'structured-output', 'turn-end']);
        expect(new Set(envelopes.map((envelope) => envelope.turn)).size).toBe(1);
        expect(envelopes[2].ev).toEqual({ t: 'structured-output', v: 1, status: 'ok', value: { answer: 'ok' } });
    });

    it('still reports a missing value for a turn that produced no text', async () => {
        // A turn that failed before any output must not end with silence: the reader would
        // otherwise take "no event" for "this session never asked for one".
        const { queue, envelopes } = harness();
        queue.enqueue(structuredOutputItem({ v: 1, status: 'missing', reason: 'turn_failed' }));
        queue.enqueue(turnEndItem('failed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'structured-output', 'turn-end']);
        expect(envelopes[1].ev).toEqual({ t: 'structured-output', v: 1, status: 'missing', reason: 'turn_failed' });
    });

    it('fills in a missing verdict for a turn that closes without one, so a cancelled turn never reads as success', async () => {
        // Abort and launch-failure paths close the turn without an SDK result to judge.
        const { queue, envelopes, state } = harness();
        state.structuredOutputVerdicts = true;
        queue.enqueue(assistant('working on it'));
        queue.enqueue(turnEndItem('cancelled'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'structured-output', 'turn-end']);
        expect(envelopes[2].ev).toEqual({ t: 'structured-output', v: 1, status: 'missing', reason: 'turn_cancelled' });
        expect(new Set(envelopes.map((envelope) => envelope.turn)).size).toBe(1);
    });

    it('does not add a second verdict to a turn that already has one', async () => {
        const { queue, envelopes, state } = harness();
        state.structuredOutputVerdicts = true;
        queue.enqueue(assistant('{"answer":"ok"}'));
        queue.enqueue(structuredOutputItem({ v: 1, status: 'ok', value: { answer: 'ok' } }));
        queue.enqueue(turnEndItem('completed'));
        await queue.flush();

        expect(shape(envelopes)).toEqual(['turn-start', 'text', 'structured-output', 'turn-end']);
    });
});

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import { getProjectPath } from '@/claude/utils/path';
import { OutgoingMessageQueue } from '@/claude/utils/OutgoingMessageQueue';
import { SDKToLogConverter } from '@/claude/utils/sdkToLogConverter';
import { withContextUsageSignals } from '@/claude/claudeContextUsage';
import { TurnInputEvidence, type EvidenceBatch } from '@/api/turnInputEvidence';
import {
    closeClaudeTurnWithStatus,
    mapClaudeChannelFinalAnswer,
    mapClaudeLogMessageToSessionEnvelopes,
    mapClaudeStructuredOutput,
    observeClaudeBackgroundInput,
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
    const rearm = vi.fn((ids: string[], reasons?: string[], nextTurn?: boolean) => evidence.rearmBackground(ids, reasons, nextTurn));
    const state: ClaudeSessionProtocolState = { currentTurnId: null,
        ...(witnessed ? { onBackgroundInputLaunch: (id: string, turn: string) => evidence.rememberBackground(id, turn),
            onBackgroundInputRearm: rearm } : {}) };
    const bindings: {
        permissionId: string; toolName: string; instanceSeq: number;
        turnId: string | null; requestId: string | null;
    }[] = [];
    const target = {
        observeClaudeBackgroundInput: (message: Parameters<typeof observeClaudeBackgroundInput>[0]) => observeClaudeBackgroundInput(message, state),
        setPendingInputEvidence: (batch: EvidenceBatch) => evidence.setPending(batch),
        setPendingTurnRequestId: (requestId: string | null) => { state.pendingRequestId = requestId; },
        sendFinalAnswerForChannelTurn: (text: string) => {
            append(mapClaudeChannelFinalAnswer(state, text, witnessed).envelopes);
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
    return { queue, envelopes, state, bindings, evidence, rearm, sendScannerMessage: target.sendClaudeSessionMessage };
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
                expect(h.envelopes.some(envelope => envelope.id.startsWith('task-notification:long-job:receipt'))).toBe(false);
            } finally { h.queue.destroy(); }
        },
    );

    it.each([
        { sdkRunId: undefined, scannerRunId: undefined },
        { sdkRunId: 'run-1', scannerRunId: 'run-1' },
        { sdkRunId: 'run-1', scannerRunId: undefined },
        { sdkRunId: undefined, scannerRunId: 'run-1' },
    ].flatMap(identity => ['follow-up', 'idle', 'unrelated'].flatMap(phase =>
        ['sdk', 'scanner'].map(first => ({ ...identity, phase, first })))))(
        'T2RT-07 retains evidence ordering without changing main routing (sdk=$sdkRunId, scanner=$scannerRunId, late=$phase, first=$first)',
        async ({ sdkRunId, scannerRunId, phase, first }) => {
            const h = harness(true);
            const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
            const sdk = (message: Parameters<typeof converter.convert>[0]) => {
                const log = converter.convert(message);
                expect(log).not.toBeNull(); h.queue.enqueue(log);
            };
            const text = (value: string) => sdk({ type: 'assistant', parent_tool_use_id: null,
                message: { role: 'assistant', content: [{ type: 'text', text: value }] } } as Parameters<typeof converter.convert>[0]);
            const batch = (id: string) => pendingRequestItem(`channel-${id}`, {
                inputs: [{ kind: 'channel', channelRequestId: `channel-${id}` }], inputCount: 1,
            });
            const finish = (value: string) => {
                text(value); h.queue.enqueue(finalAnswerItem(value)); h.queue.enqueue(turnEndItem('completed'));
            };
            const details = '<task-notification><task-id>long-job</task-id><tool-use-id>launch</tool-use-id>'
                + '<status>completed</status><summary>Full scanner result</summary></task-notification>';
            // runClaude's scanner sends directly to the session mapper, independently of the SDK queue.
            const scanner = () => h.sendScannerMessage({ type: 'user', uuid: 'scanner-detail',
                origin: { kind: 'task-notification', producer: 'session-task', ...(scannerRunId ? { runId: scannerRunId } : {}) },
                message: { role: 'user', content: details } });
            try {
                h.queue.enqueue(batch('A'));
                sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                    { type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
                ] } } as Parameters<typeof converter.convert>[0]);
                sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'launch', content: 'Command running in background with ID: long-job.' },
                ] } });
                h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
                const original = h.evidence.snapshot()!;
                const receipt = (runId = sdkRunId) => sdk({ type: 'system', subtype: 'task_notification',
                    task_id: 'long-job', tool_use_id: 'launch', status: 'completed',
                    ...(runId ? { run_id: runId } : {}), session_id: 'sdk-session',
                    uuid: '00000000-0000-4000-8000-000000000007', output_file: '/tmp/long-job.output', summary: 'Done' });
                const duplicate = first === 'sdk' ? scanner : () => receipt();
                if (first === 'sdk') receipt(); else scanner();
                text('F begins'); await h.queue.flush();
                if (phase === 'follow-up') duplicate();
                finish('F actual final'); await h.queue.flush();
                if (phase === 'idle') duplicate();
                h.queue.enqueue(batch('B')); text('B begins'); await h.queue.flush();
                if (phase === 'unrelated') duplicate();
                finish('B actual final'); await h.queue.flush();

                // SDK observation is not consumption. The scanner retains main's closure behavior;
                // only evidence proof, never correlation or request-map consumption, is asserted here.
                const ambiguous = !sdkRunId || !scannerRunId;
                const fIncomplete = first === 'sdk' || (ambiguous && phase === 'follow-up');
                const bIncomplete = phase !== 'follow-up' && (first === 'sdk' || ambiguous);
                const finalF = h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'F actual final')!;
                const finalB = h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === 'B actual final')!;
                const evidenceF = h.evidence.snapshot(finalF.turn)!;
                const evidenceB = h.evidence.snapshot(finalB.turn)!;
                expect.soft(evidenceF).toMatchObject({ coverage: fIncomplete ? 'incomplete' : 'complete', terminal: true });
                expect.soft(evidenceB).toMatchObject({ coverage: bIncomplete ? 'incomplete' : 'complete', terminal: true });
                if (fIncomplete) expect.soft(evidenceF.incompleteReasons.some(reason => reason.startsWith('background-'))).toBe(true);
                if (bIncomplete) expect.soft(evidenceB.incompleteReasons.some(reason => reason.startsWith('background-'))).toBe(true);
                if (first === 'scanner') {
                    expect.soft(evidenceF.rootBatchId).toBe(original.rootBatchId);
                    expect.soft(evidenceB.inputs).toEqual([{ kind: 'channel', channelRequestId: 'channel-B' }]);
                }
                expect.soft(evidenceB.rootBatchId).not.toBe(original.rootBatchId);
                expect.soft(h.envelopes).toContainEqual(expect.objectContaining({ id: 'task-notification:long-job',
                    ev: { t: 'text', text: details } }));
                expect.soft(h.envelopes.some(envelope => envelope.id.startsWith('task-notification:long-job:receipt'))).toBe(false);
                // A resumed run is new input, including after both old receipts lacked run IDs.
                receipt('run-2'); text('Resumed task'); await h.queue.flush();
                expect(h.evidence.snapshot()).toMatchObject({ coverage: 'incomplete',
                    incompleteReasons: expect.arrayContaining(['background-source-unavailable']) });
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
        const { queue, envelopes } = harness(true);
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

/** Main's routing is deliberately independent of the extra evidence observations. */
describe('merge-base background routing with additive evidence', () => {
    const notification = (task = 'job', run = 'run-1', tool = 'launch') => ({
        type: 'user', origin: { kind: 'task-notification', runId: run },
        message: { role: 'user', content: `<task-notification><task-id>${task}</task-id><tool-use-id>${tool}</tool-use-id><status>completed</status></task-notification>` },
    });
    function driver(witnessed = true) {
        const h = harness(witnessed);
        const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
        const sdk = (message: unknown) => h.queue.enqueue(converter.convert(message as Parameters<typeof converter.convert>[0]));
        const start = (run: string, tool = 'launch') => sdk({ type: 'system', subtype: 'task_started', task_id: 'job', run_id: run, tool_use_id: tool });
        const receipt = (run = 'run-1') => sdk({ type: 'system', subtype: 'task_notification', task_id: 'job', run_id: run, tool_use_id: 'launch', status: 'completed' });
        const launch = async (channel: string, run?: string, tool = 'launch') => {
            h.queue.enqueue(pendingRequestItem(channel, { inputs: [{ kind: 'channel', channelRequestId: channel }], inputCount: 1 }));
            sdk({ type: 'assistant', message: { content: [{ type: 'tool_use', id: tool, name: 'Agent', input: { prompt: 'Work', resume: 'job', run_in_background: true } }] } });
            if (run) start(run, tool);
            sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'agentId: job' }] } });
            h.queue.enqueue(turnEndItem('completed')); await h.queue.flush();
        };
        const finish = async (text = 'follow-up') => {
            h.queue.enqueue(assistant(text)); h.queue.enqueue(finalAnswerItem(text)); h.queue.enqueue(turnEndItem('completed'));
            await h.queue.flush();
            return h.envelopes.find(e => e.ev.t === 'final-answer' && e.ev.text === text)!;
        };
        return { h, sdk, start, receipt, launch, finish };
    }

    it.each(['idle', 'active', 'pending'])('SDK observation leaves main routing and request maps unchanged while %s', async phase => {
        const d = driver();
        try {
            await d.launch('channel-A', 'run-1');
            if (phase !== 'idle') d.h.queue.enqueue(pendingRequestItem('channel-B', { inputs: [{ kind: 'channel', channelRequestId: 'channel-B' }], inputCount: 1 }));
            if (phase === 'active') d.h.queue.enqueue(assistant('B starts'));
            await d.h.queue.flush();
            const before = { turn: d.h.state.currentTurnId, pending: d.h.state.pendingRequestId, current: d.h.state.currentRequestId,
                requests: [...d.h.state.backgroundTaskRequestIds!] };
            d.receipt(); await d.h.queue.flush();
            expect({ turn: d.h.state.currentTurnId, pending: d.h.state.pendingRequestId, current: d.h.state.currentRequestId,
                requests: [...d.h.state.backgroundTaskRequestIds!] }).toEqual(before);
            const answer = await d.finish();
            expect(answer.ev).toMatchObject({ inputEvidence: { coverage: 'incomplete', incompleteReasons: expect.arrayContaining(['background-consumption-unproven']) } });
            expect((answer.ev as { requestId?: string }).requestId).toBe(phase === 'idle' ? undefined : 'channel-B');
        } finally { d.h.queue.destroy(); }
    });

    it.each([false, true])('scanner consumption retains main routing (SDK receipt first=%s)', async sdkFirst => {
        const d = driver();
        try {
            await d.launch('channel-A', 'run-1');
            const root = d.h.evidence.snapshot()!.rootBatchId;
            if (sdkFirst) { d.receipt(); await d.h.queue.flush(); }
            d.h.sendScannerMessage(notification());
            const answer = await d.finish();
            expect(answer.ev).toMatchObject({ requestId: 'channel-A', inputEvidence: { coverage: sdkFirst ? 'incomplete' : 'complete' } });
            if (!sdkFirst) expect(answer.ev).toMatchObject({ inputEvidence: { rootBatchId: root } });
        } finally { d.h.queue.destroy(); }
    });

    it.each([false, true])('documents main restart reset risk with evidence=%s (T2RT-14 class)', async witnessed => {
        const old = driver(witnessed);
        await old.launch('channel-A', 'run-1'); old.h.queue.destroy();
        const fresh = driver(witnessed);
        try {
            await fresh.launch('channel-B', 'run-2', 'new-tool');
            fresh.h.sendScannerMessage(notification('job', 'run-1', 'old-tool'));
            const answer = await fresh.finish();
            expect(answer.ev).toMatchObject({ requestId: 'channel-B' });
            if (witnessed) expect(answer.ev).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                incompleteReasons: expect.arrayContaining(['background-consumption-unproven']) } });
        } finally { fresh.h.queue.destroy(); }
    });

    it.each([false, true])('documents main old-run/new-owner risk with evidence=%s (T2RT-15 class)', async witnessed => {
        const d = driver(witnessed);
        try {
            await d.launch('channel-A', 'run-1');
            await d.launch('channel-B'); // No observed start for B: do not borrow run-1 as evidence.
            d.h.sendScannerMessage(notification());
            const answer = await d.finish();
            expect(answer.ev).toMatchObject({ requestId: 'channel-B' });
            if (witnessed) expect(answer.ev).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                incompleteReasons: expect.arrayContaining(['background-consumption-unproven']) } });
        } finally { d.h.queue.destroy(); }
    });

    it.each([undefined, 'unknown', 'running', 'completed'].flatMap(status =>
        [undefined, 'run-1', 'run-old'].map(run => ({ status, run }))))(
        'retains uncertain SDK evidence cases (status=$status, run=$run)', async ({ status, run }) => {
            const d = driver();
            try {
                await d.launch('channel-A', 'run-1');
                const requests = [...d.h.state.backgroundTaskRequestIds!];
                d.sdk({ type: 'system', subtype: 'task_notification', task_id: 'job', tool_use_id: 'launch', status, run_id: run });
                await d.h.queue.flush();
                expect([...d.h.state.backgroundTaskRequestIds!]).toEqual(requests);
                expect(d.h.state.pendingRequestId).toBeNull();
                expect((await d.finish()).ev).toMatchObject({ inputEvidence: { coverage: 'incomplete',
                    incompleteReasons: expect.arrayContaining(['background-consumption-unproven']) } });
            } finally { d.h.queue.destroy(); }
        },
    );

    it.each([undefined, 'unknown', 'running', 'completed'].flatMap(status =>
        [undefined, 'run-1', 'run-old'].map(run => ({ status, run }))))(
        'retains scanner evidence proof cases (status=$status, run=$run)', async ({ status, run }) => {
            const d = driver();
            try {
                await d.launch('channel-A', 'run-1');
                const row = notification();
                d.h.sendScannerMessage({ ...row, origin: { kind: 'task-notification', ...(run ? { runId: run } : {}) },
                    message: { ...row.message, content: `<task-notification><task-id>job</task-id><tool-use-id>launch</tool-use-id>${status ? `<status>${status}</status>` : ''}</task-notification>` } });
                const answer = await d.finish();
                const proven = status === 'completed' && run === 'run-1';
                expect(answer.ev).toMatchObject({ requestId: 'channel-A', inputEvidence: { coverage: proven ? 'complete' : 'incomplete' } });
                if (!proven) expect((answer.ev as { inputEvidence: { incompleteReasons: string[] } }).inputEvidence.incompleteReasons.some(reason => reason.startsWith('background-'))).toBe(true);
            } finally { d.h.queue.destroy(); }
        },
    );

    it('bounds evidence history without disabling scanner routing (T2RT-09 evidence)', async () => {
        const d = driver();
        try {
            await d.launch('channel-A', 'run-1');
            for (let i = 0; i < 1005; i++) d.sdk({ type: 'system', subtype: 'task_notification', task_id: `other-${i}`, run_id: `run-${i}`, status: 'completed' });
            await d.h.queue.flush();
            expect(d.h.state.backgroundCompletions?.entries.size).toBeLessThanOrEqual(1000);
            expect(d.h.state.backgroundCompletions?.aliases.size).toBeLessThanOrEqual(2000);
            expect(d.h.state.backgroundCompletions?.historyLost).toBe(true);
            d.h.sendScannerMessage(notification());
            expect((await d.finish()).ev).toMatchObject({ requestId: 'channel-A', inputEvidence: { coverage: 'incomplete' } });
        } finally { d.h.queue.destroy(); }
    });

    it('keeps scanner routing available when evidence history is lost', async () => {
        const d = driver();
        try {
            await d.launch('channel-A', 'run-1');
            d.sdk({ type: 'system', subtype: 'task_started', task_id: 'x'.repeat(4097), run_id: 'oversized' });
            await d.h.queue.flush();
            expect(d.h.state.backgroundCompletions?.historyLost).toBe(true);
            d.h.sendScannerMessage(notification());
            expect((await d.finish()).ev).toMatchObject({ requestId: 'channel-A', inputEvidence: { coverage: 'incomplete' } });
        } finally { d.h.queue.destroy(); }
    });

    it.each(['origin', 'attachment'])('retains real scanner %s metadata as evidence without SDK routing', async location => {
        const d = driver();
        const directory = await mkdtemp(join(tmpdir(), 't2rt-evidence-'));
        const project = getProjectPath(directory);
        let scanner: Awaited<ReturnType<typeof createSessionScanner>> | undefined;
        let scanned = 0;
        try {
            await d.launch('channel-A', 'run-1');
            d.receipt(); await d.h.queue.flush();
            expect(d.h.state.pendingRequestId).toBeNull();
            scanner = await createSessionScanner({ sessionId: null, workingDirectory: directory,
                onMessage: message => { d.h.sendScannerMessage(message); scanned++; } });
            await mkdir(project, { recursive: true });
            const sessionId = '11111111-2222-4333-8444-999999999999';
            await writeFile(join(project, `${sessionId}.jsonl`), JSON.stringify({ type: 'attachment', uuid: 'details',
                attachment: { type: 'queued_command', commandMode: 'task-notification',
                    ...(location === 'origin' ? { origin: { kind: 'task-notification', runId: 'run-1' } } : { runId: 'run-1' }),
                    prompt: notification().message.content } }) + '\n');
            await scanner.onNewSession(sessionId);
            await vi.waitFor(() => expect(scanned).toBe(1));
            expect((await d.finish()).ev).toMatchObject({ requestId: 'channel-A', inputEvidence: { coverage: 'incomplete',
                incompleteReasons: expect.arrayContaining(['background-consumption-unproven']) } });
        } finally {
            await scanner?.cleanup(); d.h.queue.destroy();
            await rm(project, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true });
        }
    }, 15_000);
});

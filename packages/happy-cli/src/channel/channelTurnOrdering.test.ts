import { describe, expect, it } from 'vitest';
import { OutgoingMessageQueue } from '@/claude/utils/OutgoingMessageQueue';
import {
    closeClaudeTurnWithStatus,
    mapClaudeChannelFinalAnswer,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import type { SessionEnvelope, SessionTurnEndStatus } from '@slopus/happy-wire';
import {
    createOrderedTurnDispatcher,
    finalAnswerItem,
    pendingRequestItem,
    turnEndItem,
    permissionBindingItem,
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
function harness() {
    const envelopes: SessionEnvelope[] = [];
    const state: ClaudeSessionProtocolState = { currentTurnId: null };
    const bindings: {
        permissionId: string; toolName: string; instanceSeq: number;
        turnId: string | null; requestId: string | null;
    }[] = [];
    const target = {
        setPendingTurnRequestId: (requestId: string | null) => { state.pendingRequestId = requestId; },
        sendFinalAnswerForChannelTurn: (text: string) => {
            envelopes.push(...mapClaudeChannelFinalAnswer(state, text).envelopes);
        },
        closeClaudeSessionTurn: (status: SessionTurnEndStatus) => {
            envelopes.push(...closeClaudeTurnWithStatus(state, status).envelopes);
        },
        sendClaudeSessionMessage: (logMessage: unknown) => {
            const mapped = mapClaudeLogMessageToSessionEnvelopes(logMessage as never, state);
            state.currentTurnId = mapped.currentTurnId;
            envelopes.push(...mapped.envelopes);
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
    const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher(target));
    return { queue, envelopes, state, bindings };
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

    it('does not open a channel turn for an uncorrelated or empty result', async () => {
        const { queue, envelopes } = harness();
        queue.enqueue(finalAnswerItem('ordinary result'));
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

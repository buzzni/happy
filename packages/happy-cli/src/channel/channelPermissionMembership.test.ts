import { describe, expect, it } from 'vitest';

import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    toolCallTurnFor,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';

/**
 * The permission callback can be observed **before** the assistant message that carries its
 * `tool_use` block (Saycode specs/desktop-messenger-channels — R9).
 *
 * The SDK reads both off one transport loop and puts them on different paths: a
 * `control_request` is dispatched with `handleControlRequest(e)` and **not awaited**, while the
 * assistant message is enqueued into a separate input stream our own `for await` drains
 * (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, `readMessages`). No enqueue order on
 * our side can change that, so the binding resolves by tool-call membership instead.
 *
 * These tests drive the real mapper, because membership is recorded where it stamps
 * `tool-call-start` — a hand-made map would prove nothing about that.
 */
const assistantWithToolUse = (callId: string, uuid = 'a-1') => ({
    type: 'assistant',
    uuid,
    message: {
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'ls' } }],
    },
    timestamp: '2025-01-01T00:00:00.000Z',
});

function freshState(pendingRequestId: string | null): ClaudeSessionProtocolState {
    return { currentTurnId: null, pendingRequestId };
}

describe('tool-call turn membership', () => {
    it('is unknown before the assistant message is mapped', () => {
        // This is the callback-before-log case. Nothing is known, so nothing may be bound.
        const state = freshState('req-1');
        expect(toolCallTurnFor(state, 'tool-1')).toBeNull();
    });

    it('names the turn that actually contains the tool call once it is mapped', () => {
        const state = freshState('req-1');
        const mapped = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-1') as never, state);
        state.currentTurnId = mapped.currentTurnId;

        const membership = toolCallTurnFor(state, 'tool-1');
        expect(membership?.turnId).toBe(state.currentTurnId);
        expect(membership?.turnId).not.toBeNull();
        expect(membership?.requestId).toBe('req-1');
    });

    it('answers for a tool call only while its own turn is open', () => {
        const state = freshState('req-1');
        const first = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-1', 'a-1') as never, state);
        state.currentTurnId = first.currentTurnId;
        const firstTurn = state.currentTurnId;
        expect(toolCallTurnFor(state, 'tool-1')?.turnId).toBe(firstTurn);
        expect(toolCallTurnFor(state, 'tool-1')?.requestId).toBe('req-1');

        // A second turn opens for a different request.
        const closed = closeClaudeTurnWithStatus(state, 'completed');
        state.currentTurnId = closed.currentTurnId;
        state.pendingRequestId = 'req-2';
        const second = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-2', 'a-2') as never, state);
        state.currentTurnId = second.currentTurnId;

        expect(state.currentTurnId).not.toBe(firstTurn);
        // The first tool call no longer resolves — a late prompt for it must wait for a fresh
        // start rather than inherit either the old turn or the open one.
        expect(toolCallTurnFor(state, 'tool-1')).toBeNull();
        expect(toolCallTurnFor(state, 'tool-2')?.turnId).toBe(state.currentTurnId);
        expect(toolCallTurnFor(state, 'tool-2')?.requestId).toBe('req-2');
    });

    it('records nothing for an in-app turn beyond a null request', () => {
        const state = freshState(null);
        const mapped = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-1') as never, state);
        state.currentTurnId = mapped.currentTurnId;
        expect(toolCallTurnFor(state, 'tool-1')?.requestId).toBeNull();
    });

    it('refuses a stale entry even if the turn changed without closeTurn running', () => {
        // Two independent guards, and this reaches the second one. `currentTurnId` is assigned
        // directly in several places (`apiSession.sendClaudeSessionMessage` takes it from the
        // mapper result), so a turn can move without `closeTurn` dropping that turn's entries.
        // Invalidation at close would not cover this; requiring the entry's own turn to be the
        // open one does.
        const state = freshState('req-1');
        const mapped = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-1') as never, state);
        state.currentTurnId = mapped.currentTurnId;
        expect(toolCallTurnFor(state, 'tool-1')).not.toBeNull();

        // The turn moves on without the close path running; the entry is still in the map.
        state.currentTurnId = 'some-other-turn';
        expect(state.toolCallTurns?.has('tool-1')).toBe(true);
        expect(toolCallTurnFor(state, 'tool-1')).toBeNull();
    });

    it('stops answering for a tool call once its turn has closed', () => {
        const state = freshState('req-1');
        const mapped = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-1') as never, state);
        state.currentTurnId = mapped.currentTurnId;
        expect(toolCallTurnFor(state, 'tool-1')).not.toBeNull();

        const closed = closeClaudeTurnWithStatus(state, 'completed');
        state.currentTurnId = closed.currentTurnId;
        expect(toolCallTurnFor(state, 'tool-1')).toBeNull();
        // And the entry is gone, not merely shadowed.
        expect(state.toolCallTurns?.has('tool-1')).toBe(false);
    });

    it('drops entries at turn close rather than accumulating a history', () => {
        const state = freshState('req-1');
        for (let index = 0; index < 260; index += 1) {
            const mapped = mapClaudeLogMessageToSessionEnvelopes(
                assistantWithToolUse(`tool-${index}`, `a-${index}`) as never, state,
            );
            state.currentTurnId = mapped.currentTurnId;
            const closed = closeClaudeTurnWithStatus(state, 'completed');
            state.currentTurnId = closed.currentTurnId;
            state.pendingRequestId = 'req-1';
        }
        expect(state.toolCallTurns?.size ?? 0).toBe(0);
    });
});

describe('the wiring binds whichever fact arrives second', () => {
    /**
     * Stands in for `ApiSessionClient.bindChannelPermissionWhenKnown` with the same rule: resolve
     * now if membership is known, otherwise wait and resolve when the mapper records it. The real
     * method is exercised through the launcher; this pins the rule itself.
     */
    function deferringBinder(state: ClaudeSessionProtocolState, runtimeId = 'runtime-1') {
        const waiting = new Map<string, (context: {
            turnId: string; channelRequestId: string | null; runtimeId: string;
        }) => void>();
        const resolve = (toolCallId: string, apply: (context: {
            turnId: string; channelRequestId: string | null; runtimeId: string;
        }) => void) => {
            const membership = toolCallTurnFor(state, toolCallId);
            if (!membership) { waiting.set(toolCallId, apply); return; }
            apply({ turnId: membership.turnId, channelRequestId: membership.requestId, runtimeId });
        };
        const drain = () => {
            for (const [toolCallId, apply] of [...waiting]) {
                const membership = toolCallTurnFor(state, toolCallId);
                if (!membership) continue;
                waiting.delete(toolCallId);
                apply({ turnId: membership.turnId, channelRequestId: membership.requestId, runtimeId });
            }
        };
        return { resolve, drain, waiting };
    }

    it('binds nothing when the callback precedes the assistant log, then binds the right turn', () => {
        const state = freshState('req-1');
        const binder = deferringBinder(state);
        const bound: { turnId: string; channelRequestId: string | null; runtimeId: string }[] = [];

        // Callback first — this is the order the SDK does not rule out.
        binder.resolve('tool-1', (context) => bound.push(context));
        expect(bound).toEqual([]);
        expect(binder.waiting.has('tool-1')).toBe(true);

        // Now the assistant message carrying the block is mapped.
        const mapped = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-1') as never, state);
        state.currentTurnId = mapped.currentTurnId;
        binder.drain();

        expect(bound).toEqual([
            { turnId: state.currentTurnId, channelRequestId: 'req-1', runtimeId: 'runtime-1' },
        ]);
    });

    it('binds immediately when the assistant log precedes the callback', () => {
        const state = freshState('req-1');
        const binder = deferringBinder(state);
        const bound: { turnId: string; channelRequestId: string | null; runtimeId: string }[] = [];

        const mapped = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-1') as never, state);
        state.currentTurnId = mapped.currentTurnId;
        binder.resolve('tool-1', (context) => bound.push(context));

        expect(bound).toEqual([
            { turnId: state.currentTurnId, channelRequestId: 'req-1', runtimeId: 'runtime-1' },
        ]);
        expect(binder.waiting.size).toBe(0);
    });

    it('binds nothing for a callback that arrives after its own turn closed', () => {
        // Fail closed rather than bind to either the closed turn or the one open by then. The
        // prompt is unanswerable from outside, which is the safe direction.
        const state = freshState('req-1');
        const binder = deferringBinder(state);
        const bound: { turnId: string; channelRequestId: string | null; runtimeId: string }[] = [];

        const first = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-1', 'a-1') as never, state);
        state.currentTurnId = first.currentTurnId;
        const firstTurn = state.currentTurnId;
        const closed = closeClaudeTurnWithStatus(state, 'completed');
        state.currentTurnId = closed.currentTurnId;

        state.pendingRequestId = 'req-2';
        const second = mapClaudeLogMessageToSessionEnvelopes(assistantWithToolUse('tool-2', 'a-2') as never, state);
        state.currentTurnId = second.currentTurnId;
        expect(state.currentTurnId).not.toBe(firstTurn);

        binder.resolve('tool-1', (context) => bound.push(context));
        expect(bound).toEqual([]);
        expect(binder.waiting.has('tool-1')).toBe(true);
    });
});

describe('a tool-use id reused on a later request', () => {
    /**
     * The stale-membership case. `instanceSeq` does not cover it: the *new* instance would be
     * binding to membership left behind by the old turn, not an old item rebinding a new prompt.
     */
    it('never binds the new prompt to the previous turn or request', () => {
        const state = freshState('req-1');
        const bound: { turnId: string; channelRequestId: string | null; runtimeId: string }[] = [];
        const waiting = new Map<string, (context: {
            turnId: string; channelRequestId: string | null; runtimeId: string;
        }) => void>();
        const resolve = (toolCallId: string, apply: (context: {
            turnId: string; channelRequestId: string | null; runtimeId: string;
        }) => void) => {
            const membership = toolCallTurnFor(state, toolCallId);
            if (!membership) { waiting.set(toolCallId, apply); return; }
            apply({ turnId: membership.turnId, channelRequestId: membership.requestId, runtimeId: 'r' });
        };
        const drain = () => {
            for (const [toolCallId, apply] of [...waiting]) {
                const membership = toolCallTurnFor(state, toolCallId);
                if (!membership) continue;
                waiting.delete(toolCallId);
                apply({ turnId: membership.turnId, channelRequestId: membership.requestId, runtimeId: 'r' });
            }
        };

        // req-1 maps the tool call, and its prompt is bound and answered.
        const firstMapped = mapClaudeLogMessageToSessionEnvelopes(
            assistantWithToolUse('tool-shared', 'a-1') as never, state,
        );
        state.currentTurnId = firstMapped.currentTurnId;
        const firstTurn = state.currentTurnId;
        resolve('tool-shared', (context) => bound.push(context));
        expect(bound).toEqual([{ turnId: firstTurn, channelRequestId: 'req-1', runtimeId: 'r' }]);

        // The turn closes.
        const closed = closeClaudeTurnWithStatus(state, 'completed');
        state.currentTurnId = closed.currentTurnId;

        // req-2 begins, and the callback for the *same* tool id arrives BEFORE its new log.
        state.pendingRequestId = 'req-2';
        bound.length = 0;
        resolve('tool-shared', (context) => bound.push(context));
        // Nothing bound: no req-1 observation is produced, so an answer claiming req-1 has no
        // binding to satisfy and is refused.
        expect(bound).toEqual([]);
        expect(waiting.has('tool-shared')).toBe(true);

        // Now req-2's own log arrives.
        const secondMapped = mapClaudeLogMessageToSessionEnvelopes(
            assistantWithToolUse('tool-shared', 'a-2') as never, state,
        );
        state.currentTurnId = secondMapped.currentTurnId;
        drain();

        expect(state.currentTurnId).not.toBe(firstTurn);
        expect(bound).toEqual([
            { turnId: state.currentTurnId, channelRequestId: 'req-2', runtimeId: 'r' },
        ]);
    });

    it('answers nothing between the close and the new tool start, even with a turn open', () => {
        // The other half: never infer from the current turn. An unrelated turn being open must not
        // make the reused id resolvable.
        const state = freshState('req-1');
        const first = mapClaudeLogMessageToSessionEnvelopes(
            assistantWithToolUse('tool-shared', 'a-1') as never, state,
        );
        state.currentTurnId = first.currentTurnId;
        const closed = closeClaudeTurnWithStatus(state, 'completed');
        state.currentTurnId = closed.currentTurnId;

        // A different turn opens, for a different request, with a different tool call.
        state.pendingRequestId = 'req-2';
        const second = mapClaudeLogMessageToSessionEnvelopes(
            assistantWithToolUse('tool-other', 'a-2') as never, state,
        );
        state.currentTurnId = second.currentTurnId;

        expect(state.currentTurnId).not.toBeNull();
        expect(toolCallTurnFor(state, 'tool-shared')).toBeNull();
        expect(toolCallTurnFor(state, 'tool-other')?.requestId).toBe('req-2');
    });
});

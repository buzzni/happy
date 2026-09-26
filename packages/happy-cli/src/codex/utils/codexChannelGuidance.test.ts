import { describe, expect, it } from 'vitest';

import {
    codexProtocolTurnFor,
    mapCodexMcpMessageToSessionEnvelopes,
    type CodexTurnState,
} from './sessionProtocolMapper';

/**
 * Codex guidance resolves a waiting turn by **provider turn id** (Saycode
 * specs/desktop-messenger-channels — R8/R9).
 *
 * Nothing else is available. `ApprovalHandler`'s params carry no turn or thread id, and the
 * `tool-call-start` that would give call-level membership is emitted *after* the approval and keys
 * on a different id namespace (`call_id` from `exec_command_begin`, versus the approval's
 * `itemId`). So these tests drive the real mapper and assert that the only correlation used is one
 * the provider supplied on both sides — never "whatever turn is current".
 */
function freshState(pendingRequestId: string | null): CodexTurnState {
    return {
        currentTurnId: null,
        pendingRequestId,
        providerTurnToProtocol: new Map<string, string>(),
    };
}

/** Applies one provider message the way `runCodex`'s event handler does. */
function apply(state: CodexTurnState, message: Record<string, unknown>): CodexTurnState {
    const mapped = mapCodexMcpMessageToSessionEnvelopes(message, state);
    state.currentTurnId = mapped.currentTurnId;
    state.currentProviderTurnId = mapped.currentProviderTurnId;
    return state;
}

describe('provider turn correlation', () => {
    it('resolves nothing before the turn has started', () => {
        // The approval-before-anything case: no mapping yet, so publish nothing. The messenger is
        // no better informed than before, which is the fail-closed direction.
        const state = freshState('req-1');
        expect(codexProtocolTurnFor(state, 'pt-1')).toBeNull();
    });

    it('resolves the protocol turn and external request once task_started is mapped', () => {
        const state = freshState('req-1');
        apply(state, { type: 'task_started', turn_id: 'pt-1' });
        expect(codexProtocolTurnFor(state, 'pt-1')).toEqual({
            turnId: state.currentTurnId,
            requestId: 'req-1',
        });
        expect(state.currentTurnId).not.toBeNull();
    });

    it('resolves nothing for a provider turn id it never saw', () => {
        const state = freshState('req-1');
        apply(state, { type: 'task_started', turn_id: 'pt-1' });
        expect(codexProtocolTurnFor(state, 'pt-other')).toBeNull();
        expect(codexProtocolTurnFor(state, null)).toBeNull();
    });

    it('stops resolving once the turn completes', () => {
        const state = freshState('req-1');
        apply(state, { type: 'task_started', turn_id: 'pt-1' });
        expect(codexProtocolTurnFor(state, 'pt-1')).not.toBeNull();

        apply(state, { type: 'task_complete', turn_id: 'pt-1' });
        expect(codexProtocolTurnFor(state, 'pt-1')).toBeNull();
        // Dropped, not merely shadowed.
        expect(state.providerTurnToProtocol?.has('pt-1')).toBe(false);
    });

    it('stops resolving after an abort too', () => {
        const state = freshState('req-1');
        apply(state, { type: 'task_started', turn_id: 'pt-1' });
        apply(state, { type: 'turn_aborted', turn_id: 'pt-1', status: 'failed' });
        expect(codexProtocolTurnFor(state, 'pt-1')).toBeNull();
    });

    it('never answers with a later turn for an earlier provider turn id', () => {
        // The misattribution this guards: a stale provider turn id must not be answered with
        // whatever turn is open by then, which would point a messenger at another request.
        const state = freshState('req-1');
        apply(state, { type: 'task_started', turn_id: 'pt-1' });
        const firstTurn = state.currentTurnId;
        apply(state, { type: 'task_complete', turn_id: 'pt-1' });

        state.pendingRequestId = 'req-2';
        apply(state, { type: 'task_started', turn_id: 'pt-2' });
        expect(state.currentTurnId).not.toBe(firstTurn);

        expect(codexProtocolTurnFor(state, 'pt-1')).toBeNull();
        expect(codexProtocolTurnFor(state, 'pt-2')).toEqual({
            turnId: state.currentTurnId,
            requestId: 'req-2',
        });
    });

    it('refuses a mapping whose turn was replaced without the close path running', () => {
        // Two independent guards. This reaches the second: `currentTurnId` is assigned directly in
        // `runCodex` from the mapper result, so a turn can move without the close path dropping
        // that turn's entry.
        const state = freshState('req-1');
        apply(state, { type: 'task_started', turn_id: 'pt-1' });
        expect(codexProtocolTurnFor(state, 'pt-1')).not.toBeNull();

        state.currentTurnId = 'some-other-turn';
        expect(state.providerTurnToProtocol?.has('pt-1')).toBe(true);
        expect(codexProtocolTurnFor(state, 'pt-1')).toBeNull();
    });

    it('reports a null external request for an in-app turn', () => {
        // The observation builder turns this into "publish nothing" — the prompt is the Desktop
        // user's, and a messenger must not be pointed at it.
        const state = freshState(null);
        apply(state, { type: 'task_started', turn_id: 'pt-1' });
        expect(codexProtocolTurnFor(state, 'pt-1')).toEqual({
            turnId: state.currentTurnId,
            requestId: null,
        });
    });
});

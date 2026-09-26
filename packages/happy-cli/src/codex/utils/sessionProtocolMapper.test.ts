import { describe, expect, it } from 'vitest';
import { mapCodexMcpMessageToSessionEnvelopes } from './sessionProtocolMapper';

describe('channel request correlation on Codex turn boundaries', () => {
    // Saycode specs/desktop-messenger-channels. Same contract as the Claude mapper: the handle
    // rides the turn boundary, because that is what says which work a reply belongs to.
    it('stamps the pending request id on the turn it opens and repeats it on the end', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-1' } as never as
            Parameters<typeof mapCodexMcpMessageToSessionEnvelopes>[1];
        const started = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, state);
        const start = started.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-start');
        expect(start?.ev).toMatchObject({ t: 'turn-start', requestId: 'core-req-1' });
        // Consumed, so a later unrelated turn cannot inherit it.
        expect((state as { pendingRequestId?: unknown }).pendingRequestId).toBeNull();

        const ended = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete' },
            { ...state, currentTurnId: started.currentTurnId } as never,
        );
        const end = ended.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-end');
        expect(end?.ev).toMatchObject({ t: 'turn-end', requestId: 'core-req-1' });
    });

    it('leaves an ordinary in-app turn with no request id', () => {
        const state = { currentTurnId: null } as never as
            Parameters<typeof mapCodexMcpMessageToSessionEnvelopes>[1];
        const started = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, state);
        const start = started.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-start');
        expect(start?.ev).toEqual({ t: 'turn-start' });
    });
});

describe('Codex terminal paths that produce no turn', () => {
    it('answers a request whose run failed before task_started', () => {
        // The terminal arrives with nothing open. Returning no envelopes strands the id: the
        // caller waits forever and the next unrelated turn inherits it.
        const state = { currentTurnId: null, pendingRequestId: 'core-req-1' } as never as
            Parameters<typeof mapCodexMcpMessageToSessionEnvelopes>[1];
        const closed = mapCodexMcpMessageToSessionEnvelopes({ type: 'turn_aborted', status: 'failed' }, state);

        expect(closed.envelopes.map((envelope) => (envelope.ev as { t: string }).t))
            .toEqual(['turn-start', 'turn-end']);
        expect(closed.envelopes[0].ev).toMatchObject({ requestId: 'core-req-1' });
        expect(closed.envelopes[1].ev).toMatchObject({ requestId: 'core-req-1' });
        expect((state as { pendingRequestId?: unknown }).pendingRequestId).toBeNull();
    });

    it('stays silent for an in-app run that produced no turn', () => {
        const state = { currentTurnId: null } as never as
            Parameters<typeof mapCodexMcpMessageToSessionEnvelopes>[1];
        expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete' }, state).envelopes)
            .toHaveLength(0);
    });

    it('does not let a channel id bleed into the next ordinary turn', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-A' } as never as
            Parameters<typeof mapCodexMcpMessageToSessionEnvelopes>[1];
        mapCodexMcpMessageToSessionEnvelopes({ type: 'turn_aborted', status: 'failed' }, state);

        const next = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, state);
        const start = next.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-start');
        expect(start?.ev).toEqual({ t: 'turn-start' });
    });
});

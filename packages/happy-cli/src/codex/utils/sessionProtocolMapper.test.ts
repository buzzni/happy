import { describe, expect, it } from 'vitest';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexProcessorMessageToSessionEnvelopes, mapCodexThreadItemToSessionEnvelopes } from './sessionProtocolMapper';

describe('channel request correlation on Codex turn boundaries', () => {
    it.each([false, true])('T2RT-25 gates only the non-channel final candidate (evidence=%s)', enabled => {
        for (const requestId of [null, 'channel-A']) {
            for (const turn of [null, 'native-A']) {
                const state = { currentTurnId: turn, currentRequestId: requestId };
                const mapped = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', phase: 'final_answer', message: 'done' }, state, enabled);
                expect(mapped.envelopes.map(event => event.ev.t)).toEqual(requestId || (enabled && turn) ? ['text', 'final-answer'] : ['text']);
                expect(state).toEqual({ currentTurnId: turn, currentRequestId: requestId });
            }
        }
    });
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

it('preserves typed browser quota failures in legacy Codex tool receipts', () => {
 const result=mapCodexProcessorMessageToSessionEnvelopes({type:'tool-call-result',callId:'browser-quota',output:{content:JSON.stringify({error:{code:'QUOTA_EXCEEDED',quotaKind:'spaces'}})}} as any,{currentTurnId:'turn'});
 expect(result.find(e=>e.ev.t==='tool-call-end')?.ev).toMatchObject({browserQuotaKind:'spaces'});
});

it('preserves typed quota from live and history MCP browser receipts', () => {
 const invocation={server:'browser',tool:'browser_task_create_space',arguments:{}};
 const output={isError:true,content:[{type:'text',text:JSON.stringify({error:{code:'QUOTA_EXCEEDED',quotaKind:'spaces'}})}]};
 const state={currentTurnId:'turn'};
 const start=mapCodexMcpMessageToSessionEnvelopes({type:'mcp_tool_call_begin',call_id:'c',invocation},state);
 expect(start.envelopes[0]?.ev).toMatchObject({t:'tool-call-start',name:invocation.tool});
 const end=mapCodexMcpMessageToSessionEnvelopes({type:'mcp_tool_call_end',call_id:'c',invocation,result:{Ok:output}},state);
 expect(end.envelopes[0]?.ev).toMatchObject({t:'tool-call-end',browserQuotaKind:'spaces'});
 const history=mapCodexThreadItemToSessionEnvelopes({id:'t',status:'completed',items:[]} as any,{type:'mcpToolCall',id:'c',...invocation,result:output});
 expect(history.find(e=>e.ev.t==='tool-call-end')?.ev).toMatchObject({browserQuotaKind:'spaces'});
});

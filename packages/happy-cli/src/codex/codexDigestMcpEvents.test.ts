import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexThreadItemToSessionEnvelopes } from './utils/sessionProtocolMapper';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function rawEvents(server: string, tool: string) {
    const client = new CodexAppServerClient();
    const events: Record<string, unknown>[] = [];
    client.setEventHandler(event => events.push(event));
    const item = { type: 'mcpToolCall', id: 'digest-call', server, tool,
        arguments: { request_id: 'digest', session_ids: ['target'] }, result: { content: [{ type: 'text', text: 'Request registered' }] } };
    const raw = client as unknown as { handleRawNotification: (method: string, params: unknown) => unknown };
    raw.handleRawNotification('item/started', { turnId: 'turn', item });
    raw.handleRawNotification('item/completed', { turnId: 'turn', item });
    return { events, item };
}

describe('Codex Common MCP digest notifications', () => {
    it.each(['read_project_sessions', 'search_project_sessions'])('preserves %s through raw notifications, live envelopes and history', tool => {
        const { events, item } = rawEvents('aplus-common', tool);
        expect(events.map(event => event.type)).toEqual(['mcp_tool_call_begin', 'mcp_tool_call_end']);
        const start = mapCodexMcpMessageToSessionEnvelopes(events[0], { currentTurnId: 'turn' }).envelopes;
        expect(start).toHaveLength(1);
        expect(start[0].ev).toMatchObject({ t: 'tool-call-start', call: 'digest-call', name: 'McpTool',
            args: { server: 'aplus-common', tool, arguments: item.arguments } });
        const end = mapCodexMcpMessageToSessionEnvelopes(events[1], { currentTurnId: 'turn' }).envelopes;
        expect(end).toHaveLength(1);
        expect(end[0].ev).toMatchObject({ t: 'tool-call-end', call: 'digest-call' });
        const history = mapCodexThreadItemToSessionEnvelopes({ id: 'turn', status: 'completed', items: [] } as never, item as never);
        expect(history.find(event => event.ev.t === 'tool-call-start')?.ev).toMatchObject({ name: 'McpTool', args: { server: 'aplus-common', tool, arguments: item.arguments } });
    });
    it('accepts the normalized Common MCP server spelling', () => {
        expect(rawEvents('aplus_common', 'read_project_sessions').events).toHaveLength(2);
    });
    it.each([['other-server', 'read_project_sessions'], ['aplus-common', 'unrelated_tool']])('does not add live digest events for %s/%s', (server, tool) => {
        const { events } = rawEvents(server, tool);
        expect(events).toEqual([]);
        expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'mcp_tool_call_begin', call_id: 'x', invocation: { server, tool, arguments: {} } }, { currentTurnId: 'turn' }).envelopes).toEqual([]);
    });
    it('never interprets a digest result as a browser quota receipt', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes({ type: 'mcp_tool_call_end', call_id: 'digest',
            invocation: { server: 'aplus-common', tool: 'search_project_sessions' },
            result: { Ok: { isError: true, content: [{ type: 'text', text: '{"error":{"code":"QUOTA_EXCEEDED","quotaKind":"spaces"}}' }] } },
        }, { currentTurnId: 'turn' });
        expect(result.envelopes[0].ev).toMatchObject({ t: 'tool-call-end', call: 'digest' });
        expect(result.envelopes[0].ev).not.toHaveProperty('browserQuotaKind');
    });
    it('preserves browser event names and quota failure receipts', () => {
        const invocation = { server: 'browser', tool: 'browser_task_create_space', arguments: {} };
        const start = mapCodexMcpMessageToSessionEnvelopes({ type: 'mcp_tool_call_begin', call_id: 'browser', invocation }, { currentTurnId: 'turn' });
        expect(start.envelopes[0]?.ev).toMatchObject({ t: 'tool-call-start', name: invocation.tool, args: {} });
        const end = mapCodexMcpMessageToSessionEnvelopes({ type: 'mcp_tool_call_end', call_id: 'browser', invocation, result: { Ok: { isError: true, content: [{ type: 'text', text: '{"error":{"code":"QUOTA_EXCEEDED","quotaKind":"spaces"}}' }] } } }, { currentTurnId: 'turn' });
        expect(end.envelopes[0]?.ev).toMatchObject({ t: 'tool-call-end', browserQuotaKind: 'spaces' });
    });
})

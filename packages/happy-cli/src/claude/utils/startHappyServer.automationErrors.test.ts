/**
 * aplus-dev-studio specs/script-automation-viewer-key R7 — a viewer key no local key matches keeps its code and tells
 * the agent that retrying cannot help and where the user registers instead.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startHappyServer } from './startHappyServer';
import { unixMcpFetch } from './unixMcpFetch';
import type { ApiSessionClient } from '@/api/apiSession';

const tools = vi.hoisted(() => ({ script: vi.fn(), scheduled: vi.fn() }));
vi.mock('./scriptAutomationTools', async (original) => ({ ...await original<typeof import('./scriptAutomationTools')>(), runScriptAutomationTool: tools.script }));
vi.mock('./scheduledTaskTools', async (original) => ({ ...await original<typeof import('./scheduledTaskTools')>(), runScheduledTaskTool: tools.scheduled }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));

beforeEach(() => {
    vi.stubEnv('HAPPY_WRITE_SCOPE_SESSION', undefined);
    vi.stubEnv('HAPPY_SANDBOX_POLICY_MODE', undefined);
    vi.stubEnv('SAYCODE_MCP_BEARER', undefined);
});
afterEach(() => vi.unstubAllEnvs());

const client = () => ({
    hasTitle: vi.fn(() => false), sendClaudeSessionMessage: vi.fn(), updateMetadata: vi.fn(),
    getMetadata: vi.fn(() => ({ path: '/work/project', machineId: 'pc' })), sessionId: 'session',
} as unknown as ApiSessionClient);

async function callTool(server: Awaited<ReturnType<typeof startHappyServer>>, name: string, args: Record<string, unknown>) {
    const send: typeof fetch = server.socketPath
        ? unixMcpFetch(server.socketPath, server.mcpConfig.env!.SAYCODE_MCP_TOKEN)
        : (input, init) => fetch(input, { ...init, headers: { ...init?.headers as Record<string, string>, ...JSON.parse(server.bridgeEnv.HAPPY_HTTP_MCP_HEADERS) } });
    const response = await send(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const raw = await response.text();
    return JSON.parse(raw.startsWith('event:') ? raw.slice(raw.indexOf('data: ') + 6) : raw).result;
}

it('explains a viewer key mismatch after its code, and leaves other codes bare', async () => {
    const server = await startHappyServer(client());
    try {
        tools.script.mockRejectedValueOnce(new Error('SCRIPT_VIEWER_KEY_MISMATCH'));
        const script = await callTool(server, 'script_automations', { request: { operation: 'list' } });
        expect(script.isError).toBe(true);
        expect(script.content[0].text).toMatch(/^SCRIPT_VIEWER_KEY_MISMATCH\n.*Do not retry.*스크립트 등록/s);

        tools.scheduled.mockRejectedValueOnce(new Error('SCHEDULED_TASK_VIEWER_KEY_MISMATCH'));
        const scheduled = await callTool(server, 'scheduled_tasks', { request: { operation: 'list' } });
        expect(scheduled.content[0].text).toMatch(/^SCHEDULED_TASK_VIEWER_KEY_MISMATCH\n.*Do not retry.*자동화/s);

        tools.script.mockRejectedValueOnce(new Error('REVISION_CONFLICT'));
        expect((await callTool(server, 'script_automations', { request: { operation: 'list' } })).content[0].text).toBe('REVISION_CONFLICT');
    } finally { server.stop(); }
});

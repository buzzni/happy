import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCodexChatExec } from './codexChatExec';

function fixture() {
    const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill: vi.fn(), pid: undefined,
    });
    const spawn = vi.fn((..._args: unknown[]) => child);
    const events: Record<string, unknown>[] = [];
    const input = { env: {}, args: [], prompt: 'PRIVATE_DOCUMENT_BODY', model: 'test',
        mcpServers: { saycode: { url: 'http://studio/mcp/documents', http_headers: { Authorization: 'private-grant' }, enabled_tools: ['write_document'] } },
        onEvent: (event: Record<string, unknown>) => events.push(event), spawn: spawn as any };
    return { child, spawn, events, input };
}

describe('Codex Chat one-turn execution', () => {
    it('uses stdin and ephemeral exec, hides grants from argv, and waits for process exit before success', async () => {
        const f = fixture();
        const result = runCodexChatExec(f.input);
        expect(f.spawn.mock.calls[0][1]).toContain('--ephemeral');
        expect(f.spawn.mock.calls[0][1]).not.toContain('app-server');
        expect(JSON.stringify(f.spawn.mock.calls[0][1])).not.toContain('PRIVATE_DOCUMENT_BODY');
        expect(JSON.stringify(f.spawn.mock.calls[0][1])).not.toContain('private-grant');
        expect(f.spawn.mock.calls[0][1]).toContain('mcp_servers.saycode.env_http_headers={"Authorization"="HAPPY_CHAT_MCP_HEADER_0"}');
        expect(f.child.stdin.read().toString()).toBe('PRIVATE_DOCUMENT_BODY');
        f.child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: 'answer', text: 'stored' } }) + '\n');
        f.child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 } }) + '\n');
        expect(f.events.some(e => e.type === 'task_complete')).toBe(false);
        f.child.emit('close', 0, null);
        await expect(result).resolves.toEqual({ aborted: false });
        expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent_message', message: 'stored' }));
        expect(f.events).toContainEqual(expect.objectContaining({ type: 'codex_usage', usage: expect.objectContaining({ inputTokens: 20, cachedInputTokens: 5, totalTokens: 24 }) }));
        expect(f.events.at(-1)?.type).toBe('task_complete');
    });
    it('rejects missing MCP, provider failures and incomplete output instead of reporting completion', async () => {
        const missing = fixture();
        await expect(runCodexChatExec({ ...missing.input, mcpServers: {} })).rejects.toThrow('saycode');
        expect(missing.spawn).not.toHaveBeenCalled();
        for (const output of ['', JSON.stringify({ type: 'turn.failed', error: { message: 'MCP unavailable' } }) + '\n']) {
            const f = fixture();
            const result = runCodexChatExec(f.input);
            f.child.stdout.write(output);
            f.child.emit('close', 1, null);
            await expect(result).rejects.toThrow();
            expect(f.events.some(e => e.type === 'task_complete')).toBe(false);
            expect(f.events.at(-1)).toMatchObject({ type: 'turn_aborted', status: 'failed', error: expect.objectContaining({ message: expect.any(String) }) });
        }
    });
    it('cancels the child and reports aborted only after it exits', async () => {
        const f = fixture(); const controller = new AbortController();
        const result = runCodexChatExec({ ...f.input, signal: controller.signal });
        controller.abort();
        expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
        f.child.emit('close', null, 'SIGTERM');
        await expect(result).resolves.toEqual({ aborted: true });
        expect(f.events.at(-1)?.type).toBe('turn_aborted');
    });
});

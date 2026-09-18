import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { EventMsg } from './codexAppServerTypes';

/** app-server writes prompt-bearing diagnostic SQLite rows even for ephemeral threads.
 * exec --ephemeral uses the same provider/MCP runtime without that diagnostic sink. */
export async function runCodexChatExec(input: {
    env: Record<string, string>; args: string[]; prompt: string; model?: string;
    effort?: string; developerInstructions?: string; mcpServers: Record<string, unknown>;
    signal?: AbortSignal; timeoutMs?: number; onEvent: (event: EventMsg) => void;
    onSpawn?: (child: ChildProcess) => void; spawn?: typeof spawn;
}): Promise<{ aborted: boolean }> {
    const server = input.mcpServers.saycode as {
        url?: string; http_headers?: Record<string, string>; enabled_tools?: string[];
    } | undefined;
    if (!server?.url) throw new Error('Chat requires the saycode document MCP server.');
    if (input.signal?.aborted) return { aborted: true };
    const env = { ...input.env };
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox', ...input.args];
    const config = (key: string, value: unknown) => args.push('-c', `${key}=${JSON.stringify(value)}`);
    if (input.model) args.push('-m', input.model);
    if (input.effort) config('model_reasoning_effort', input.effort);
    if (input.developerInstructions) config('developer_instructions', input.developerInstructions);
    config('mcp_servers.saycode.url', server.url);
    config('mcp_servers.saycode.required', true);
    if (server.enabled_tools) config('mcp_servers.saycode.enabled_tools', server.enabled_tools);
    const headerBindings: string[] = [];
    for (const [index, [header, value]] of Object.entries(server.http_headers ?? {}).entries()) {
        const name = `HAPPY_CHAT_MCP_HEADER_${index}`;
        env[name] = value;
        headerBindings.push(`${JSON.stringify(header)}=${JSON.stringify(name)}`);
    }
    if (headerBindings.length) args.push('-c', `mcp_servers.saycode.env_http_headers={${headerBindings.join(',')}}`);
    args.push('-');
    const child = (input.spawn ?? spawn)('codex', args, {
        env, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32',
    });
    input.onSpawn?.(child);
    const turnId = randomUUID();
    input.onEvent({ type: 'task_started', turn_id: turnId });
    return new Promise((resolve, reject) => {
        let completed = false;
        let failure: Error | null = null;
        let stderr = '';
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const kill = (signal: NodeJS.Signals) => {
            try {
                if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error;
            }
        };
        const abort = () => {
            kill('SIGTERM');
            forceTimer ??= setTimeout(() => kill('SIGKILL'), 3000);
            forceTimer.unref();
        };
        const timeout = setTimeout(() => {
            failure = new Error('Codex Chat turn timed out');
            abort();
        }, input.timeoutMs ?? 10 * 60_000);
        timeout.unref();
        input.signal?.addEventListener('abort', abort, { once: true });
        const lines = createInterface({ input: child.stdout! });
        lines.on('line', line => {
            timeout.refresh();
            try {
                const event = JSON.parse(line);
                if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
                    input.onEvent({ type: 'agent_message', message: event.item.text, item_id: event.item.id });
                } else if (event.type === 'turn.completed') {
                    completed = true;
                    const usage = event.usage;
                    if (usage) input.onEvent({ type: 'codex_usage', response_id: turnId, usage: {
                        inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens ?? 0,
                        cacheWriteInputTokens: usage.cache_write_input_tokens ?? 0,
                        outputTokens: usage.output_tokens, reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
                        totalTokens: usage.input_tokens + usage.output_tokens,
                    } });
                } else if (event.type === 'turn.failed' || event.type === 'error') {
                    failure = new Error(event.error?.message ?? event.message ?? 'Codex Chat turn failed');
                }
            } catch (error) { failure = error as Error; abort(); }
        });
        child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
        child.stdin?.on('error', error => { failure = error; abort(); });
        const cleanup = () => {
            clearTimeout(timeout); clearTimeout(forceTimer);
            input.signal?.removeEventListener('abort', abort); lines.close();
        };
        child.once('error', error => { cleanup(); reject(error); });
        child.once('close', (code) => {
            cleanup();
            if (input.signal?.aborted && !failure) {
                input.onEvent({ type: 'turn_aborted', turn_id: turnId });
                resolve({ aborted: true });
            } else if (failure || code !== 0 || !completed) {
                const error = failure ?? new Error(stderr.trim() || 'Codex Chat exited without a completed turn');
                input.onEvent({ type: 'turn_aborted', turn_id: turnId, status: 'failed', error: { message: error.message } });
                reject(error);
            } else {
                input.onEvent({ type: 'task_complete', turn_id: turnId });
                resolve({ aborted: false });
            }
        });
        // No prompt file, attachment staging, output file or provider conversation history.
        child.stdin!.end(input.prompt);
    });
}

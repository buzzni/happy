import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { executableIdentity, resolveHostSource, type HostMcpSource } from './hostToolCatalog';
import type { createProtectedToolAccess } from './protectedToolAccess';

export const hostToolInput = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list') }).strict(),
    z.object({ action: z.literal('inspect'), source: z.string().min(1).max(128) }).strict(),
    z.object({ action: z.literal('call'), source: z.string().min(1).max(128), tool: z.string().min(1).max(128), parameters: z.record(z.string(), z.unknown()).default({}) }).strict(),
    z.object({ action: z.literal('command'), command: z.string().min(1).max(4096), args: z.array(z.string().max(16384)).max(128).default([]),
        stdin: z.string().max(65536).optional() }).strict(),
]);
type Input = z.infer<typeof hostToolInput>;
type McpOperation = Extract<Input, { action: 'inspect' | 'call' }>;
type Command = { command: string; args: string[]; cwd: string; stdin?: string };
type Access = ReturnType<typeof createProtectedToolAccess>;

/** One invocation, one approved external process/connection. No executable, credential or fallback is chosen by a webpage. */
export function createHostedTools(options: {
    access(): Access | null | undefined;
    servers(): Promise<Record<string, unknown>>;
    cwd: string;
    allowed?: () => boolean;
    admit?: <T>(work: () => Promise<T>) => Promise<T>;
    executeMcp?: typeof executeHostMcp;
    executeCommand?: typeof executeHostCommand;
}) {
    const admitted = <T>(work: () => Promise<T>) => options.admit ? options.admit(work) : work();
    return {
        async invoke(raw: unknown, signal: AbortSignal): Promise<unknown> {
            const input = hostToolInput.parse(raw);
            if (options.allowed && !options.allowed()) throw new Error('HOST_TOOL_HOST_NOT_AUTHORIZED');
            if (signal.aborted) throw new Error('TOOL_ACCESS_CANCELLED');
            if (input.action === 'list') {
                const servers = await options.servers();
                return { sources: Object.entries(servers).filter(([name]) => name !== 'happy').slice(0, 128).map(([name, value]) => {
                    const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
                    return { name, status: row.enabled === false || row.disabled === true ? 'disabled' : 'approval-required' };
                }), command: { available: true, approval: 'required', boundary: 'host' } };
            }
            const access = options.access();
            if (!access) throw new Error('TOOL_ACCESS_APPROVER_REQUIRED');
            if (input.action === 'command') {
                const executable = await executableIdentity(input.command, options.cwd);
                const command: Command = { command: executable.path, args: input.args, cwd: options.cwd, ...(input.stdin !== undefined ? { stdin: input.stdin } : {}) };
                return access.run({ toolName: 'mcp__happy__host_command', binding: executable.identity,
                    target: { program: executable.path, directory: options.cwd }, args: { arguments: input.args, ...(input.stdin !== undefined ? { stdin: input.stdin } : {}) } }, signal,
                async (_scope, assertCurrent, executionSignal) => {
                    const current = await executableIdentity(input.command, options.cwd);
                    if (current.identity !== executable.identity) throw new Error('TOOL_ACCESS_CHANGED');
                    return admitted(() => { assertCurrent(); return (options.executeCommand ?? executeHostCommand)(command, executionSignal); });
                });
            }
            if (input.source === 'happy') throw new Error('HOST_TOOL_RECURSION_REFUSED');
            const resolve = async () => {
                const servers = await options.servers();
                if (!Object.hasOwn(servers, input.source)) throw new Error('HOST_TOOL_NOT_CONFIGURED');
                const raw = servers[input.source] as Record<string, unknown> | null;
                if (input.action === 'call' && raw && typeof raw === 'object') {
                    if ((Array.isArray(raw.disabled_tools) && raw.disabled_tools.includes(input.tool))
                        || (Array.isArray(raw.enabled_tools) && !raw.enabled_tools.includes(input.tool))) throw new Error('HOST_TOOL_DISABLED');
                }
                return resolveHostSource(raw, options.cwd);
            };
            const configured = await resolve();
            const target: Record<string, string> = configured.source.kind === 'stdio' ? { server: input.source, program: configured.source.command }
                : { server: input.source, address: new URL(configured.source.url).origin };
            return access.run({ toolName: `mcp__${input.source}__${input.action === 'inspect' ? 'tools_list' : input.tool}`,
                binding: configured.binding, target, args: input.action === 'call' ? input.parameters : {} }, signal,
            async (approvedScope, assertCurrent, executionSignal) => {
                if ((await resolve()).binding !== configured.binding) throw new Error('TOOL_ACCESS_CHANGED');
                return admitted(() => { assertCurrent(); return (options.executeMcp ?? executeHostMcp)(configured.source, input.action === 'call' ? { ...input, parameters: approvedScope.args ?? {} } : input, executionSignal); });
            });
        },
    };
}

async function executeHostMcp(source: HostMcpSource, input: McpOperation, signal: AbortSignal): Promise<unknown> {
    const client = new Client({ name: 'saycode-approved-host-tool', version: '1.0.0' });
    const transport = source.kind === 'stdio' ? new StdioClientTransport({ command: source.command, args: source.args,
        cwd: source.cwd, env: { ...getDefaultEnvironment(), ...source.env }, stderr: 'ignore' })
        : source.kind === 'sse' ? new SSEClientTransport(new URL(source.url), { requestInit: { headers: source.headers, redirect: 'error' } })
            : new StreamableHTTPClientTransport(new URL(source.url), { requestInit: { headers: source.headers, redirect: 'error' } });
    const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const close = () => { void transport.close().catch(() => {}); };
    executionSignal.addEventListener('abort', close, { once: true });
    try {
        executionSignal.throwIfAborted();
        await client.connect(transport, { signal: executionSignal, timeout: 15000 });
        if (input.action === 'inspect') return await client.listTools({}, { signal: executionSignal, timeout: 15000 });
        return await client.callTool({ name: input.tool, arguments: input.parameters }, undefined, { signal: executionSignal, timeout: 120000 });
    } finally {
        executionSignal.removeEventListener('abort', close);
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
    }
}

/** The approval is for these exact argv/stdin, never a shell interpolation or an automatic retry. */
async function executeHostCommand(command: Command, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn(command.command, command.args, { cwd: command.cwd, env: getDefaultEnvironment(), shell: false,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
        let stdout = '', stderr = '', bytes = 0, stopped: string | null = null;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const kill = (kind: NodeJS.Signals) => {
            try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* already exited */ }
        };
        const stop = (reason: string) => {
            if (stopped) return;
            stopped = reason; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 2000); killTimer.unref();
        };
        const abort = () => stop('cancelled');
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        const timeout = setTimeout(() => stop('timeout'), 120000);
        const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) { stop('output-limit'); return; }
            if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
        };
        child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
        child.stdin.on('error', () => {}); child.stdin.end(command.stdin ?? '');
        const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); signal.removeEventListener('abort', abort); };
        child.once('error', () => { cleanup(); reject(new Error('HOST_TOOL_START_FAILED')); });
        child.once('close', (exitCode, exitSignal) => { cleanup(); resolve({ exitCode, signal: exitSignal, stdout, stderr,
            ...(stopped ? { stopped, mayHaveLateEffects: true, retry: 'Do not automatically repeat a command with an unknown outcome.' } : {}) }); });
    });
}

/**
 * cua-driver shadow proxy (aplus-dev-studio specs/agent-tool-policy plan "I1b", R5, R9).
 *
 * Happy gives the provider an MCP entry with the same name as the user's own `cua-driver` entry
 * (measured 2026-10-22: Claude's SDK/`--mcp-config` entry beats user and local scope, and Codex's
 * thread config replaces `command`/`args` of the user's `config.toml` entry). That entry starts
 * this proxy, which starts the user's real command and relays newline-delimited JSON-RPC both ways.
 *
 * - `tools/call` is held until the session's policy gate decides; a refusal is answered here as a
 *   tool error (`isError`) carrying the R12 text, and the call never reaches cua-driver.
 * - Every response with `structuredContent.elements[].element_token` (a `get_window_state`
 *   snapshot) records token → pid, so a later call that names only a token is judged against the
 *   app it really acts on.
 * - `tools/list` passes through unchanged; the list is reported to the session for R9 audit.
 *
 * Fail closed: the proxy never exposes cua-driver unjudged. If the policy endpoint cannot be
 * reached every call is refused; if cua-driver exits, or the proxy itself dies, the provider loses
 * the server — the tools become unavailable, not unguarded.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { withoutToolPolicyEnv, type ToolPolicyClient } from './policyClient';

/** Snapshots are per window and superseded quickly; this bounds memory over a long session. */
const MAX_REMEMBERED_TOKENS = 5000;

type JsonRpcId = string | number;

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: JsonRpcId | null;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: unknown;
}

export interface CuaProxyOptions {
    upstream: { command: string; args: string[]; env: NodeJS.ProcessEnv };
    /** Null only when the entry lost its policy env: then every call is refused. */
    policy: ToolPolicyClient | null;
    input: Readable;
    output: Writable;
    /** Called once, when either side is gone. */
    onExit: (code: number) => void;
    spawnUpstream?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
    log?: (message: string) => void;
}

export interface CuaProxy {
    /** element_token → pid, for tests. */
    tokenPid(token: string): number | undefined;
    stop(): void;
}

export function startCuaProxy(options: CuaProxyOptions): CuaProxy {
    const log = options.log ?? ((message: string) => process.stderr.write(`[happy-cua-proxy] ${message}\n`));
    const child = (options.spawnUpstream ?? defaultSpawn)(options.upstream.command, options.upstream.args, options.upstream.env);
    const tokens = new Map<string, number>();
    const held = new Map<string, AbortController>();
    const listRequests = new Set<string>();
    const forwardedCalls = new Map<string, number | undefined>();
    let exited = false;

    const exit = (code: number) => {
        if (exited) return;
        exited = true;
        for (const controller of held.values()) controller.abort();
        held.clear();
        if (child.exitCode === null && !child.killed) child.kill();
        options.onExit(code);
    };
    const toClient = (message: unknown) => {
        if (!exited) options.output.write(JSON.stringify(message) + '\n');
    };
    const toUpstream = (line: string) => {
        if (!exited && child.stdin?.writable) child.stdin.write(line + '\n');
    };

    child.on('error', (error) => {
        log(`cua-driver could not start: ${error.message}`);
        exit(1);
    });
    child.on('exit', (code, signal) => {
        log(`cua-driver exited (${signal ?? code})`);
        exit(code ?? 1);
    });
    child.stdin?.on('error', () => undefined);

    createInterface({ input: child.stdout! }).on('line', (line) => {
        const message = parse(line);
        const key = message?.id === undefined || message.id === null ? null : idKey(message.id);
        if (message && key !== null && message.method === undefined) {
            if (listRequests.delete(key)) reportTools(message.result);
            if (forwardedCalls.has(key)) {
                rememberTokens(message.result, forwardedCalls.get(key));
                forwardedCalls.delete(key);
            }
        }
        if (!exited) options.output.write(line + '\n');
    });

    const clientLines = createInterface({ input: options.input });
    clientLines.on('line', (line) => {
        const message = parse(line);
        // Only a message the proxy can read is relayed: nothing reaches cua-driver unjudged.
        if (!message) {
            refuseUnreadable(line);
            return;
        }
        if (message.method === 'tools/call') {
            if (message.id === undefined || message.id === null) {
                log('dropped a tools/call without an id');
                return;
            }
            void judge(line, message as JsonRpcMessage & { id: JsonRpcId });
            return;
        }
        if (message?.method === 'tools/list' && message.id !== undefined && message.id !== null) listRequests.add(idKey(message.id));
        if (message?.method === 'notifications/cancelled') {
            const requestId = message.params?.requestId;
            if (typeof requestId === 'string' || typeof requestId === 'number') {
                held.get(idKey(requestId))?.abort();
                forwardedCalls.delete(idKey(requestId));
            }
        }
        toUpstream(line);
    });
    clientLines.on('close', () => exit(0));

    async function judge(line: string, message: JsonRpcMessage & { id: JsonRpcId }): Promise<void> {
        const key = idKey(message.id);
        const params = message.params ?? {};
        const tool = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? params.arguments : {};
        const meta = isRecord(params._meta) ? params._meta : {};
        // Claude sends its tool_use id, Codex its call id: the approval card attaches to that call.
        const toolUseId = typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId']
            : typeof meta.callId === 'string' ? meta.callId : undefined;
        const elementPid = typeof args.element_token === 'string' ? tokens.get(args.element_token) : undefined;
        const controller = new AbortController();
        held.set(key, controller);
        const verdict = options.policy
            ? await options.policy.decide({ tool, args, ...(toolUseId ? { toolUseId } : {}), ...(elementPid !== undefined ? { elementPid } : {}) }, controller.signal)
            : { kind: 'deny' as const, reasonCode: 'policy_unavailable', reason: '도구 정책으로 막힘: 이 세션의 정책 판정 경로가 설정되지 않아 컴퓨터 사용 도구를 실행하지 않았다. 대신: 사용자에게 알려라. 이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.' };
        held.delete(key);
        if (exited) return;
        // The client gave up on this call while it waited: it must not run late.
        if (controller.signal.aborted) return;
        if (verdict.kind === 'pass' || verdict.kind === 'allow') {
            forwardedCalls.set(key, Number.isInteger(args.pid) ? args.pid as number : undefined);
            toUpstream(line);
            return;
        }
        toClient({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: verdict.reason }], isError: true } });
    }

    function refuseUnreadable(line: string): void {
        let batch: unknown;
        try {
            batch = JSON.parse(line);
        } catch {
            log('dropped an unreadable line');
            return;
        }
        // JSON-RPC batches are gone from MCP (2025-06-18); answer each request in one rather than judge it.
        for (const item of Array.isArray(batch) ? batch : []) {
            const id = isRecord(item) ? item.id : undefined;
            if (typeof id === 'string' || typeof id === 'number') {
                toClient({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Batch requests are not supported' } });
            }
        }
    }

    function rememberTokens(result: Record<string, unknown> | undefined, requestPid: number | undefined): void {
        const structured = isRecord(result?.structuredContent) ? result.structuredContent : null;
        if (!structured || !Array.isArray(structured.elements)) return;
        const snapshotPid = Number.isInteger(structured.pid) ? structured.pid as number : requestPid;
        for (const element of structured.elements) {
            if (!isRecord(element) || typeof element.element_token !== 'string') continue;
            const pid = Number.isInteger(element.pid) ? element.pid as number : snapshotPid;
            if (pid === undefined) continue;
            tokens.delete(element.element_token);
            tokens.set(element.element_token, pid);
        }
        while (tokens.size > MAX_REMEMBERED_TOKENS) tokens.delete(tokens.keys().next().value as string);
    }

    function reportTools(result: Record<string, unknown> | undefined): void {
        if (!options.policy || !Array.isArray(result?.tools)) return;
        options.policy.toolsListed(result.tools.filter(isRecord).filter((tool) => typeof tool.name === 'string')
            .map((tool) => ({ name: tool.name as string, annotations: tool.annotations })));
    }

    return {
        tokenPid: (token) => tokens.get(token),
        stop: () => exit(0),
    };
}

/**
 * `happy-mcp.mjs --cua-proxy -- <command> [args...]`: the user's cua-driver command line follows
 * `--`. Its env is ours minus the policy plumbing (Codex already merged the user's entry env in;
 * for Claude, Happy copied it into the shadow entry).
 */
export function parseCuaProxyArgv(argv: string[]): { command: string; args: string[] } | null {
    const separator = argv.indexOf('--');
    if (!argv.includes('--cua-proxy') || separator < 0 || separator + 1 >= argv.length) return null;
    return { command: argv[separator + 1], args: argv.slice(separator + 2) };
}

/**
 * Claude only: the user's own cua-driver env, which the shadow entry references as
 * `${HAPPY_CUA_UPSTREAM_ENV}` (Claude expands it from its environment) instead of carrying it in
 * `--mcp-config` argv where other local users can read it. Read back here for cua-driver only.
 */
export const CUA_UPSTREAM_ENV_VAR = 'HAPPY_CUA_UPSTREAM_ENV';

export function cuaUpstreamEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const { [CUA_UPSTREAM_ENV_VAR]: carried, ...rest } = withoutToolPolicyEnv(env);
    let user: unknown = {};
    try {
        user = JSON.parse(carried ?? '{}');
    } catch {
        user = {};
    }
    const strings = Object.entries(isRecord(user) ? user : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return { ...rest, ...Object.fromEntries(strings) };
}

function defaultSpawn(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    return spawn(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
}

function parse(line: string): JsonRpcMessage | null {
    try {
        const value = JSON.parse(line);
        return isRecord(value) ? value as JsonRpcMessage : null;
    } catch {
        return null;
    }
}

function idKey(id: JsonRpcId): string {
    return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

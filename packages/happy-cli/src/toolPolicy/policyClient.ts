/**
 * How the out-of-process adapters — the cua-driver shadow proxy and the stdio bridge — ask their
 * session for a tool policy decision (aplus-dev-studio specs/agent-tool-policy plan "결정: 집행 위치").
 *
 * They are MCP server processes the provider (Claude, Codex) starts, so they reach the session the
 * way the Claude hook script does: loopback HTTP to the session hook server, presenting the
 * per-process secret from its 0600 file. The provider passes only the env the MCP entry names, so
 * the entry carries the port, the secret file and the server name (`toolPolicyAdapterEnv`).
 *
 * Fail closed: anything other than an explicit `pass`/`allow` — the server unreachable, a non-200
 * answer, an unreadable verdict, our own deadline — is `deny`. An `ask` verdict is a terminal prompt
 * only the Claude hook can show, so it is `deny` here too.
 */

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { HookVerdict, PreToolUseCall } from './policyGate';

export const TOOL_POLICY_PORT_ENV = 'HAPPY_TOOL_POLICY_PORT';
export const TOOL_POLICY_SECRET_FILE_ENV = 'HAPPY_TOOL_POLICY_SECRET_FILE';
export const TOOL_POLICY_SERVER_ENV = 'HAPPY_TOOL_POLICY_SERVER';
const ADAPTER_ENV_KEYS = [TOOL_POLICY_PORT_ENV, TOOL_POLICY_SECRET_FILE_ENV, TOOL_POLICY_SERVER_ENV];

const SECRET_HEADER = 'x-happy-hook-secret';
/** Between the 30-minute approval wait and the 1900-second provider timeout, as the hook script. */
export const POLICY_DECISION_DEADLINE_MS = 1850 * 1000;
const NO_BYPASS = '이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

export interface ToolPolicyAdapterCall {
    /** The server's own tool name; the client adds `mcp__<server>__`. */
    tool: string;
    args: unknown;
    toolUseId?: string;
    elementPid?: number;
    annotations?: PreToolUseCall['annotations'];
}

export interface ToolPolicyClient {
    server: string;
    decide(call: ToolPolicyAdapterCall, signal?: AbortSignal): Promise<Exclude<HookVerdict, { kind: 'ask' }>>;
    /** Fire and forget: a lost report loses an audit line, never a decision. */
    toolsListed(tools: Array<{ name: string; annotations?: unknown }>): void;
}

export function toolPolicyAdapterEnv(input: { port: number; secretFile: string; server: string }): Record<string, string> {
    return {
        [TOOL_POLICY_PORT_ENV]: String(input.port),
        [TOOL_POLICY_SECRET_FILE_ENV]: input.secretFile,
        [TOOL_POLICY_SERVER_ENV]: input.server,
    };
}

/** The env an adapter hands to the server it wraps: the policy plumbing is not the server's business. */
export function withoutToolPolicyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const rest = { ...env };
    for (const key of ADAPTER_ENV_KEYS) delete rest[key];
    return rest;
}

/** Null when the entry carries no policy env (policy off, or an entry Happy did not build). */
export function toolPolicyClientFromEnv(env: NodeJS.ProcessEnv, origin: 'cua-proxy' | 'bridge', options: { deadlineMs?: number } = {}): ToolPolicyClient | null {
    const port = Number.parseInt(env[TOOL_POLICY_PORT_ENV] ?? '', 10);
    const secretFile = env[TOOL_POLICY_SECRET_FILE_ENV];
    const server = env[TOOL_POLICY_SERVER_ENV];
    if (!port && !secretFile && !server) return null;
    const deadlineMs = options.deadlineMs ?? POLICY_DECISION_DEADLINE_MS;
    const name = server || 'unknown';
    let secret: string | null = null;
    const readSecret = (): string | null => {
        if (secret) return secret;
        try {
            secret = readFileSync(secretFile ?? '', 'utf8').trim() || null;
        } catch {
            secret = null;
        }
        return secret;
    };
    const post = (path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
        const key = readSecret();
        if (!port || !server || !key) return reject(new Error('policy endpoint not configured'));
        const payload = Buffer.from(JSON.stringify(body));
        const req = request({
            host: '127.0.0.1', port, method: 'POST', path, signal,
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, [SECRET_HEADER]: key },
        }, (res) => {
            const parts: Buffer[] = [];
            res.on('data', (part: Buffer) => parts.push(part));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(payload);
    });

    return {
        server: name,
        decide: async (call, signal) => {
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            signal?.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => controller.abort(), deadlineMs);
            try {
                const answer = await post('/hook/pre-tool-use', {
                    tool_name: `mcp__${name}__${call.tool}`,
                    tool_input: call.args,
                    origin,
                    ...(call.toolUseId ? { tool_use_id: call.toolUseId } : {}),
                    ...(call.elementPid !== undefined ? { element_pid: call.elementPid } : {}),
                    ...(call.annotations ? { annotations: call.annotations } : {}),
                }, controller.signal);
                if (answer.status !== 200) return failClosed(`policy server answered ${answer.status}`);
                return readVerdict(answer.text);
            } catch (error) {
                return failClosed(signal?.aborted ? 'call cancelled' : controller.signal.aborted ? 'timed out waiting for a decision' : `policy server unreachable: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            }
        },
        toolsListed: (tools) => {
            post('/hook/tools-listed', {
                tools: tools.map((tool) => ({ name: `mcp__${name}__${tool.name}`, ...(tool.annotations ? { annotations: tool.annotations } : {}) })),
            }).catch(() => undefined);
        },
    };
}

function readVerdict(text: string): Exclude<HookVerdict, { kind: 'ask' }> {
    let verdict: unknown;
    try {
        verdict = JSON.parse(text);
    } catch {
        return failClosed('unreadable verdict');
    }
    const value = verdict as Partial<HookVerdict> & { reason?: unknown; reasonCode?: unknown };
    if (value.kind === 'pass' || value.kind === 'allow') return { kind: value.kind };
    if (value.kind === 'deny' && typeof value.reason === 'string') {
        return { kind: 'deny', reason: value.reason, reasonCode: typeof value.reasonCode === 'string' ? value.reasonCode : 'blocked' };
    }
    return failClosed(value.kind === 'ask' ? 'no terminal prompt on this path' : 'unknown verdict');
}

function failClosed(why: string): { kind: 'deny'; reason: string; reasonCode: string } {
    return {
        kind: 'deny',
        reasonCode: 'policy_unavailable',
        reason: `도구 정책으로 막힘: 정책 확인을 끝내지 못해 이 호출을 실행하지 않았다 (${why}). 대신: 잠시 뒤 다시 시도하거나 사용자에게 알려라. ${NO_BYPASS}`,
    };
}

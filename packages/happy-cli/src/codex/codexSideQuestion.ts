/**
 * `/btw` 곁질문 for Codex conversations (Desktop specs/codexcli-side-question).
 *
 * Codex has no tool-less fork of a live conversation, so a side question forks the session's thread
 * into an **ephemeral** thread on a **second, dedicated `codex app-server` process** and runs one turn
 * there. The session's own client is never touched: its thread id, turn id, thread defaults, approval
 * handler and rollout stay exactly as they were (R3). The dedicated process is launched with the
 * session's payer, state home and sandbox wrapper (`CodexAppServerClient.prepareSideAppServer`) but
 * never initializes or resets Happy's process-wide sandbox runtime (plan risk 0).
 *
 * Mutations are stopped by the runtime, not by the boundary text (R4):
 * - the fork is opened `sandbox: 'read-only'`, `approvalPolicy: 'never'`, and the effective sandbox in
 *   the response must be `readOnly` and the thread `ephemeral` — otherwise it is reopened once with
 *   every tool off, and failing that the question fails (R4-a);
 * - every server request (approvals, permission grants, user input, elicitation, unknown) is declined
 *   without reaching the user (R4-b);
 * - MCP servers, web search, sub-agents, hooks, plugins/apps, memories, goals, permission and
 *   user-input tools, image generation and plan updates are off in both profiles (R4-c). Codex accepts
 *   an unknown config key silently (Phase 0 A4), so the turn's items are also checked against the
 *   profile and a turn that shows a tool the profile turned off is stopped and fails.
 *
 * Phase 0 measurements (codex-cli 0.166.0, 2026-11-05): a live fork during a running turn works and
 * sees that turn up to the fork; the ephemeral fork leaves no rollout or state rows; the read-only
 * sandbox stops shell writes and apply_patch; cold start + fork + short answer p50 4.3s, ~150 MB.
 */
import { createInterface } from 'node:readline';

import { spawn as crossSpawn } from 'cross-spawn';

import { SIDE_QUESTION_MAX_CHARS, SIDE_QUESTION_TIMEOUT_MS } from '@/claude/claudeSideQuestion';
import { logger } from '@/ui/logger';
import packageJson from '../../package.json';
import type { CodexCommandLaunch } from './codexOffTurnTitle';

export type CodexSideToolProfile = 'read-only' | 'none';

export type CodexSideUsage = {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
};

/** What a side question needs from the live session, read when it is asked. Plain data: nothing here can reach the session's client. */
export type CodexSideQuestionSource = {
    threadId: string | null;
    rolloutPath: string | null;
    cwd: string;
    model: string | null;
    effort: string | null;
    /** Happy's sandbox wraps the app-server: it allows workspace writes, so only the tool-less profile is safe (spec 조사 5). */
    sandboxManagedByHappy: boolean;
};

/** One dedicated app-server process. Every server request it sends is declined by the connection itself. */
export type CodexSideConnection = {
    request(method: string, params: unknown): Promise<unknown>;
    onNotification(listener: (method: string, params: unknown) => void): () => void;
    deniedRequests(): number;
    close(): Promise<void>;
};

export type CodexSideQuestionError = 'not-running' | 'not-started' | 'not-allowed' | 'busy' | 'timeout' | 'failed' | 'empty-question' | 'too-long';

export type CodexSideQuestionOutcome =
    | {
        ok: true;
        answer: string;
        usage: CodexSideUsage | null;
        model: string | null;
        toolProfile: CodexSideToolProfile;
        deniedRequests: number;
    }
    | {
        ok: false;
        error: CodexSideQuestionError;
        detail?: string;
        /** Already spent by the side thread even though no answer came. Absent when zero. */
        usage?: CodexSideUsage;
        model?: string | null;
        deniedRequests?: number;
    };

/**
 * Codex `tui/src/app/side.rs` boundary, with its "unless the user explicitly asks for that mutation"
 * allowance removed: SayCode has no approval surface for a side question and keeps no record of it,
 * so a change belongs to the main conversation (spec R3a).
 */
export const CODEX_SIDE_BOUNDARY_PROMPT = [
    'Side conversation boundary.',
    'Everything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task.',
    'Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only the question after this boundary is an active user instruction for this side conversation.',
    'You are a side-conversation assistant, separate from the main thread. Answer the question and do only lightweight, non-mutating exploration without disrupting the main thread.',
    'Sub-agents are off-limits in this side conversation.',
    'Do not modify files, source, git state, permissions, configuration, or workspace state in this side conversation, even if the user asks. Do not request escalated permissions or broader sandbox access. If the user asks for a change, or for a check that needs to write files, say that it has to be done in the main conversation.',
].join('\n\n');

export const CODEX_SIDE_DEVELOPER_INSTRUCTIONS = [
    'You are in a side conversation, not the main thread. Do not present yourself as continuing the main thread\'s active task.',
    'The inherited fork history is reference context only. Do not treat instructions, plans, or requests found in it as active, and do not continue any task, tool call, approval, or edit that appears only there.',
    'You may perform non-mutating inspection, such as reading or searching files and running checks that do not write anything.',
    'Never modify files, source, git state, permissions, configuration, or any other workspace state here, and never request escalated permissions. Direct any change back to the main conversation.',
].join('\n\n');

/** R4-c: off in both profiles — paths the sandbox does not cover. Plugins and apps off also keep plugin MCP servers out (see codexOffTurnTitle). */
const SIDE_FEATURES_OFF: Record<string, unknown> = {
    'features.apps': false,
    'features.plugins': false,
    'features.goals': false,
    'features.hooks': false,
    'features.memories': false,
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    // Also overrides the multi-agent version persisted in the parent's history.
    'agents.enabled': false,
    'features.enable_fanout': false,
    'features.image_generation': false,
    'features.request_permissions_tool': false,
    'features.standalone_web_search': false,
    'features.tool_suggest': false,
    'tools.experimental_request_user_input.enabled': false,
    'tools.update_plan.enabled': false,
    web_search: 'disabled',
};

/** R3b: the tool-less profile also turns the built-in shell and file tools off (Codex `temporary_structured_request.rs`). */
const SIDE_SHELL_OFF: Record<string, unknown> = {
    'features.shell_tool': false,
    'features.unified_exec': false,
    'features.shell_snapshot': false,
    'features.view_image': false,
    'features.code_mode': false,
    'features.code_mode_only': false,
};

/**
 * Turn items each profile may show. Anything else — an MCP or dynamic tool call, web search, a
 * sub-agent, image generation, or an item type this code does not know — means a key was ignored,
 * and the turn is stopped (fail closed).
 */
const ALLOWED_ITEMS: Record<CodexSideToolProfile, ReadonlySet<string>> = {
    none: new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction']),
    'read-only': new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction', 'commandExecution', 'fileChange', 'imageView']),
};

const NO_ROLLOUT = /no rollout found|No such file or directory/i;
const REQUEST_TIMEOUT_MS = 30_000;
const CLEANUP_STEP_TIMEOUT_MS = 2_000;
const KILL_GRACE_MS = 2_000;

export function chooseSideToolProfile(input: {
    requested: CodexSideToolProfile | undefined;
    sandboxManagedByHappy: boolean;
    platform: NodeJS.Platform;
}): CodexSideToolProfile {
    return input.requested === 'none' || input.sandboxManagedByHappy || input.platform === 'win32' ? 'none' : 'read-only';
}

export function buildSideForkConfig(profile: CodexSideToolProfile, mcpServerNames: readonly string[]): Record<string, unknown> {
    return {
        ...SIDE_FEATURES_OFF,
        ...(profile === 'none' ? SIDE_SHELL_OFF : {}),
        mcp_servers: Object.fromEntries(mcpServerNames.map((name) => [name, { enabled: false }])),
    };
}

/** R4-b: the answer to a server request on the side connection. Nothing is approved and nothing reaches the user. */
export function declineServerRequest(method: string): { result: unknown } | { error: { code: number; message: string } } {
    switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
            return { result: { decision: 'decline' } };
        case 'execCommandApproval':
        case 'applyPatchApproval':
            return { result: { decision: 'denied' } };
        case 'item/tool/requestUserInput':
            return { result: { answers: {} } };
        case 'mcpServer/elicitation/request':
            return { result: { action: 'decline', content: null, _meta: null } };
        default:
            // Permission grants and anything unknown: an explicit refusal, never `{}`.
            return { error: { code: -32000, message: 'Declined: side questions cannot approve or answer requests' } };
    }
}

/** Effective MCP servers to disable by name. Fails (throws) when the effective config cannot be read — fail closed like Codex's own temporary thread. */
async function readMcpServerNames(connection: CodexSideConnection, cwd: string): Promise<string[]> {
    const response = await connection.request('config/read', { includeLayers: false, cwd }) as { config?: Record<string, unknown> } | null;
    const config = response?.config;
    if (!config || typeof config !== 'object') throw new Error('effective Codex config unavailable');
    const additional = config.additional as Record<string, unknown> | undefined;
    const servers = config.mcp_servers ?? additional?.mcp_servers;
    return servers && typeof servers === 'object' ? Object.keys(servers) : [];
}

/** A fork this bridge refused. `retryable`: the tool-less profile might still be confirmed (R4-a). */
class SideForkRejected extends Error {
    constructor(message: string, readonly retryable = false) { super(message); }
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function addUsage(total: CodexSideUsage | null, last: unknown): CodexSideUsage | null {
    if (!last || typeof last !== 'object') return total;
    const value = last as Partial<Record<keyof CodexSideUsage, unknown>>;
    const read = (key: keyof CodexSideUsage) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] as number : 0);
    const base = total ?? { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    return {
        totalTokens: base.totalTokens + read('totalTokens'),
        inputTokens: base.inputTokens + read('inputTokens'),
        cachedInputTokens: base.cachedInputTokens + read('cachedInputTokens'),
        cacheWriteInputTokens: base.cacheWriteInputTokens + read('cacheWriteInputTokens'),
        outputTokens: base.outputTokens + read('outputTokens'),
        reasoningOutputTokens: base.reasoningOutputTokens + read('reasoningOutputTokens'),
    };
}

export class CodexSideQuestionBridge {
    private inFlight: AbortController | null = null;

    constructor(private readonly deps: {
        source: () => CodexSideQuestionSource | null;
        /** Null when this session may not start a second Codex process (managed provider, agent plan, mandatory sandbox). */
        launch: () => Promise<CodexCommandLaunch | null>;
        connect?: (launch: CodexCommandLaunch, cwd: string) => Promise<CodexSideConnection>;
        platform?: NodeJS.Platform;
    }) {}

    /** Session shutdown: stop a pending side question so its process goes before the session's own client. */
    dispose(): void {
        this.inFlight?.abort(new Error('session ended'));
    }

    async ask(rawQuestion: string, options: { timeoutMs?: number; toolProfile?: CodexSideToolProfile } = {}): Promise<CodexSideQuestionOutcome> {
        const question = rawQuestion.trim();
        if (!question) return { ok: false, error: 'empty-question' };
        if (question.length > SIDE_QUESTION_MAX_CHARS) return { ok: false, error: 'too-long' };
        const source = this.deps.source();
        if (!source) return { ok: false, error: 'not-running' };
        if (!source.threadId) return { ok: false, error: 'not-started' };
        if (this.inFlight) return { ok: false, error: 'busy' };
        const controller = new AbortController();
        this.inFlight = controller;
        const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs ?? SIDE_QUESTION_TIMEOUT_MS);
        const spent: { usage: CodexSideUsage | null; model: string | null } = { usage: null, model: source.model };
        let connection: CodexSideConnection | null = null;
        let openTurn: { threadId: string; turnId: string | null; ended: boolean } | null = null;
        const fail = (error: CodexSideQuestionError, detail?: string): CodexSideQuestionOutcome => ({
            ok: false,
            error,
            ...(detail ? { detail } : {}),
            ...(spent.usage && spent.usage.totalTokens > 0 ? { usage: spent.usage, model: spent.model } : {}),
            ...(connection ? { deniedRequests: connection.deniedRequests() } : {}),
        });
        try {
            const launch = await this.deps.launch();
            if (!launch) return fail('not-allowed');
            const connect = this.deps.connect ?? spawnCodexSideAppServer;
            const opening = connect(launch, source.cwd);
            // A connection that finishes opening after the deadline is still closed.
            opening.then((late) => { if (controller.signal.aborted && late !== connection) void late.close(); }, () => {});
            connection = await untilAborted(opening, controller.signal);
            const live = connection;
            const mcpServerNames = await untilAborted(readMcpServerNames(live, source.cwd), controller.signal);
            let profile = chooseSideToolProfile({ requested: options.toolProfile, sandboxManagedByHappy: source.sandboxManagedByHappy, platform: this.deps.platform ?? process.platform });
            let fork: { threadId: string; model: string | null };
            try {
                fork = await untilAborted(this.openFork(live, source, profile, mcpServerNames), controller.signal);
            } catch (error) {
                // R4-a: a fork whose read-only state cannot be confirmed (or whose config Codex refused) is reopened once without tools.
                if (controller.signal.aborted || profile === 'none' || NO_ROLLOUT.test(errorText(error)) || (error instanceof SideForkRejected && !error.retryable)) throw error;
                logger.debug('[CodexSideQuestion] read-only fork not confirmed; retrying without tools:', errorText(error));
                profile = 'none';
                fork = await untilAborted(this.openFork(live, source, profile, mcpServerNames), controller.signal);
            }
            if (fork.model) spent.model = fork.model;
            const turnProfile = profile;
            const answer = await new Promise<string>((resolve, reject) => {
                const messages: { text: string; final: boolean }[] = [];
                const stop = live.onNotification((method, raw) => {
                    const params = raw as { threadId?: unknown; item?: { type?: unknown; text?: unknown; phase?: unknown }; tokenUsage?: { last?: unknown }; turn?: { id?: unknown; status?: unknown; error?: { message?: unknown } | null } } | null;
                    if (params?.threadId !== fork.threadId) return;
                    if (method === 'thread/tokenUsage/updated') {
                        // The fork's running total starts from the parent's; `last` is this thread's own response.
                        spent.usage = addUsage(spent.usage, params.tokenUsage?.last);
                        return;
                    }
                    if ((method === 'item/started' || method === 'item/completed') && typeof params.item?.type === 'string' && !ALLOWED_ITEMS[turnProfile].has(params.item.type)) {
                        stop();
                        reject(new SideForkRejected(`tool-boundary: ${params.item.type}`));
                        return;
                    }
                    if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
                        messages.push({ text: params.item.text, final: params.item.phase === 'final_answer' });
                        return;
                    }
                    if (method === 'turn/completed') {
                        stop();
                        if (openTurn) { openTurn.ended = true; openTurn.turnId = null; }
                        const status = params.turn?.status;
                        if (status !== 'completed') {
                            const message = typeof params.turn?.error?.message === 'string' ? params.turn.error.message : '';
                            reject(new Error(`side turn ${String(status)}${message ? `: ${message}` : ''}`));
                            return;
                        }
                        const chosen = [...messages].reverse().find((entry) => entry.final) ?? messages.at(-1);
                        resolve(chosen?.text.trim() ?? '');
                    }
                });
                controller.signal.addEventListener('abort', () => { stop(); reject(controller.signal.reason); }, { once: true });
                openTurn = { threadId: fork.threadId, turnId: null, ended: false };
                live.request('turn/start', {
                    threadId: fork.threadId,
                    input: [{ type: 'text', text: `${CODEX_SIDE_BOUNDARY_PROMPT}\n\n${question}`, text_elements: [] }],
                    ...(source.effort ? { effort: source.effort } : {}),
                }).then((started) => {
                    const turnId = (started as { turn?: { id?: unknown } } | null)?.turn?.id;
                    // The turn can complete before its own start reply arrives: an ended turn needs no interrupt.
                    if (openTurn && !openTurn.ended && typeof turnId === 'string') openTurn.turnId = turnId;
                }, (error) => { stop(); reject(error); });
            });
            if (!answer) return fail('failed', 'empty side question answer');
            return { ok: true, answer, usage: spent.usage, model: spent.model, toolProfile: profile, deniedRequests: live.deniedRequests() };
        } catch (error) {
            if (controller.signal.aborted) {
                const reason = errorText(controller.signal.reason);
                return reason === 'timeout' ? fail('timeout') : fail('failed', reason);
            }
            if (NO_ROLLOUT.test(errorText(error))) return fail('not-started');
            return fail('failed', errorText(error));
        } finally {
            clearTimeout(timer);
            if (connection) await closeSideConnection(connection, openTurn);
            this.inFlight = null;
        }
    }

    private async openFork(connection: CodexSideConnection, source: CodexSideQuestionSource, profile: CodexSideToolProfile, mcpServerNames: readonly string[]): Promise<{ threadId: string; model: string | null }> {
        const response = await connection.request('thread/fork', {
            threadId: source.threadId,
            ...(source.rolloutPath ? { path: source.rolloutPath } : {}),
            cwd: source.cwd,
            model: source.model,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            config: buildSideForkConfig(profile, mcpServerNames),
            developerInstructions: CODEX_SIDE_DEVELOPER_INSTRUCTIONS,
            ephemeral: true,
            excludeTurns: true,
        }) as { thread?: { id?: unknown; ephemeral?: unknown }; sandbox?: { type?: unknown }; model?: unknown } | null;
        const threadId = response?.thread?.id;
        if (typeof threadId !== 'string' || !threadId) throw new SideForkRejected('fork returned no thread');
        if (response?.thread?.ephemeral !== true) {
            // A persisted fork cannot be taken back: it is not a profile problem, so no retry either.
            throw new SideForkRejected('fork is not ephemeral');
        }
        if (response?.sandbox?.type !== 'readOnly') {
            await connection.request('thread/unsubscribe', { threadId }).catch(() => undefined);
            throw new SideForkRejected(`fork sandbox is ${String(response?.sandbox?.type)}`, true);
        }
        return { threadId, model: typeof response.model === 'string' ? response.model : null };
    }
}

/** R5: interrupt an open turn, unsubscribe, then end the process. Each step is bounded; the process goes regardless. */
async function closeSideConnection(connection: CodexSideConnection, openTurn: { threadId: string; turnId: string | null; ended: boolean } | null): Promise<void> {
    const bounded = (work: Promise<unknown>) => Promise.race([work.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, CLEANUP_STEP_TIMEOUT_MS).unref?.())]);
    if (openTurn?.turnId) await bounded(connection.request('turn/interrupt', { threadId: openTurn.threadId, turnId: openTurn.turnId }));
    if (openTurn) await bounded(connection.request('thread/unsubscribe', { threadId: openTurn.threadId }));
    await connection.close().catch((error) => logger.debug('[CodexSideQuestion] close failed:', error));
}

/** The dedicated `codex app-server` for one side question. */
export async function spawnCodexSideAppServer(launch: CodexCommandLaunch, cwd: string): Promise<CodexSideConnection> {
    const child = crossSpawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const listeners = new Set<(method: string, params: unknown) => void>();
    let nextId = 1;
    let denied = 0;
    let exited = false;
    const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const write = (message: unknown) => { if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`); };
    // A process that dies mid-write fails the pipe with EPIPE; unhandled it would take the session down.
    child.stdin?.on('error', () => {});
    child.on('error', (error) => logger.debug('[CodexSideQuestion] process error:', error));
    child.stderr?.on('data', () => {});
    void exit.then(() => {
        exited = true;
        for (const [id, request] of pending) { clearTimeout(request.timer); request.reject(new Error('side Codex process exited')); pending.delete(id); }
    });
    createInterface({ input: child.stdout! }).on('line', (line) => {
        let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { return; }
        if (message.method && message.id !== undefined) {
            denied += 1;
            logger.debug(`[CodexSideQuestion] declined server request ${message.method}`);
            write({ id: message.id, ...declineServerRequest(message.method) });
            return;
        }
        if (message.id !== undefined) {
            const request = pending.get(Number(message.id));
            if (!request) return;
            pending.delete(Number(message.id));
            clearTimeout(request.timer);
            if (message.error) request.reject(new Error(message.error.message ?? 'Codex request failed'));
            else request.resolve(message.result);
            return;
        }
        if (message.method) for (const listener of [...listeners]) listener(message.method, message.params);
    });
    const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
        if (exited) { reject(new Error('side Codex process exited')); return; }
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params });
    });
    const close = async () => {
        if (exited) return;
        child.stdin?.end();
        child.kill('SIGTERM');
        const kill = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, KILL_GRACE_MS);
        kill.unref?.();
        await exit;
        clearTimeout(kill);
    };
    try {
        await request('initialize', {
            clientInfo: { name: 'happy-codex-side', title: 'Happy Codex Side Question', version: packageJson.version },
            capabilities: { experimentalApi: true },
        });
        write({ method: 'initialized' });
    } catch (error) {
        await close();
        throw error;
    }
    return {
        request,
        onNotification: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        deniedRequests: () => denied,
        close,
    };
}

/** Session RPC `side-question` reply. Same fields as the Claude reply plus the optional `toolProfile`/`deniedRequests` (R7). */
export type CodexSideQuestionRpcReply =
    | {
        success: true;
        answer: string;
        synthetic: false;
        usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null;
        usageQuality: 'exact' | null;
        model: string | null;
        toolProfile: CodexSideToolProfile;
        deniedRequests: number;
    }
    | { success: false; error: string };

type DrainGate = { isClosed(): boolean; admit<T>(work: () => Promise<T>, kind?: 'input' | 'writer'): Promise<T> };

export function createCodexSideQuestionRpcHandler(deps: {
    bridge: Pick<CodexSideQuestionBridge, 'ask'>;
    isManagedRun: () => boolean;
    gate: () => DrainGate | undefined;
    reportUsage: (input: { requestId: string; usage: CodexSideUsage; model: string | null }) => void;
    newRequestId: () => string;
    timeoutMs?: number;
}): (params: Record<string, unknown>) => Promise<CodexSideQuestionRpcReply> {
    const fail = (code: CodexSideQuestionError | 'managed-run' | 'shutting-down', detail?: string): CodexSideQuestionRpcReply =>
        ({ success: false, error: `side-question:${code}${detail ? `: ${detail}` : ''}` });
    return async (params) => {
        // A managed run answers exactly the prompt its envelope admitted (same rule as `steer`).
        if (deps.isManagedRun()) return fail('managed-run');
        const question = typeof params?.question === 'string' ? params.question : '';
        const toolProfile = params?.toolProfile === 'none' ? 'none' as const : undefined;
        const gate = deps.gate();
        if (gate?.isClosed()) return fail('shutting-down');
        const run = async (): Promise<CodexSideQuestionRpcReply> => {
            const outcome = await deps.bridge.ask(question, { timeoutMs: deps.timeoutMs, toolProfile });
            // A different thread from the conversation's, so nothing overlaps: exact, and reported even on failure (R8).
            if (outcome.usage && outcome.usage.totalTokens > 0) {
                deps.reportUsage({ requestId: deps.newRequestId(), usage: outcome.usage, model: outcome.model ?? null });
            }
            if (!outcome.ok) return fail(outcome.error, outcome.detail);
            const usage = outcome.usage;
            return {
                success: true,
                answer: outcome.answer,
                synthetic: false,
                usage: usage ? {
                    input: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
                    output: usage.outputTokens,
                    cacheRead: usage.cachedInputTokens,
                    cacheWrite: usage.cacheWriteInputTokens,
                    total: usage.totalTokens,
                } : null,
                usageQuality: usage ? 'exact' : null,
                model: outcome.model,
                toolProfile: outcome.toolProfile,
                deniedRequests: outcome.deniedRequests,
            };
        };
        // A writer: it adds no input to the conversation, so it must not hold off a drain.
        return gate ? gate.admit(run, 'writer') : run();
    };
}

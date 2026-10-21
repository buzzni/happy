/**
 * Dedicated HTTP server for receiving Claude session hooks
 * 
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook.
 * 
 * Separate from the MCP server to keep concerns isolated.
 * 
 * ## Control Flow
 * 
 * ### Startup
 * ```
 * runClaude.ts                                  
 *     │                                         
 *     ├─► startHookServer() ──► HTTP server on random port (e.g., 52290)
 *     │                                         
 *     ├─► generateHookSettingsFile(port) ──► ~/.happy/tmp/hooks/session-hook-<pid>.json
 *     │   (contains SessionStart hook pointing to our server)
 *     │                                         
 *     └─► loop() ──► claudeLocal/claudeRemote
 *             │
 *             └─► spawn claude --settings <hook-settings-path>
 * ```
 * 
 * ### Session Notification Flow
 * ```
 * Claude CLI (SessionStart event)
 *     │
 *     ├─► Reads hooks from --settings file
 *     │
 *     └─► Executes hook command (session_hook_forwarder.cjs)
 *             │
 *             ├─► Receives session data on stdin
 *             │
 *             └─► HTTP POST to http://127.0.0.1:<port>/hook/session-start
 *                     │
 *                     └─► startHookServer receives it
 *                             │
 *                             └─► onSessionHook(sessionId, data)
 *                                     │
 *                                     ├─► Updates Session.sessionId
 *                                     ├─► Updates API metadata
 *                                     └─► Notifies SessionScanner
 * ```
 * 
 * ### Triggered By
 * - `happy` (fresh start) - new session created
 * - `happy --continue` - continues last session (may fork)
 * - `happy --resume` - interactive picker, then resume
 * - `happy --resume <id>` - resume specific session
 * - `/compact` command - compacts and forks session
 * - Double-escape fork - user forks conversation in CLI
 * 
 * ### Why Not Use File Watching?
 * File watching has race conditions when multiple Happy processes run.
 * With hooks, Claude directly tells THIS specific process about its session,
 * ensuring 1:1 mapping between Happy process and Claude session.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { ListedTool } from '@/toolPolicy/evaluate';
import type { HookVerdict, PreToolUseCall } from '@/toolPolicy/policyGate';

/** Header carrying the per-process secret the policy hook script reads from its 0600 file. */
export const PRE_TOOL_USE_SECRET_HEADER = 'x-happy-hook-secret';

/**
 * Data received from Claude's SessionStart hook
 */
export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    [key: string]: unknown;
}

export interface HookServerOptions {
    /** Called when a session hook is received with a valid session ID */
    onSessionHook: (sessionId: string, data: SessionHookData) => void;
    /**
     * Tool policy (aplus-dev-studio specs/agent-tool-policy). The response is held until the
     * decision is final — for `ask` that is a person's answer — and the decision is aborted when
     * the hook process goes away.
     */
    preToolUse?: {
        secret: string;
        decide: (call: PreToolUseCall, signal: AbortSignal) => Promise<HookVerdict>;
        /** R9: the cua-driver shadow proxy and the stdio bridge report what their server lists. */
        toolsListed?: (tools: ListedTool[]) => void;
    };
}

export interface HookServer {
    /** The port the server is listening on */
    port: number;
    /** Stop the server */
    stop: () => void;
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks
 * 
 * @param options - Server options including the session hook callback
 * @returns Promise resolving to the server instance with port info
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    const { onSessionHook, preToolUse } = options;

    return new Promise((resolve, reject) => {
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            // Only handle POST to /hook/session-start
            if (req.method === 'POST' && req.url === '/hook/session-start') {
                // Set timeout to prevent hanging if Claude doesn't close stdin
                const timeout = setTimeout(() => {
                    if (!res.headersSent) {
                        logger.debug('[hookServer] Request timeout');
                        res.writeHead(408).end('timeout');
                    }
                }, 5000);

                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) {
                        chunks.push(chunk as Buffer);
                    }
                    clearTimeout(timeout);
                    
                    const body = Buffer.concat(chunks).toString('utf-8');
                    logger.debug('[hookServer] Received session hook:', body);

                    let data: SessionHookData = {};
                    try {
                        data = JSON.parse(body);
                    } catch (parseError) {
                        logger.debug('[hookServer] Failed to parse hook data as JSON:', parseError);
                    }

                    // Support both snake_case (from Claude) and camelCase
                    const sessionId = data.session_id || data.sessionId;
                    if (sessionId) {
                        logger.debug(`[hookServer] Session hook received session ID: ${sessionId}`);
                        onSessionHook(sessionId, data);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                    }

                    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                } catch (error) {
                    clearTimeout(timeout);
                    logger.debug('[hookServer] Error handling session hook:', error);
                    if (!res.headersSent) {
                        res.writeHead(500).end('error');
                    }
                }
                return;
            }

            if (req.method === 'POST' && req.url === '/hook/pre-tool-use' && preToolUse) {
                await handlePreToolUse(req, res, preToolUse);
                return;
            }

            if (req.method === 'POST' && req.url === '/hook/tools-listed' && preToolUse) {
                await handleToolsListed(req, res, preToolUse);
                return;
            }

            // 404 for anything else
            res.writeHead(404).end('not found');
        });

        // Listen on random available port
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }

            const port = address.port;
            logger.debug(`[hookServer] Started on port ${port}`);

            resolve({
                port,
                stop: () => {
                    server.close();
                    logger.debug('[hookServer] Stopped');
                }
            });
        });

        server.on('error', (err) => {
            logger.debug('[hookServer] Server error:', err);
            reject(err);
        });
    });
}


/**
 * Every refusal here is a 4xx/5xx, which the hook script turns into `deny` + exit 2: no answer
 * from this server ever lets a tool call through.
 */
async function handlePreToolUse(
    req: IncomingMessage,
    res: ServerResponse,
    preToolUse: NonNullable<HookServerOptions['preToolUse']>,
): Promise<void> {
    const presented = req.headers[PRE_TOOL_USE_SECRET_HEADER];
    if (typeof presented !== 'string' || !secretMatches(presented, preToolUse.secret)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    const controller = new AbortController();
    // The hook process was killed or timed out: nobody will read the answer, so stop waiting.
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const data = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
        if (typeof data.tool_name !== 'string') {
            res.writeHead(400).end('missing tool_name');
            return;
        }
        const annotations = readAnnotations(data.annotations);
        const verdict = await preToolUse.decide({
            toolName: data.tool_name,
            toolInput: data.tool_input,
            toolUseId: typeof data.tool_use_id === 'string' ? data.tool_use_id : undefined,
            // Only the proxy and the bridge send these; the Claude hook payload never has them.
            ...(data.origin === 'cua-proxy' || data.origin === 'bridge' ? { origin: data.origin } : {}),
            ...(Number.isInteger(data.element_pid) ? { elementPid: data.element_pid as number } : {}),
            ...(typeof data.permission_mode === 'string' ? { permissionMode: data.permission_mode } : {}),
            ...(annotations ? { annotations } : {}),
        }, controller.signal);
        if (!res.writableEnded && !res.destroyed) {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(verdict));
        }
    } catch (error) {
        logger.debug('[hookServer] pre-tool-use failed:', error);
        if (!res.headersSent) res.writeHead(500).end('error');
    }
}

async function handleToolsListed(
    req: IncomingMessage,
    res: ServerResponse,
    preToolUse: NonNullable<HookServerOptions['preToolUse']>,
): Promise<void> {
    const presented = req.headers[PRE_TOOL_USE_SECRET_HEADER];
    if (typeof presented !== 'string' || !secretMatches(presented, preToolUse.secret)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const data = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { tools?: unknown };
        const tools: ListedTool[] = [];
        for (const tool of Array.isArray(data.tools) ? data.tools : []) {
            if (typeof tool?.name !== 'string') continue;
            const annotations = readAnnotations(tool.annotations);
            tools.push({ name: tool.name, ...(annotations ? { annotations } : {}) });
        }
        preToolUse.toolsListed?.(tools);
        res.writeHead(204).end();
    } catch (error) {
        logger.debug('[hookServer] tools-listed failed:', error);
        if (!res.headersSent) res.writeHead(400).end('bad request');
    }
}

function readAnnotations(value: unknown): PreToolUseCall['annotations'] | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const { readOnlyHint, destructiveHint } = value as Record<string, unknown>;
    return {
        ...(typeof readOnlyHint === 'boolean' ? { readOnlyHint } : {}),
        ...(typeof destructiveHint === 'boolean' ? { destructiveHint } : {}),
    };
}

function secretMatches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

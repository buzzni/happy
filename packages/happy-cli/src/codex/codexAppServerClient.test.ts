import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';

const {
    mockExecSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        kill: vi.fn(),
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        mockExecSync.mockReturnValue('codex-cli 0.107.0');
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
    });

    it('reports goal action support for Codex versions with goal action requests', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');

        mockExecSync.mockReturnValue('codex-cli 0.140.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(true);

        mockExecSync.mockReturnValue('codex-cli 0.130.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(false);
    });

    it('wraps transport when sandbox is enabled', async () => {
        // Dynamic import to ensure mocks are applied
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd());
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
        expect(mockSpawn).toHaveBeenCalledWith(
            'sh',
            ['-c', 'wrapped codex app-server'],
            expect.objectContaining({
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);

        await client.disconnect();
    });

    it('falls back to non-sandbox transport when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(false);

        await client.disconnect();
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('reconnects and resumes the same thread after forced restart timeout', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-1' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-2' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_complete', turn_id: 'turn-2' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever', { turnTimeoutMs: 5000 });
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            reason: 'interrupted',
            turn_id: 'turn-1',
            forced_restart: true,
        }));

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        }));
        expect(client.threadId).toBe('thread-1');

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('keeps an active turn alive when provider progress resets the inactivity timeout', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2003,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-timeout', path: '/tmp/thread-timeout' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-timeout', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-timeout',
                                turn: { id: 'turn-timeout', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('long active turn', { turnTimeoutMs: 200 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await vi.advanceTimersByTimeAsync(120);
            pushJsonLine(appServerStdout, {
                method: 'item/started',
                params: {
                    threadId: 'thread-timeout',
                    turnId: 'turn-timeout',
                    item: { id: 'item-progress', type: 'agentMessage', text: '', phase: 'commentary' },
                },
            });
            await vi.advanceTimersByTimeAsync(120);
            pushJsonLine(appServerStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-timeout',
                    turn: { id: 'turn-timeout', items: [], status: 'completed', error: null },
                },
            });

            await expect(pending).resolves.toEqual({ aborted: false });
            expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);
            expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('ignores stale-turn activity and interrupts the inactive current provider turn', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2004,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-inactive', path: '/tmp/thread-inactive' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-inactive', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-inactive',
                                turn: { id: 'turn-inactive', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-inactive',
                                turn: { id: 'turn-inactive', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await vi.advanceTimersByTimeAsync(15);
            pushJsonLine(appServerStdout, {
                method: 'item/started',
                params: {
                    threadId: 'thread-inactive',
                    turnId: 'turn-from-previous-request',
                    item: { id: 'stale-item', type: 'agentMessage', text: '', phase: 'commentary' },
                },
            });
            await vi.advanceTimersByTimeAsync(6);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            expect(events.filter((event) => event.type === 'turn_aborted')).toEqual([
                expect.objectContaining({ turn_id: 'turn-inactive', status: 'cancelled' }),
            ]);
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags a watchdog-forced abort with the inactivity reason and the not-ready MCP servers', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2014,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-hung', path: '/tmp/thread-hung' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-hung', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-hung',
                                turn: { id: 'turn-hung', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-hung',
                                turn: { id: 'turn-hung', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        // One server never finished starting; another is fine. Only the hung one
        // should be surfaced to the user.
        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-hung', name: 'aplus-common', status: 'ready' },
        });
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-hung', name: 'dataAnalyticsWidgets', status: 'starting' },
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            // Provider goes fully silent — the watchdog must fire.
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).toMatchObject({
                turn_id: 'turn-hung',
                reason: 'inactivity_timeout',
                not_ready_mcp_servers: ['dataAnalyticsWidgets'],
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags the completion with the inactivity reason even when codex settles the interrupted turn as completed', async () => {
        // Replays the real incident: codex answered the watchdog's turn/interrupt
        // with turn/completed status 'completed' (not 'cancelled'), so the abort
        // surfaced as task_complete and the user saw nothing.
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2015,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-done', path: '/tmp/thread-done' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-done', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-done',
                                turn: { id: 'turn-done', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-done',
                                turn: { id: 'turn-done', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: false });
            const terminalEvents = events.filter((event) =>
                event.type === 'task_complete' || event.type === 'turn_aborted');
            expect(terminalEvents).toHaveLength(1);
            expect(terminalEvents[0]).toMatchObject({
                type: 'task_complete',
                turn_id: 'turn-done',
                reason: 'inactivity_timeout',
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('does not tag a user-initiated abort as inactivity even when the watchdog deadline passes mid-abort', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2016,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-cancel', path: '/tmp/thread-cancel' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-cancel', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-cancel',
                                turn: { id: 'turn-cancel', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    // The provider takes 30ms to honor the user's interrupt — long
                    // enough for the 20ms inactivity deadline to pass mid-abort.
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-cancel',
                                turn: { id: 'turn-cancel', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 30);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(10);
            // User cancels before the watchdog deadline.
            const abortPromise = client.abortTurnWithFallback({ gracePeriodMs: 100 });
            await vi.advanceTimersByTimeAsync(40);

            await expect(abortPromise).resolves.toMatchObject({ aborted: true });
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).not.toHaveProperty('reason', 'inactivity_timeout');
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('tags a watchdog abort delivered via the legacy codex/event protocol', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2017,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-legacy', path: '/tmp/thread-legacy' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-legacy', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-legacy' } },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'turn_aborted', turn_id: 'turn-legacy' } },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        if (!appServerStdout) throw new Error('app-server stdout unavailable');
        pushJsonLine(appServerStdout, {
            method: 'mcpServer/startupStatus/updated',
            params: { threadId: 'thread-legacy', name: 'dataAnalyticsWidgets', status: 'starting' },
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
            const abortEvents = events.filter((event) => event.type === 'turn_aborted');
            expect(abortEvents).toHaveLength(1);
            expect(abortEvents[0]).toMatchObject({
                reason: 'inactivity_timeout',
                not_ready_mcp_servers: ['dataAnalyticsWidgets'],
            });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('keeps an active turn alive while an approval request awaits the user', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2005,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-approval', path: '/tmp/thread-approval' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-approval', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-approval',
                                turn: { id: 'turn-approval', items: [], status: 'inProgress', error: null },
                            },
                        });
                        // Codex asks the user to approve a command and then goes
                        // silent until we answer — no turn notifications arrive.
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-approval',
                                turnId: 'turn-approval',
                                itemId: 'exec-approval-1',
                                command: 'rm -rf build',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        // Held by the approval handler so the test controls when the user answers.
        let approveUser: () => void = () => { throw new Error('approval not requested yet'); };
        const approvalRequested = new Promise<void>((resolveRequested) => {
            client.setApprovalHandler(async () => {
                await new Promise<void>((resolveDecision) => {
                    approveUser = resolveDecision;
                    resolveRequested();
                });
                return 'approved';
            });
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('needs approval', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await approvalRequested;

            // The provider is blocked on us, not hung — the watchdog must not fire
            // no matter how long the user takes to answer.
            await vi.advanceTimersByTimeAsync(500);
            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
            expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(0);

            approveUser();
            await vi.advanceTimersByTimeAsync(0);
            pushJsonLine(appServerStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-approval',
                    turn: { id: 'turn-approval', items: [], status: 'completed', error: null },
                },
            });

            await expect(pending).resolves.toEqual({ aborted: false });
            expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('resumes the inactivity watchdog after an approval is answered', async () => {
        const requests: MockRpcMessage[] = [];
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 2006,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-after-approval', path: '/tmp/thread-after-approval' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-after-approval', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-after-approval',
                                turn: { id: 'turn-after-approval', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 78,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-after-approval',
                                turnId: 'turn-after-approval',
                                itemId: 'exec-approval-2',
                                command: 'sleep 600',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-after-approval',
                                turn: { id: 'turn-after-approval', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        const approvalRequested = new Promise<void>((resolveRequested) => {
            client.setApprovalHandler(async () => {
                resolveRequested();
                return 'approved';
            });
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('approve then hang', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            if (!appServerStdout) throw new Error('app-server stdout unavailable');
            await approvalRequested;
            await vi.advanceTimersByTimeAsync(0);

            // Approval answered and the provider still goes silent — the watchdog
            // must re-arm and interrupt the genuinely stuck turn.
            await vi.advanceTimersByTimeAsync(25);

            expect(requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
        } finally {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('ignores an approval completion from a disconnected app-server epoch', async () => {
        const secondProcessRequests: MockRpcMessage[] = [];
        let secondStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;

        const proc1 = createMockProcess({
            pid: 2007,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-epoch', path: '/tmp/thread-epoch' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-old', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-epoch',
                                turn: { id: 'turn-old', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-epoch',
                                turnId: 'turn-old',
                                itemId: 'old-approval',
                                command: 'old command',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2008,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                secondStdout = stdout;
                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-epoch', path: '/tmp/thread-epoch' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-new', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-epoch',
                                turn: { id: 'turn-new', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 88,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-epoch',
                                turnId: 'turn-new',
                                itemId: 'new-approval',
                                command: 'new command',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let releaseOldApproval!: () => void;
        let releaseNewApproval!: () => void;
        let markOldApprovalRequested!: () => void;
        let markNewApprovalRequested!: () => void;
        const oldApprovalDecision = new Promise<void>((resolve) => { releaseOldApproval = resolve; });
        const newApprovalDecision = new Promise<void>((resolve) => { releaseNewApproval = resolve; });
        const oldApprovalRequested = new Promise<void>((resolve) => { markOldApprovalRequested = resolve; });
        const newApprovalRequested = new Promise<void>((resolve) => { markNewApprovalRequested = resolve; });
        client.setApprovalHandler(async ({ callId }) => {
            if (callId === 'old-approval') {
                markOldApprovalRequested();
                await oldApprovalDecision;
                return 'approved';
            }
            markNewApprovalRequested();
            await newApprovalDecision;
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        const oldPending = client.sendTurnAndWait('old turn', { turnTimeoutMs: 60_000 });
        await oldApprovalRequested;
        await expect(client.reconnectAndResumeThread()).resolves.toBe(true);
        await expect(oldPending).resolves.toEqual({ aborted: true });

        vi.useFakeTimers();
        try {
            const newPending = client.sendTurnAndWait('new turn', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await newApprovalRequested;

            releaseOldApproval();
            await vi.advanceTimersByTimeAsync(0);

            expect(secondProcessRequests.some((request) => request.id === 77 && request.result !== undefined)).toBe(false);
            await vi.advanceTimersByTimeAsync(25);
            expect(secondProcessRequests.some((request) => request.method === 'turn/interrupt')).toBe(false);

            releaseNewApproval();
            await vi.advanceTimersByTimeAsync(0);
            if (!secondStdout) throw new Error('second app-server stdout unavailable');
            pushJsonLine(secondStdout, {
                method: 'turn/completed',
                params: {
                    threadId: 'thread-epoch',
                    turn: { id: 'turn-new', items: [], status: 'completed', error: null },
                },
            });
            await expect(newPending).resolves.toEqual({ aborted: false });
        } finally {
            releaseOldApproval();
            releaseNewApproval();
            await vi.advanceTimersByTimeAsync(0);
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('re-arms the watchdog for a turn started after a crash left an approval outstanding', async () => {
        const secondProcessRequests: MockRpcMessage[] = [];
        const proc1 = createMockProcess({
            pid: 2009,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-crash', path: '/tmp/thread-crash' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'on-request',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-crash', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-crash',
                                turnId: 'turn-crash',
                                itemId: 'crash-approval',
                                command: 'never answered',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2010,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);
                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { turn: { id: 'turn-after-crash', items: [], status: 'inProgress', error: null } },
                    }), 0);
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-crash',
                                turn: { id: 'turn-after-crash', items: [], status: 'cancelled', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let releaseApproval!: () => void;
        let markApprovalRequested!: () => void;
        const approvalDecision = new Promise<void>((resolve) => { releaseApproval = resolve; });
        const approvalRequested = new Promise<void>((resolve) => { markApprovalRequested = resolve; });
        client.setApprovalHandler(async () => {
            markApprovalRequested();
            await approvalDecision;
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'danger-full-access',
        });

        const crashedTurn = client.sendTurnAndWait('crashes mid-approval', { turnTimeoutMs: 60_000 });
        await approvalRequested;

        // The app-server dies while the approval is still outstanding, so
        // disconnectInternal never runs to clear the outstanding-request count.
        proc1.emit('exit', 1, null);
        await expect(crashedTurn).resolves.toEqual({ aborted: true });
        await client.connect();

        vi.useFakeTimers();
        try {
            const pending = client.sendTurnAndWait('after crash', { turnTimeoutMs: 20 });
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(25);

            expect(secondProcessRequests.some((request) => request.method === 'turn/interrupt')).toBe(true);
            await expect(pending).resolves.toEqual({ aborted: true });
        } finally {
            releaseApproval();
            await vi.advanceTimersByTimeAsync(0);
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('forks, reads, and rolls back Codex threads through app-server RPC', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2501,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/fork' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    path: '/tmp/thread-forked',
                                    forkedFromId: 'thread-source',
                                    turns: [],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/rollback' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/inject_items' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {},
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        const forked = await client.forkThread({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
        const read = await client.readThread({ threadId: forked.threadId, includeTurns: true });
        const rolledBack = await client.rollbackThread({ threadId: forked.threadId, numTurns: 2 });
        const injected = await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        expect(forked.threadId).toBe('thread-forked');
        expect(read.thread.turns).toHaveLength(1);
        expect(rolledBack.thread.turns).toHaveLength(1);
        expect(injected).toEqual({});
        expect(requests.find((msg) => msg.method === 'thread/fork')?.params).toEqual(expect.objectContaining({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        }));
        expect(requests.find((msg) => msg.method === 'thread/read')?.params).toEqual({
            threadId: 'thread-forked',
            includeTurns: true,
        });
        expect(requests.find((msg) => msg.method === 'thread/rollback')?.params).toEqual({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(requests.find((msg) => msg.method === 'thread/inject_items')?.params).toEqual({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        await client.disconnect();
    });

    it('clears active thread state so the next prompt starts a fresh thread', async () => {
        const requests: MockRpcMessage[] = [];
        let nextThreadNumber = 1;
        const proc = createMockProcess({
            pid: 2601,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    const threadId = `thread-${nextThreadNumber++}`;
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: threadId, path: `/tmp/${threadId}` },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-1');
        expect(client.hasActiveThread()).toBe(true);

        client.clearThreadState();

        expect(client.threadId).toBeNull();
        expect(client.turnId).toBeNull();
        expect(client.hasActiveThread()).toBe(false);

        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-2');
        expect(requests.filter((msg) => msg.method === 'thread/start')).toHaveLength(2);

        await client.disconnect();
    });

    it('sends extra localImage input items and omits empty text for image-only turns', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2801,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-images', path: '/tmp/thread-images' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-images',
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('', {
            extraInputItems: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-images',
            input: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        await client.disconnect();
    });

    it('keeps text-only turn input unchanged when no extra input items are supplied', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2802,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-text', path: '/tmp/thread-text' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-text',
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('hello');

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-text',
            input: [{ type: 'text', text: 'hello' }],
        });

        await client.disconnect();
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'call-1', output: '/tmp/project\n' }),
            expect.objectContaining({ type: 'agent_message', message: 'done' }),
        ]));
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('keeps waiting for the root turn when nested turn lifecycle events interleave', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3008,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-root', path: '/tmp/thread-root' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-root',
                                turn: { id: 'turn-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const pending = client.sendTurnAndWait('root request').finally(() => {
            settled = true;
        });
        await waitFor(() => events.some((event) => event.type === 'task_started' && event.turn_id === 'turn-root'));
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'turn/started',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-nested', items: [], status: 'inProgress', error: null },
            },
        });
        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-nested', items: [], status: 'completed', error: null },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_started')).toEqual([
            expect.objectContaining({ turn_id: 'turn-root' }),
        ]);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(appServerStdout, {
            method: 'item/completed',
            params: {
                threadId: 'thread-root',
                turnId: 'turn-root',
                item: {
                    type: 'agentMessage',
                    id: 'msg-root',
                    text: 'root done',
                    phase: 'final_answer',
                },
            },
        });

        await expect(pending).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toEqual([
            expect.objectContaining({ turn_id: 'turn-root' }),
        ]);

        pushJsonLine(appServerStdout, {
            method: 'turn/completed',
            params: {
                threadId: 'thread-root',
                turn: { id: 'turn-root', items: [], status: 'completed', error: null },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('keeps waiting for the root turn when legacy nested lifecycle events interleave', async () => {
        let appServerStdout: (NodeJS.ReadableStream & { push: (chunk: string) => void }) | null = null;
        const proc = createMockProcess({
            pid: 3009,
            onRequest: (msg, stdout) => {
                appServerStdout = stdout;
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-legacy-root', path: '/tmp/thread-legacy-root' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-legacy-root', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-legacy-root' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        let settled = false;
        const pending = client.sendTurnAndWait('root request').finally(() => {
            settled = true;
        });
        await waitFor(() => events.some((event) => event.type === 'task_started'));
        if (!appServerStdout) throw new Error('app-server stdout unavailable');

        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_started', turn_id: 'turn-legacy-nested' } },
        });
        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_complete', turn_id: 'turn-legacy-nested' } },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(settled).toBe(false);
        expect(events.filter((event) => event.type === 'task_started')).toEqual([
            expect.objectContaining({ turn_id: 'turn-legacy-root' }),
        ]);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);

        pushJsonLine(appServerStdout, {
            method: 'codex/event',
            params: { msg: { type: 'task_complete', turn_id: 'turn-legacy-root' } },
        });

        await expect(pending).resolves.toEqual({ aborted: false });
        expect(events.filter((event) => event.type === 'task_complete')).toEqual([
            expect.objectContaining({ turn_id: 'turn-legacy-root' }),
        ]);

        await client.disconnect();
    });

    it('maps raw goal notifications into legacy goal events', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-goal-1', path: '/tmp/thread-goal-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/updated',
                            params: {
                                threadId: 'thread-goal-1',
                                turnId: 'turn-goal-1',
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: 'finish the task',
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 11,
                                    timeUsedSeconds: 3,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680003,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/cleared',
                            params: { threadId: 'thread-goal-1' },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await waitFor(() => events.some((event) => event.type === 'thread_goal_cleared'));

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'thread_goal_updated',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
                turn_id: 'turn-goal-1',
                turnId: 'turn-goal-1',
                goal: expect.objectContaining({
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                    status: 'active',
                }),
            }),
            expect.objectContaining({
                type: 'thread_goal_cleared',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
            }),
        ]));

        await client.disconnect();
    });

    it('sends goal set and clear requests through app-server', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/goal/set' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: msg.params?.objective,
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 0,
                                    timeUsedSeconds: 0,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680001,
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/goal/clear' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { cleared: true },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await expect(client.setGoal({
            threadId: 'thread-goal-1',
            objective: 'finish the task',
        })).resolves.toMatchObject({
            goal: {
                threadId: 'thread-goal-1',
                objective: 'finish the task',
                status: 'active',
            },
        });
        await expect(client.clearGoal({
            threadId: 'thread-goal-1',
        })).resolves.toEqual({ cleared: true });

        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                },
            }),
            expect.objectContaining({
                method: 'thread/goal/clear',
                params: {
                    threadId: 'thread-goal-1',
                },
            }),
        ]));

        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                    'MONETIZATION.md': {
                        kind: { type: 'add', move_path: null },
                        add: { content: '# Monetization\n\nPaid plans.\n' },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates v2 file change approvals from raw item metadata', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'patch-approval-1',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    it('falls back to final answer completion when raw turn/completed is missing', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-2', path: '/tmp/thread-raw-2' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-2',
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-2',
                                    text: 'still works',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('say hi')).resolves.toEqual({ aborted: false });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-2' }),
            expect.objectContaining({ type: 'agent_message', message: 'still works' }),
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-2' }),
        ]));

        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'happy',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the happy MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'happy:77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'happy',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });
});

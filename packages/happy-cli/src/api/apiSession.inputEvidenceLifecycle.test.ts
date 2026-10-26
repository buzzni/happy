/** T2RT-17/18: real remote loop, ordered SDK delivery and JSONL scanner consumption. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionEnvelopeSchema, type SessionEnvelope } from '@slopus/happy-wire';
import { ApiSessionClient } from './apiSession';
import type { Metadata, Update } from './types';
import { encodeBase64, encrypt } from './encryption';
import type { ClaudeSessionProtocolState } from '@/claude/utils/sessionProtocolMapper';
import { observeFollowupTurn } from '@/daemon/automations/sessionFollowupRunner';
import { claudeRemote } from '@/claude/claudeRemote';
import { query } from '@/claude/sdk';
import { OutgoingMessageQueue } from '@/claude/utils/OutgoingMessageQueue';
import { SDKToLogConverter } from '@/claude/utils/sdkToLogConverter';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import { getProjectPath } from '@/claude/utils/path';
import { createOrderedTurnDispatcher, pendingRequestItem, finalAnswerItem, turnEndItem } from '@/channel/channelTurnOrdering';
import { MessageQueue2 } from '@/utils/MessageQueue2';

const { mockIo, mockNotifyDaemonAutomationTurnResult } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockNotifyDaemonAutomationTurnResult: vi.fn(async () => ({ status: 'ok' })),
}));
vi.mock('@/claude/sdk', () => ({ query: vi.fn(), AbortError: class AbortError extends Error {} }));
vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'https://server.test', happyHomeDir: '/tmp/happy-test-home' },
}));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() } }));
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
    },
}));
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));
vi.mock('@/utils/time', () => ({
    backoff: async <T>(callback: () => Promise<T>) => callback(),
    delay: vi.fn(async () => undefined),
    isSessionGoneError: () => false,
}));
vi.mock('@/utils/lidState', () => ({ shouldReconnect: () => true }));
vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionRuntime: vi.fn(async () => ({ status: 'ok' })),
    notifyDaemonAutomationTurnResult: mockNotifyDaemonAutomationTurnResult,
}));

describe('ApiSessionClient input evidence across held results', () => {
    let socketHandlers: Map<string, Array<(value: Update) => void>>;
    beforeEach(() => {
        vi.clearAllMocks();
        socketHandlers = new Map();
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: (value: Update) => void) => {
                socketHandlers.set(event, [...(socketHandlers.get(event) ?? []), handler]);
            }),
            off: vi.fn(), emit: vi.fn(),
            timeout: vi.fn(function (this: unknown) { return this; }),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
            volatile: { emit: vi.fn() }, close: vi.fn(),
        });
    });

    // T2RT-18: preserve the reviewer's scheduled-prompt/afterTurn/scanner
    // capability and no-boundary controls, with exactly-once lifecycle checks.
    it.each([
        { evidence: false, boundary: false },
        { evidence: false, boundary: true },
        { evidence: true, boundary: false },
        { evidence: true, boundary: true },
    ])('reports a scheduled run once (evidence=$evidence, boundary=$boundary)', async ({ evidence, boundary }) => {
        const session = {
            id: 'test-session-id', seq: 0,
            metadata: {
                path: '/tmp', host: 'localhost', homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy', happyLibDir: '/home/user/.happy/lib', happyToolsDir: '/home/user/.happy/tools',
            } as Metadata,
            metadataVersion: 0, agentState: null, agentStateVersion: 0,
            encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const,
        };
        const client = new ApiSessionClient('fake-token', session);
        vi.spyOn(client, 'updateMetadata').mockImplementation(() => undefined);
        client.configureInputQueue(new MessageQueue2<string>(x => x), 'remote', evidence);
        const events: SessionEnvelope[] = [];
        vi.spyOn(client as any, 'enqueueMessage').mockImplementation((value: any) => {
            if (value.role === 'session') events.push(value.content);
        });
        client.onUserMessage(vi.fn());
        const encrypted = encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, {
            role: 'user', content: { type: 'text', text: 'Report' },
            localKey: 'happy-automation:run-v11', meta: { sentFrom: 'automation' },
        }));
        const update: Update = {
            id: 'upd-1', seq: 1, createdAt: Date.now(),
            body: { t: 'new-message', sid: session.id, message: {
                id: 'msg-1', seq: 1, localId: null, content: { t: 'encrypted', c: encrypted },
                createdAt: Date.now(), updatedAt: Date.now(),
            } },
        };
        for (const handler of socketHandlers.get('update') ?? []) handler(update);
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            observeClaudeBackgroundInput: msg => client.observeClaudeBackgroundInput(msg),
            setPendingTurnRequestId: id => client.setPendingTurnRequestId(id),
            setPendingInputEvidence: batch => client.startClaudeInputEvidence(batch),
            sendFinalAnswerForChannelTurn: text => client.sendFinalAnswerForChannelTurn(text),
            sendStructuredOutput: value => client.sendStructuredOutput(value),
            closeClaudeSessionTurn: status => client.closeClaudeSessionTurn(status),
            bindChannelPermission: () => {},
            sendClaudeSessionMessage: msg => client.sendClaudeSessionMessage(msg as any),
        }));
        const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
        const dir = await mkdtemp(join(tmpdir(), 't2rt-automation-settlement-'));
        const oldConfig = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = dir;
        let scanner: Awaited<ReturnType<typeof createSessionScanner>> | undefined;
        let scanned = 0;
        let next = 0;
        const onReady = vi.fn(() => queue.enqueue(turnEndItem('completed')));
        const state = (client as unknown as { claudeSessionProtocolState: ClaudeSessionProtocolState }).claudeSessionProtocolState;
        const routing = () => structuredClone({
            currentTurnId: state.currentTurnId, currentRequestId: state.currentRequestId,
            pendingRequestId: state.pendingRequestId, backgroundTaskRequestIds: state.backgroundTaskRequestIds,
            toolCallTurns: state.toolCallTurns,
        });
        // The ordered pendingRequestItem(null) applies main's normal explicit
        // null assignment before the SDK result; witness settlement adds nothing.
        const before = { ...routing(), pendingRequestId: null };
        try {
            const project = getProjectPath(dir);
            await mkdir(project, { recursive: true });
            scanner = await createSessionScanner({
                sessionId: null, workingDirectory: dir,
                onMessage: msg => { client.sendClaudeSessionMessage(msg); scanned++; },
            });
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(), mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result', subtype: 'success', is_error: false, result: 'A initial final' };
                },
            } as any);
            await claudeRemote({
                sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/synthetic-settings.json',
                nextMessage: async () => next++ === 0 ? {
                    message: 'A', mode: { permissionMode: 'default' },
                    commitInput: () => {
                        queue.enqueue(pendingRequestItem(null, {
                            inputs: [{ kind: 'rest', serverMessageId: 'A', serverSeq: 1 }], inputCount: 1,
                        }));
                        return true;
                    },
                } : null,
                afterTurn: async () => {
                    await queue.flush();
                    expect(onReady).not.toHaveBeenCalled();
                    expect(mockNotifyDaemonAutomationTurnResult).not.toHaveBeenCalled();
                    expect(routing()).toEqual(before);
                    if (!boundary) return;
                    const sessionId = '11111111-2222-4333-8444-999999999997';
                    const text = '<task-notification><task-id>job</task-id><tool-use-id>old-tool</tool-use-id><status>completed</status></task-notification>';
                    const row = {
                        type: 'user', uuid: 'consumed-job', origin: { kind: 'task-notification', runId: 'run-unobserved' },
                        message: { role: 'user', content: text },
                    };
                    await writeFile(join(project, sessionId + '.jsonl'), JSON.stringify(row) + '\n');
                    await scanner!.onNewSession(sessionId);
                    await vi.waitFor(() => expect(scanned).toBe(1));
                    expect(routing()).toEqual(before);
                    if (evidence) {
                        expect(mockNotifyDaemonAutomationTurnResult).toHaveBeenCalledOnce();
                        expect(events.filter(e => e.ev.t === 'turn-end')).toHaveLength(1);
                    }
                },
                onReady, canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false, onSessionFound: vi.fn(), onThinkingChange: vi.fn(),
                onMessage: msg => {
                    if (msg.type === 'result') {
                        if (msg.subtype === 'success' && !msg.is_error) queue.enqueue(finalAnswerItem(msg.result));
                    } else {
                        const log = converter.convert(msg);
                        if (log) queue.enqueue(log);
                    }
                },
            });
            await queue.flush();
            expect(onReady).toHaveBeenCalledOnce();
            expect(routing()).toEqual(before);
            const starts = events.filter(e => e.ev.t === 'turn-start');
            const ends = events.filter(e => e.ev.t === 'turn-end');
            expect(starts).toHaveLength(evidence ? 1 : 0);
            expect(ends).toHaveLength(evidence ? 1 : 0);
            if (evidence) {
                expect(mockNotifyDaemonAutomationTurnResult).toHaveBeenCalledExactlyOnceWith(session.id, {
                    runId: 'run-v11', status: 'completed', finalAnswer: null, silent: false,
                });
                expect(ends[0]).toMatchObject({ turn: starts[0].turn, ev: {
                    t: 'turn-end', status: 'completed', inputEvidence: { terminal: true, coverage: boundary ? 'incomplete' : 'complete' },
                } });
                expect(ends[0].ev).not.toHaveProperty('requestId');
                expect(client.inputEvidence.currentTurn()).toBeNull();
                expect(observeFollowupTurn(events.map((content, seq) => ({
                    seq: seq + 1, localId: null, content: { role: 'session', content },
                })))).toMatchObject({ complete: true, failed: false });
            } else expect(mockNotifyDaemonAutomationTurnResult).not.toHaveBeenCalled();
            for (const event of events) expect(() => sessionEnvelopeSchema.parse(event)).not.toThrow();
        } finally {
            await scanner?.cleanup();
            queue.destroy();
            await client.close();
            if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = oldConfig;
            await rm(dir, { recursive: true, force: true });
        }
    }, 15_000);

    // Keep all four cases from the reviewer's lifecycle-proof.test.ts. Only the
    // SDK and network boundaries are scripted; scanner/queue/mapper remain real.
    it.each([
        { source: 'consumed', mapped: false },
        { source: 'attachment', mapped: false },
        { source: 'sdk', mapped: false },
        { source: 'consumed', mapped: true },
    ])('settles unproven background evidence (source=$source, mapped=$mapped)', async ({ source, mapped }) => {
        const client = new ApiSessionClient('fake-token', {
            id: 'test-session-id', seq: 0,
            metadata: {
                path: '/tmp', host: 'localhost', homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy', happyLibDir: '/home/user/.happy/lib', happyToolsDir: '/home/user/.happy/tools',
            } as Metadata,
            metadataVersion: 0, agentState: null, agentStateVersion: 0,
            encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
        });
        vi.spyOn(client, 'updateMetadata').mockImplementation(() => undefined);
        client.configureInputQueue(new MessageQueue2<string>(x => x), 'remote', true);
        const events: SessionEnvelope[] = [];
        vi.spyOn(client as any, 'enqueueMessage').mockImplementation((value: any) => {
            if (value.role === 'session') events.push(value.content);
        });
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            observeClaudeBackgroundInput: msg => client.observeClaudeBackgroundInput(msg),
            setPendingTurnRequestId: id => client.setPendingTurnRequestId(id),
            setPendingInputEvidence: batch => client.startClaudeInputEvidence(batch),
            sendFinalAnswerForChannelTurn: text => client.sendFinalAnswerForChannelTurn(text),
            sendStructuredOutput: value => client.sendStructuredOutput(value),
            closeClaudeSessionTurn: status => client.closeClaudeSessionTurn(status),
            bindChannelPermission: () => {},
            sendClaudeSessionMessage: msg => client.sendClaudeSessionMessage(msg as any),
        }));
        const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
        const dir = await mkdtemp(join(tmpdir(), 't2rt-lifecycle-proof-'));
        const oldConfig = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = dir;
        let scanner: Awaited<ReturnType<typeof createSessionScanner>> | undefined;
        let scanned = 0;
        const onReady = vi.fn(() => queue.enqueue(turnEndItem('completed')));
        const final = (text: string) => {
            const envelope = events.find(e => e.ev.t === 'final-answer' && e.ev.text === text)!;
            if (envelope.ev.t !== 'final-answer') throw new Error('Expected final answer');
            return { turn: envelope.turn!, evidence: envelope.ev.inputEvidence! };
        };
        try {
            const project = getProjectPath(dir);
            await mkdir(project, { recursive: true });
            scanner = await createSessionScanner({
                sessionId: null, workingDirectory: dir,
                onMessage: msg => { client.sendClaudeSessionMessage(msg); scanned++; },
            });
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(), mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() {
                    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [
                        { task_id: 'job', task_type: 'local_agent', description: 'resumed work' },
                    ] };
                    yield { type: 'result', subtype: 'success', is_error: false, result: 'A initial final' };
                    await queue.flush();
                    const initial = final('A initial final');
                    expect(initial.evidence).toMatchObject({
                        coverage: 'complete', inputs: [{ kind: 'rest', serverMessageId: 'A', serverSeq: 1 }],
                    });
                    expect(onReady).not.toHaveBeenCalled();
                    const sessionId = '11111111-2222-4333-8444-999999999998';
                    const text = '<task-notification><task-id>job</task-id><tool-use-id>old-tool</tool-use-id><status>completed</status></task-notification>';
                    if (source === 'sdk') {
                        yield {
                            type: 'system', subtype: 'task_notification', task_id: 'job', tool_use_id: 'old-tool',
                            run_id: 'run-unobserved', status: 'completed', output_file: '', summary: 'done',
                        };
                        await queue.flush();
                    } else {
                        const row = source === 'attachment' ? {
                            type: 'attachment', uuid: 'consumed-job', attachment: {
                                type: 'queued_command', commandMode: 'task-notification', runId: 'run-unobserved', prompt: text,
                            },
                        } : {
                            type: 'user', uuid: 'consumed-job', origin: { kind: 'task-notification', runId: 'run-unobserved' },
                            message: { role: 'user', content: text },
                        };
                        await writeFile(join(project, sessionId + '.jsonl'), JSON.stringify(row) + '\n');
                        await scanner!.onNewSession(sessionId);
                        await vi.waitFor(() => expect(scanned).toBe(1));
                    }
                    if (source === 'consumed') {
                        // No mapped turn-end/start exists here. The witness must
                        // settle at consumption, before either form of F output.
                        expect(client.inputEvidence.snapshot(initial.turn)).toMatchObject({
                            terminal: true, coverage: 'incomplete',
                            incompleteReasons: expect.arrayContaining(['background-consumption-unproven']),
                        });
                        expect(client.inputEvidence.currentTurn()).toBeNull();
                        expect(events.some(e => e.ev.t === 'turn-input-evidence' && e.turn === initial.turn
                            && e.ev.inputEvidence.terminal && e.ev.inputEvidence.coverage === 'incomplete')).toBe(true);
                        const ends = events.filter(e => e.ev.t === 'turn-end' && e.turn === initial.turn);
                        expect(ends).toHaveLength(1);
                        expect(ends[0].ev).not.toHaveProperty('requestId');
                    }
                    if (mapped) yield {
                        type: 'assistant', uuid: 'F-text', parent_tool_use_id: null,
                        message: { role: 'assistant', content: [{ type: 'text', text: 'F output' }] },
                    };
                    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
                    yield { type: 'result', subtype: 'success', is_error: false, result: 'F background final' };
                },
            } as any);
            const outcome = await claudeRemote({
                sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/synthetic-settings.json',
                exitAfterFirstTurn: true,
                nextMessage: async () => ({
                    message: 'A', mode: { permissionMode: 'default' },
                    commitInput: () => {
                        queue.enqueue(pendingRequestItem(null, {
                            inputs: [{ kind: 'rest', serverMessageId: 'A', serverSeq: 1 }], inputCount: 1,
                        }));
                        return true;
                    },
                }),
                onReady, canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false, onSessionFound: vi.fn(), onThinkingChange: vi.fn(),
                onMessage: msg => {
                    if (msg.type === 'result') {
                        if (msg.subtype === 'success' && !msg.is_error) queue.enqueue(finalAnswerItem(msg.result));
                    } else {
                        const log = converter.convert(msg);
                        if (log) queue.enqueue(log);
                    }
                },
            });
            await queue.flush();
            expect(outcome).toBe('turn-complete');
            expect(onReady).toHaveBeenCalledOnce();
            const followup = final('F background final');
            expect(followup.evidence.coverage).toBe('incomplete');
            expect(followup.evidence.incompleteReasons.some(x => x.startsWith('background-'))).toBe(true);
            expect(client.inputEvidence.snapshot(followup.turn)).toMatchObject({ terminal: true, coverage: 'incomplete' });
            if (source === 'consumed') {
                expect(events.filter(e => e.ev.t === 'turn-end' && e.turn === final('A initial final').turn)).toHaveLength(1);
                expect(followup.turn).not.toBe(final('A initial final').turn);
                expect(followup.evidence.rootBatchId).not.toBe(final('A initial final').evidence.rootBatchId);
                expect(followup.evidence).toMatchObject({ inputs: [], inputCount: 0 });
            }
            for (const start of events.filter(e => e.ev.t === 'turn-start')) {
                expect(events.filter(e => e.ev.t === 'turn-end' && e.turn === start.turn)).toHaveLength(1);
            }
            for (const event of events) expect(() => sessionEnvelopeSchema.parse(event)).not.toThrow();
        } finally {
            await scanner?.cleanup();
            queue.destroy();
            await client.close();
            if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = oldConfig;
            await rm(dir, { recursive: true, force: true });
        }
    }, 15_000);
});

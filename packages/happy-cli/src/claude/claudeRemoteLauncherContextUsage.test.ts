/**
 * The context-usage frames a recorded Claude session produces through the launcher's real
 * delivery path: SDK message → SDKToLogConverter → OutgoingMessageQueue → ApiSessionClient.
 *
 * Saycode Desktop specs/desktop-chat-context-window-meter. The queue drops every `system` log
 * message, so a test that hands logs to the client directly cannot see whether `init` and
 * `compact_boundary` ever arrive — this one runs the launcher itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApiSessionClient } from '@/api/apiSession';
import { decodeBase64, decrypt } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { EnhancedMode } from './loop';
import type { Session } from './session';

const { mockIo, rpcHandlers } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    rpcHandlers: new Map<string, () => Promise<unknown>>(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));
vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('axios', () => ({
    default: {
        get: vi.fn(async () => ({ data: { messages: [], events: [], sessions: [], hasMore: false } })),
        post: vi.fn(async () => ({ data: { messages: [] } })),
        put: vi.fn(async () => ({ data: {} })),
    },
}));
vi.mock('@/ui/logger', () => ({
    logger: new Proxy({}, { get: (_target, name) => name === 'then' ? undefined : () => {} }),
}));
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = (name: string, handler: () => Promise<unknown>) => rpcHandlers.set(name, handler);
    },
}));
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));
vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionRuntime: vi.fn(async () => ({ status: 'ok' })),
    notifyDaemonAutomationTurnResult: vi.fn(async () => ({ status: 'ok' })),
    reportSetupTokenActivity: vi.fn(async () => ({ ok: true })),
}));

type RecordedMessage = { label: string; type: string; [key: string]: unknown };

/** A real Claude SDK 0.3.285 session (2026-10-19, `model: 'claude-haiku-4-5'`), trimmed to the fields read. */
function readRecording(): RecordedMessage[][] {
    const messages = readFileSync(join(__dirname, '__fixtures__/claude-sdk-task-compact-recording.v1.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as RecordedMessage);
    const turns = new Map<string, RecordedMessage[]>();
    for (const message of messages) turns.set(message.label, [...(turns.get(message.label) ?? []), message]);
    return [...turns.values()];
}

describe('claudeRemoteLauncher context-usage delivery', () => {
    let socket: any;
    const encryptionKey = new Uint8Array(32);

    beforeEach(() => {
        vi.clearAllMocks();
        rpcHandlers.clear();
        socket = {
            connected: true,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            emit: vi.fn(),
            timeout: vi.fn(function (this: unknown) { return this; }),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
            volatile: { emit: vi.fn() },
            close: vi.fn(),
        };
        mockIo.mockReturnValue(socket);
    });

    const frames = () => socket.volatile.emit.mock.calls
        .filter(([event]: [string]) => event === 'session-stream')
        .map(([, payload]: [string, { data: string }]) => decrypt(encryptionKey, 'legacy', decodeBase64(payload.data)))
        .filter((frame: { type?: unknown }) => frame?.type === 'context-usage');

    it('replays a recorded session with a subagent and a /compact into the expected frames', async () => {
        const turns = readRecording();
        const client = new ApiSessionClient('fake-token', {
            id: 'context-usage-launcher-test', seq: 0, metadataVersion: 0, agentState: null, agentStateVersion: 0,
            metadata: {
                path: '/tmp', host: 'localhost', homeDir: '/home/user', happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib', happyToolsDir: '/home/user/.happy/tools',
            } as Metadata,
            encryptionKey, encryptionVariant: 'legacy',
        });
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        vi.mocked(query).mockImplementation(({ prompt }) => {
            const response = (async function* () {
                let turn = 0;
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    for (const { label: _label, ...message } of turns[turn]) {
                        // A live provider streams over seconds, so the queue drains between messages.
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        // The recording keeps only what the meter reads; the launcher's status line wants these.
                        yield message.type === 'result' ? { duration_ms: 1, num_turns: 1, total_cost_usd: 0, ...message } : message;
                    }
                    turn += 1;
                    if (turn === turns.length) {
                        void rpcHandlers.get('switch')!();
                        return;
                    }
                    queue.push(`turn-${turn}`, { permissionMode: 'default', model: 'claude-haiku-4-5' });
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('turn-0', { permissionMode: 'default', model: 'claude-haiku-4-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onSessionFound: vi.fn(),
        } as unknown as Session;

        await claudeRemoteLauncher(session);

        expect(frames().map((frame: any) => [frame.seq, frame.used, frame.window, frame.model])).toEqual([
            // Main responses, keyed by the provider's init model: the subagent's own requests never
            // arrived (only its prompt, as a sidechain user message), so occupancy follows the main agent.
            [1, 26487, null, 'claude-haiku-4-5'],
            [2, 29843, null, 'claude-haiku-4-5'],
            [3, 30887, null, 'claude-haiku-4-5'],
            // The window of the provider's model key, not the subagent's dated one beside it.
            [4, 30887, 200000, 'claude-haiku-4-5'],
            // compact_boundary: occupancy hidden, the window kept; the compact turn's result resends it.
            [5, null, 200000, 'claude-haiku-4-5'],
            [5, null, 200000, 'claude-haiku-4-5'],
            // The first response after compaction shows again before its turn ends.
            [6, 28173, 200000, 'claude-haiku-4-5'],
            [6, 28173, 200000, 'claude-haiku-4-5'],
        ]);
        await client.close();
    });
});

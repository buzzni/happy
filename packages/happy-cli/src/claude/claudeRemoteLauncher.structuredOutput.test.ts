/**
 * A structured-output session's per-turn verdicts through the launcher's real delivery path:
 * SDK result → OutgoingMessageQueue → ApiSessionClient (Saycode specs/claude-cli-benchmark-followups R2).
 *
 * The verdict is enqueued on the SDK `result`, so only running the launcher shows that every turn
 * gets one, that `success` without `structured_output` is reported missing, and that an ordinary
 * session reports nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import type { StructuredOutputEnvelope } from '@/claude/structuredOutput';
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
}));

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

/** Two turns as the SDK ends them: one with a value, one `success` without (an unsatisfiable schema). */
const TURN_RESULTS = [
    { type: 'result', subtype: 'success', is_error: false, result: '{"answer":"ok"}', structured_output: { answer: 'ok' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'I could not satisfy that schema.' },
];

describe('claudeRemoteLauncher structured output delivery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rpcHandlers.clear();
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            emit: vi.fn(),
            timeout: vi.fn(function (this: unknown) { return this; }),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
            volatile: { emit: vi.fn() },
            close: vi.fn(),
        });
    });

    async function runTwoTurns(outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }): Promise<StructuredOutputEnvelope[]> {
        const client = new ApiSessionClient('fake-token', {
            id: 'structured-output-launcher-test', seq: 0, metadataVersion: 0, agentState: null, agentStateVersion: 0,
            metadata: {
                path: '/tmp', host: 'localhost', homeDir: '/home/user', happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib', happyToolsDir: '/home/user/.happy/tools',
            } as Metadata,
            encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
        });
        const sent: StructuredOutputEnvelope[] = [];
        const original = client.sendStructuredOutput.bind(client);
        vi.spyOn(client, 'sendStructuredOutput').mockImplementation((envelope) => {
            sent.push(envelope);
            original(envelope);
        });
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            // The format is one per query, so both turns of the session see the same one.
            expect(options?.outputFormat).toEqual(outputFormat);
            const response = (async function* () {
                let turn = 0;
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    yield { duration_ms: 1, num_turns: 1, total_cost_usd: 0, ...TURN_RESULTS[turn] };
                    turn += 1;
                    if (turn === TURN_RESULTS.length) {
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
            outputFormat,
        } as unknown as Session;

        await claudeRemoteLauncher(session);
        await client.close();
        return sent;
    }

    it('reports a verdict for every turn and never trusts subtype alone', async () => {
        expect(await runTwoTurns({ type: 'json_schema', schema })).toEqual([
            { v: 1, status: 'ok', value: { answer: 'ok' } },
            { v: 1, status: 'missing', reason: 'not_produced' },
        ]);
    });

    it('reports nothing for a session that never asked for a value', async () => {
        expect(await runTwoTurns()).toEqual([]);
    });
});

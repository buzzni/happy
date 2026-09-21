import { describe, expect, it, vi } from 'vitest';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));

describe('Claude model changes across provider restarts', () => {
    it.each(['model', 'effort'] as const)('applies consecutive %s changes at the SDK boundary', async (field) => {
        const modes: EnhancedMode[] = field === 'model'
            ? ['claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-5'].map(model => ({ permissionMode: 'default', model }))
            : ['low', 'high', 'medium', 'medium'].map(effort => ({ permissionMode: 'default', model: 'claude-opus-5', effort: effort as EnhancedMode['effort'] }));
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const received: Array<{ text: unknown; model: Options['model']; effort: Options['effort'] }> = [];
        const launches: Options[] = [];
        const client = {
            sessionId: 'model-switch-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const response = (async function* () {
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    received.push({ text: message.message.content, model: options?.model, effort: options?.effort });
                    yield { type: 'result', subtype: 'success', result: '', is_error: false, uuid: `result-${received.length}` };
                    if (received.length === modes.length) {
                        void handlers.get('switch')!();
                        return;
                    }
                    queue.push(`turn-${received.length}`, modes[received.length]);
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('turn-0', modes[0]);
        const session = {
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        } as unknown as Session;
        await claudeRemoteLauncher(session);
        expect(received).toEqual(modes.map((mode, index) => ({ text: `turn-${index}`, model: mode.model, effort: mode.effort })));
        expect(launches).toHaveLength(3);
        expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Process exited unexpectedly' }));
    });
});

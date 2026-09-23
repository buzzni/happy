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
        let metadata: Record<string, any> = {};
        const snapshots: any[] = [];
        const client = {
            sessionId: 'model-switch-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn((update) => {
                metadata = update(metadata);
                if (metadata.claudeBackgroundTasks) snapshots.push(metadata.claudeBackgroundTasks);
            }), getMetadata: () => metadata,
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    received.push({ text: message.message.content, model: options?.model, effort: options?.effort });
                    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [
                        { task_id: `bg-${generation}`, task_type: 'local_bash', description: 'server' },
                        { task_id: 'watcher', task_type: 'local_bash', description: 'watch', ambient: true },
                    ] };
                    if (generation > 1) {
                        // No task_notification: the full empty snapshot must clear it.
                        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
                        // Bookends may arrive after a newer full snapshot; do not resurrect it.
                        yield { type: 'system', subtype: 'task_started', task_id: `bg-${generation}`, description: 'server' };
                    }
                    yield { type: 'result', subtype: 'success' , result: '', is_error: false, uuid: `result-${received.length}` };
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
        const lessonReviewLifecycle = { controller: new AbortController(), completedAssistantTurns: 0 };
        const cancelLessonReview = vi.fn(() => lessonReviewLifecycle.controller.abort());
        const session = {
            lessonReviewLifecycle, cancelLessonReview,
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        } as unknown as Session;
        await claudeRemoteLauncher(session);
        expect(received).toEqual(modes.map((mode, index) => ({ text: `turn-${index}`, model: mode.model, effort: mode.effort })));
        expect(launches).toHaveLength(3);
        expect(snapshots.filter(s => s.tasks === null && s.available).length).toBeGreaterThanOrEqual(3);
        expect(snapshots).toContainEqual(expect.objectContaining({ tasks: [{ taskId: 'bg-1', label: 'server', kind: 'shell' }], available: true }));
        expect(snapshots).toContainEqual(expect.objectContaining({ tasks: [{ taskId: 'bg-1', label: 'server', kind: 'shell' }], available: false }));
        expect(snapshots.at(-1)).toEqual(expect.objectContaining({ tasks: [], available: false }));
        expect(lessonReviewLifecycle.completedAssistantTurns).toBe(modes.length);
        expect(cancelLessonReview).toHaveBeenCalled();
        expect(lessonReviewLifecycle.controller.signal.aborted).toBe(true);
        expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Process exited unexpectedly' }));
    });
});

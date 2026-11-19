import { describe, expect, it, vi } from 'vitest';

import { resumeExistingThread } from './resumeExistingThread';

describe('resumeExistingThread', () => {
    it('resumes the thread and updates session metadata', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({
                threadId: '019ccca2-1a77-7481-9873-de72f3464372',
                model: 'gpt-5.4',
            }),
        };
        const metadataHandlers: Array<(metadata: any) => any> = [];
        const session = {
            updateMetadata: vi.fn((handler) => metadataHandlers.push(handler)),
            sendSessionEvent: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        const result = await resumeExistingThread({
            client,
            session,
            messageBuffer,
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
            developerInstructions: 'Discover Argos tools before browser fallback.',
        });

        expect(result).toEqual({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            model: 'gpt-5.4',
        });
        expect(client.resumeThread).toHaveBeenCalledWith({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
            developerInstructions: 'Discover Argos tools before browser fallback.',
        });
        expect(metadataHandlers).toHaveLength(1);
        expect(metadataHandlers[0]({ existing: true })).toEqual({
            existing: true,
            codexThreadId: '019ccca2-1a77-7481-9873-de72f3464372',
        });
        expect(messageBuffer.addMessage).toHaveBeenCalledWith(expect.stringContaining('Resumed thread'), 'status');
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Resumed Codex thread 019ccca2-1a77-7481-9873-de72f3464372',
        });
    });

    it('wraps backend resume errors with the thread ID', async () => {
        const client = {
            resumeThread: vi.fn().mockRejectedValue(new Error('thread not found')),
        };
        const session = {
            updateMetadata: vi.fn(),
            sendSessionEvent: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        await expect(
            resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: 'thread-404',
                cwd: '/tmp/project',
                mcpServers: {},
            }),
        ).rejects.toThrow('Failed to resume Codex thread thread-404: thread not found');
    });

    it.each(['released', 'held', 'cancelled'] as const)('reuses the same thread when its writer is %s', async outcome => {
        const threadId = 'thread-1';
        const error = new Error(`thread/resume: thread ${threadId} already has an active writer (code=-32600)`);
        const client = { resumeThread: vi.fn().mockRejectedValue(error) };
        if (outcome === 'released') client.resumeThread.mockRejectedValueOnce(error).mockResolvedValue({ threadId, model: 'gpt-6.1-sol' });
        const session = { updateMetadata: vi.fn(), sendSessionEvent: vi.fn() };
        const canRetry = vi.fn().mockReturnValue(outcome !== 'cancelled').mockReturnValueOnce(true);
        const pending = resumeExistingThread({ client, session, messageBuffer: { addMessage: vi.fn() }, threadId, cwd: '/tmp/project', mcpServers: {}, canRetry });
        if (outcome === 'released') await expect(pending).resolves.toMatchObject({ threadId });
        else await expect(pending).rejects.toThrow('already has an active writer');
        expect(client.resumeThread.mock.calls).toEqual(Array.from({ length: outcome === 'cancelled' ? 1 : 2 }, () => [{ threadId, cwd: '/tmp/project', mcpServers: {}, developerInstructions: undefined }]));
        expect(session.updateMetadata).toHaveBeenCalledTimes(outcome === 'released' ? 1 : 0);
    });
});

import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import { mergeReconnectSessionMetadata } from './reconnectSessionMetadata';

describe('mergeReconnectSessionMetadata', () => {
    it('refreshes process-owned metadata when a persisted session resumes', () => {
        const persistedMetadata = {
            hostPid: 77316,
            version: '1.1.10-aplus.56',
            archivedBy: 'user',
        } as Metadata;
        const freshLaunchMetadata = {
            hostPid: 90396,
            version: '1.1.10-aplus.58',
        } as Metadata;

        expect(mergeReconnectSessionMetadata(persistedMetadata, freshLaunchMetadata)).toMatchObject({
            hostPid: 90396,
            version: '1.1.10-aplus.58',
            archivedBy: undefined,
        });
    });

    it('preserves server-owned and unknown metadata fields', () => {
        const persistedMetadata = {
            hostPid: 77316,
            summary: { text: 'Existing title', updatedAt: 100 },
            claudeSessionId: 'claude-session',
            codexThreadId: 'codex-thread',
            parentSessionId: 'parent-session',
            forkedFromMessageId: 'source-message',
            providerExtension: { enabled: true },
        } as Metadata & { providerExtension: { enabled: boolean } };
        const freshLaunchMetadata = {
            hostPid: 90396,
            lifecycleState: 'running',
        } as Metadata;

        expect(mergeReconnectSessionMetadata(persistedMetadata, freshLaunchMetadata)).toMatchObject({
            hostPid: 90396,
            summary: { text: 'Existing title', updatedAt: 100 },
            claudeSessionId: 'claude-session',
            codexThreadId: 'codex-thread',
            parentSessionId: 'parent-session',
            forkedFromMessageId: 'source-message',
            providerExtension: { enabled: true },
        });
    });

    it('returns fresh launch metadata unchanged for a new session', () => {
        const freshLaunchMetadata = {
            hostPid: 90396,
            version: '1.1.10-aplus.58',
        } as Metadata;

        expect(mergeReconnectSessionMetadata(undefined, freshLaunchMetadata)).toBe(freshLaunchMetadata);
    });
});

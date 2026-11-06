import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import { mergeReconnectSessionMetadata } from './reconnectSessionMetadata';
import { createSessionMetadata } from './createSessionMetadata';
import { BASH_PREFIX_MATCHER_CAPABILITY } from '@/claude/utils/bashPrefixMatcher';

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
            // Written once at creation; a resume without a spawn source must not erase it.
            source: 'schedule',
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
            source: 'schedule',
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

    it.each([true, false])('refreshes permission grants from the replacement runner (supported=%s)', (supported) => {
        const persistedMetadata = {
            ...createSessionMetadata({ flavor: 'claude', machineId: 'm',
                permissionGrants: BASH_PREFIX_MATCHER_CAPABILITY }).metadata,
            summary: { text: 'Preserved title', updatedAt: 1 },
        };
        const freshMetadata = createSessionMetadata({ flavor: 'claude', machineId: 'm',
            ...(supported ? { permissionGrants: BASH_PREFIX_MATCHER_CAPABILITY } : {}),
        }).metadata;
        const resumed = mergeReconnectSessionMetadata(persistedMetadata, freshMetadata);

        expect(resumed.summary).toEqual(persistedMetadata.summary);
        expect(resumed.runtimeCapabilities?.permissionGrants)
            .toEqual(supported ? { bashPrefixMatcher: 'plain-v1' } : undefined);
    });
});

import type { Metadata } from '@/api/types';

export function mergeReconnectSessionMetadata(
    persistedMetadata: Metadata | undefined,
    freshLaunchMetadata: Metadata,
): Metadata {
    if (!persistedMetadata) return freshLaunchMetadata;

    return {
        ...persistedMetadata,
        ...freshLaunchMetadata,
        archivedBy: undefined,
    };
}

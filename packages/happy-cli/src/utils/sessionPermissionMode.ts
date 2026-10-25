/**
 * Session permission mode publisher (aplus-dev-studio-desktop #2187).
 *
 * Advertises the permission mode a session currently applies on its metadata
 * (`permissionMode` + `permissionModeUpdatedAt`). Without it a client only knows
 * the mode it sent itself, so a mode another client (mobile, CLI, another
 * Desktop) switched to later stays invisible to it.
 *
 * The runners own the mode; this only mirrors it, publishing on actual change so
 * a long session does not rewrite its metadata on every message.
 */

import type { Metadata, PermissionMode } from '@/api/types';

const PERMISSION_MODES: readonly PermissionMode[] = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
];

/** The mode the session metadata already advertises; anything unrecognised counts as none. */
export function publishedSessionPermissionMode(metadata: Metadata | undefined): PermissionMode | undefined {
    const value = metadata?.permissionMode;
    return value && PERMISSION_MODES.includes(value) ? value : undefined;
}

export function createSessionPermissionModePublisher(input: {
    /** What the session metadata advertises at startup (a reconnect carries the old runtime's value). */
    published: PermissionMode | undefined;
    updateMetadata: (update: (metadata: Metadata) => Metadata) => void;
    now?: () => number;
}): {
    /** Mirrors the runner's current mode; an unset mode is the effective `default`. */
    publish: (mode: PermissionMode | undefined) => void;
} {
    const now = input.now ?? Date.now;
    let published = input.published;

    return {
        publish: (mode) => {
            const next = mode ?? 'default';
            if (next === published) return;
            published = next;
            const updatedAt = now();
            input.updateMetadata((metadata) => ({
                ...metadata,
                permissionMode: next,
                permissionModeUpdatedAt: updatedAt,
            }));
        },
    };
}

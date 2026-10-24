import { describe, expect, it } from 'vitest';
import type { Metadata, PermissionMode } from '@/api/types';
import { createSessionPermissionModePublisher, publishedSessionPermissionMode } from './sessionPermissionMode';

const BASE: Metadata = {
    path: '/tmp/p',
    host: 'h',
    homeDir: '/home/u',
    happyHomeDir: '/home/u/.happy',
    happyLibDir: '/home/u/.happy/lib',
    happyToolsDir: '/home/u/.happy/tools',
};

function harness(initial: Metadata = BASE) {
    let current: Metadata = { ...initial };
    let clock = 1_000;
    const writes: Metadata[] = [];
    const publisher = createSessionPermissionModePublisher({
        published: publishedSessionPermissionMode(initial),
        updateMetadata: (update) => {
            current = update(current);
            writes.push(current);
        },
        now: () => clock,
    });
    return {
        publisher,
        writes,
        current: () => current,
        tick: (ms: number) => { clock += ms; },
    };
}

describe('publishedSessionPermissionMode', () => {
    it('reads a valid published mode', () => {
        expect(publishedSessionPermissionMode({ ...BASE, permissionMode: 'safe-yolo' })).toBe('safe-yolo');
    });

    it('treats an absent or unknown value as nothing published', () => {
        expect(publishedSessionPermissionMode(BASE)).toBeUndefined();
        expect(publishedSessionPermissionMode(undefined)).toBeUndefined();
        expect(publishedSessionPermissionMode({ ...BASE, permissionMode: 'totally_unsafe' as PermissionMode })).toBeUndefined();
    });
});

describe('createSessionPermissionModePublisher', () => {
    it('publishes the initial mode with the time it was set', () => {
        const h = harness();
        h.publisher.publish('yolo');
        expect(h.current().permissionMode).toBe('yolo');
        expect(h.current().permissionModeUpdatedAt).toBe(1_000);
    });

    it('publishes every change and only changes', () => {
        const h = harness();
        h.publisher.publish('yolo');
        h.publisher.publish('yolo');
        h.tick(500);
        h.publisher.publish('safe-yolo');
        h.publisher.publish('safe-yolo');
        expect(h.writes.map((w) => w.permissionMode)).toEqual(['yolo', 'safe-yolo']);
        expect(h.current().permissionModeUpdatedAt).toBe(1_500);
    });

    it('reports an unset runtime mode as the effective default', () => {
        const h = harness();
        h.publisher.publish(undefined);
        expect(h.current().permissionMode).toBe('default');
    });

    it('does not rewrite a mode a restarted runtime finds already published', () => {
        const h = harness({ ...BASE, permissionMode: 'yolo', permissionModeUpdatedAt: 42 });
        h.publisher.publish('yolo');
        expect(h.writes).toEqual([]);
        expect(h.current().permissionModeUpdatedAt).toBe(42);
    });

    it('replaces a stale published mode when the restarted runtime runs another one', () => {
        const h = harness({ ...BASE, permissionMode: 'safe-yolo', permissionModeUpdatedAt: 42 });
        h.publisher.publish('yolo');
        expect(h.current().permissionMode).toBe('yolo');
        expect(h.current().permissionModeUpdatedAt).toBe(1_000);
    });

    it('keeps every other metadata field', () => {
        const h = harness({ ...BASE, currentModelCode: 'gpt-5', dangerouslySkipPermissions: true });
        h.publisher.publish('read-only');
        expect(h.current()).toMatchObject({ currentModelCode: 'gpt-5', dangerouslySkipPermissions: true, permissionMode: 'read-only' });
    });
});

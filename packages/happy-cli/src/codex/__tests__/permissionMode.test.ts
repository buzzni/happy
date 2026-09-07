import { describe, expect, it } from 'vitest';
import { resolveRemoteCodexPermissionMode } from '../permissionMode';

describe('resolveRemoteCodexPermissionMode', () => {
    it('keeps the current mode when a message carries no override', () => {
        expect(resolveRemoteCodexPermissionMode('yolo', undefined)).toBe('yolo');
    });

    it('ignores a mode outside the Codex-native set (issue #1092)', () => {
        expect(resolveRemoteCodexPermissionMode('yolo', 'totally_unsafe' as never)).toBe('yolo');
    });

    it('ignores bypassPermissions, which Codex has no native mapping for', () => {
        expect(resolveRemoteCodexPermissionMode('yolo', 'bypassPermissions')).toBe('yolo');
    });

    it('applies an explicit valid mode over the current one', () => {
        expect(resolveRemoteCodexPermissionMode('yolo', 'read-only')).toBe('read-only');
        expect(resolveRemoteCodexPermissionMode('yolo', 'safe-yolo')).toBe('safe-yolo');
        expect(resolveRemoteCodexPermissionMode(undefined, 'default')).toBe('default');
    });
});

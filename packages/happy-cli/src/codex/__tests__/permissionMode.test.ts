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

    // 클라이언트가 매 메시지에 실어 보내는 주변값 'default' 가 yolo 로 뜬 세션을 untrusted 로
    // 끌어내리면 이후 셸 호출마다 승인 카드가 뜬다. Claude 의 resolveRemoteClaudePermissionMode
    // 와 같은 가드를 둔다.
    it('does not let an ambient default downgrade a bypass-equivalent session', () => {
        expect(resolveRemoteCodexPermissionMode('yolo', 'default')).toBe('yolo');
        expect(resolveRemoteCodexPermissionMode('bypassPermissions', 'default')).toBe('bypassPermissions');
    });

    it('still applies default when the session is not bypass-equivalent', () => {
        expect(resolveRemoteCodexPermissionMode('safe-yolo', 'default')).toBe('default');
    });
});

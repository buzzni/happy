import type { PermissionMode } from '@/api/types';

/**
 * Valid Codex permission modes from remote messages. Matches the modes the
 * mobile UI exposes for Codex sessions (see modelModeOptions.ts:
 * getCodexPermissionModes) and mirrors the Gemini validation pattern at
 * runGemini.ts:222. Anything outside this set is silently ignored — blindly
 * casting `message.meta.permissionMode` would let a crafted value like
 * `'totally_unsafe'` fall through to the `default` branch in
 * resolveCodexExecutionPolicy(), or let an attacker-chosen valid value escalate
 * sandbox scope (issue #1092).
 */
const VALID_REMOTE_PERMISSION_MODES: readonly PermissionMode[] = [
    'default',
    'read-only',
    'safe-yolo',
    'yolo',
];

function isCodexBypassEquivalent(mode: PermissionMode | undefined): boolean {
    return mode === 'yolo' || mode === 'bypassPermissions';
}

/**
 * Resolve a permission mode override arriving on a remote user message.
 *
 * Clients attach `permissionMode` to every message, and some of them send the
 * ambient `"default"` even when the session was started in yolo/bypass mode.
 * Letting that through drops the session to `untrusted` (executionPolicy.ts), so
 * every subsequent shell call raises an approval card. Guard it the same way
 * Claude does in resolveRemoteClaudePermissionMode(), while still letting an
 * explicit mode such as read-only or safe-yolo take effect.
 */
export function resolveRemoteCodexPermissionMode(
    currentMode: PermissionMode | undefined,
    incomingMode: PermissionMode | undefined,
): PermissionMode | undefined {
    if (!incomingMode) return currentMode;
    if (!VALID_REMOTE_PERMISSION_MODES.includes(incomingMode)) return currentMode;
    if (isCodexBypassEquivalent(currentMode) && incomingMode === 'default') return currentMode;
    return incomingMode;
}

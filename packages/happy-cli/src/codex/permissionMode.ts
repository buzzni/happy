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

/**
 * Resolve a permission mode override arriving on a remote user message.
 * Anything outside VALID_REMOTE_PERMISSION_MODES is ignored and the current
 * mode is kept.
 */
export function resolveRemoteCodexPermissionMode(
    currentMode: PermissionMode | undefined,
    incomingMode: PermissionMode | undefined,
): PermissionMode | undefined {
    if (!incomingMode) return currentMode;
    if (!VALID_REMOTE_PERMISSION_MODES.includes(incomingMode)) return currentMode;
    return incomingMode;
}

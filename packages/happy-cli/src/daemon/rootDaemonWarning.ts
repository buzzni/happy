/**
 * Sessions this daemon starts without a permission mode skip permission prompts, and Claude Code
 * refuses that under root — so on a root daemon those chats end at once (Desktop
 * specs/headless-standalone-server R20). The daemon still starts: Codex and explicit permission
 * modes may work, and silently switching modes would change what the user approved.
 */
export function rootDaemonWarning(uid: number | undefined): string | null {
  if (uid !== 0) return null
  return 'Warning: this daemon runs as root. Claude Code refuses to run with permission prompts skipped as root, '
    + 'so Claude chats started on this machine will fail. Run the daemon as a regular user.'
}

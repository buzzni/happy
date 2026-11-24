/**
 * Advertised in machine metadata: this daemon serves `workspace-git-status`,
 * `workspace-current-pr`, `machine-ai-usage`, `agent-login-status` and `codex-cli-status`, the fixed
 * reads that replace Studio's automatic `bash` status reads
 * (aplus-dev-studio specs/work-machine-migration). A client checks it before
 * calling, since a daemon without the handlers answers only after
 * happy-server's reconnect grace.
 */
export const FIXED_READ_RPCS_CAPABILITY = { version: 1 as const };

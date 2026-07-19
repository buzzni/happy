/**
 * Extracts a human-readable error from a codex task_complete/turn_aborted event.
 * Returns null if the event represents a successful/clean completion.
 */
export function describeCodexFailure(msg: any): string | null {
    const hasFailure = msg?.status === 'failed' || (msg?.error !== undefined && msg?.error !== null);
    if (!hasFailure) return null;
    const err = msg.error;
    if (typeof err === 'string' && err.length > 0) return err;
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
        return err.message;
    }
    return 'Unknown error';
}

/** Marks a turn-terminal event as caused by our inactivity watchdog. */
export const CODEX_INACTIVITY_ABORT_REASON = 'inactivity_timeout';

/**
 * Diagnostic fields the client attaches to the terminal event (turn_aborted or
 * task_complete) of a turn that our inactivity watchdog force-interrupted.
 * Shared between producer (codexAppServerClient) and consumer (runCodex) so the
 * contract can't silently drift.
 */
export interface CodexInactivityAbortFields {
    reason: typeof CODEX_INACTIVITY_ABORT_REASON;
    inactivity_timeout_ms: number;
    not_ready_mcp_servers: string[];
}

/**
 * Builds a user-facing notice when Codex's inactivity watchdog force-stops a turn.
 *
 * A watchdog-initiated abort looks "clean" to the rest of the pipeline (no error,
 * status just `cancelled`/`interrupted` — or even `completed` when codex settles
 * the interrupt that way), so without this the user sees nothing at all — the
 * turn silently ends. We only speak up for the watchdog case; a turn the user
 * cancelled themselves must stay silent.
 */
export function describeCodexInactivityAbort(msg: {
    type?: string;
    reason?: string;
    not_ready_mcp_servers?: unknown;
    inactivity_timeout_ms?: unknown;
} | null | undefined): string | null {
    if (msg?.type !== 'turn_aborted' && msg?.type !== 'task_complete') return null;
    if (msg?.reason !== CODEX_INACTIVITY_ABORT_REASON) return null;

    const servers = Array.isArray(msg.not_ready_mcp_servers)
        ? msg.not_ready_mcp_servers.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
    const seconds = typeof msg.inactivity_timeout_ms === 'number' && msg.inactivity_timeout_ms > 0
        ? Math.round(msg.inactivity_timeout_ms / 1000)
        : null;

    const durationClause = seconds !== null && seconds > 0
        ? ` after ${seconds}s with no response`
        : ' after a long silence';
    const serverClause = servers.length > 0
        ? ` An MCP server was not ready (${servers.join(', ')}), so Codex may have been unable to build its tool list and never started responding.`
        : '';

    return `Stopped automatically${durationClause}.${serverClause}`;
}

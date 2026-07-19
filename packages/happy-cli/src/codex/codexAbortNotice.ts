/**
 * Builds a user-facing notice when Codex's inactivity watchdog force-stops a turn.
 *
 * A watchdog-initiated abort looks "clean" to the rest of the pipeline (no error,
 * status just `cancelled`/`interrupted`), so without this the user sees nothing at
 * all — the turn silently ends. We only speak up for the watchdog case; a turn the
 * user cancelled themselves must stay silent.
 */
export function describeCodexInactivityAbort(msg: {
    type?: string;
    reason?: string;
    not_ready_mcp_servers?: unknown;
    inactivity_timeout_ms?: unknown;
} | null | undefined): string | null {
    if (msg?.type !== 'turn_aborted') return null;
    if (msg?.reason !== 'inactivity_timeout') return null;

    const servers = Array.isArray(msg.not_ready_mcp_servers)
        ? msg.not_ready_mcp_servers.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
    const seconds = typeof msg.inactivity_timeout_ms === 'number' && msg.inactivity_timeout_ms > 0
        ? Math.round(msg.inactivity_timeout_ms / 1000)
        : null;

    const durationClause = seconds !== null
        ? ` after ${seconds}s with no response`
        : ' after a long silence';
    const serverClause = servers.length > 0
        ? ` An MCP server was not ready (${servers.join(', ')}), so Codex may have been unable to build its tool list and never started responding.`
        : '';

    return `Stopped automatically${durationClause}.${serverClause}`;
}

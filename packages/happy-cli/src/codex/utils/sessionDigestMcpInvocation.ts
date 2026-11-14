/** Only structured calls to the built-in Common MCP may trigger Desktop digest work. */
export function isSessionDigestMcpInvocation(value: { server?: unknown; tool?: unknown } | undefined): boolean {
    return !!value && (value.server === 'aplus-common' || value.server === 'aplus_common')
        && (value.tool === 'read_project_sessions' || value.tool === 'search_project_sessions');
}

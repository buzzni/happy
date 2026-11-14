import { BrowserClientError, readDaemonControlPort, fetchBrowserStatus, requestBrowser } from '@/daemon/browserClient';
import type { BridgeRequest } from '@/claude/utils/browserTools';
import type { createProtectedToolAccess } from './protectedToolAccess';
import { hostBinding } from './hostToolCatalog';

/** The session MCP is the authenticated host boundary; the daemon pins the exact approved connection at dispatch. */
export function protectedBrowserRequest(options: {
    access: () => ReturnType<typeof createProtectedToolAccess> | null | undefined;
    signal: AbortSignal;
    admit?: <T>(work: () => Promise<T>) => Promise<T>;
}): BridgeRequest {
    return async (method, params, opts) => {
        const access = options.access();
        if (!access) throw new BrowserClientError('TOOL_ACCESS_APPROVER_REQUIRED', 'This runtime cannot ask for protected tool access. Use a runtime with human approval support.');
        const viewerKey = process.env.HAPPY_BROWSER_VIEWER_KEY;
        if (process.env.HAPPY_BROWSER_VIEWER_SCOPE_REQUIRED === '1' && !viewerKey) throw new BrowserClientError('VIEWER_SCOPE_UNAVAILABLE', 'A browser viewer identity is required');
        const daemon = await readDaemonControlPort();
        if (!daemon) throw new BrowserClientError('DAEMON_UNREACHABLE', 'The browser daemon is not running');
        const status = await fetchBrowserStatus(daemon.port, daemon.controlSecret, viewerKey);
        if (!status) throw new BrowserClientError('BRIDGE_UNAVAILABLE', 'Could not verify the browser connection');
        const connections = opts?.profile ? status.connections.filter(c => c.profile === opts.profile) : status.connections;
        if (!connections.length) throw new BrowserClientError('NO_EXTENSION_CONNECTED', 'No Chrome extension is connected');
        if (connections.length !== 1) throw new BrowserClientError('AMBIGUOUS_PROFILE', `Choose a Chrome profile: ${connections.map(c => c.profile).join(', ')}`);
        const selected = connections[0];
        if (!selected.connectionId) throw new BrowserClientError('BROWSER_APPROVAL_UNSUPPORTED', 'Update the browser daemon to support approval-bound Chrome connections');
        const args = params && typeof params === 'object' ? params as Record<string, unknown> : {};
        if (!['tabs_list', 'tabs_open', 'capabilities'].includes(method) && typeof args.tabId !== 'number') {
            throw new BrowserClientError('BROWSER_TAB_REQUIRED', 'List tabs first and pass an explicit tabId; approval cannot follow whichever tab becomes active');
        }
        const toolName = { tabs_list: 'browser_tabs', tabs_open: 'browser_open_tab', tabs_close: 'browser_close_tab' }[method] ?? `browser_${method}`;
        return access.run({ toolName: `mcp__happy__${toolName}`, binding: hostBinding([daemon, viewerKey, selected.connectionId]),
            target: { browser: 'Chrome', profile: selected.profile, ...(typeof args.tabId === 'number' ? { tabId: args.tabId } : {}) }, args }, options.signal,
        (approvedScope, assertCurrent, signal) => {
            const execute = () => { assertCurrent(); return requestBrowser({ ...daemon, method, params: approvedScope.args, profile: selected.profile,
                viewerKey, expectedConnectionId: selected.connectionId, signal }); };
            return options.admit ? options.admit(execute) : execute();
        });
    };
}

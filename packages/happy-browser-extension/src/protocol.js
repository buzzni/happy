/**
 * Command dispatch for the happy browser bridge.
 *
 * Kept free of globals — `chrome` is passed in — so the whole protocol is
 * unit-testable outside a browser. The daemon side lives in
 * happy-cli/src/daemon/browserBridge.ts.
 */

const handlers = {
    ping: async () => 'pong',

    tabs_list: async (_params, chrome) => {
        const tabs = await chrome.tabs.query({})
        return {
            tabs: tabs
                .filter((tab) => tab.id !== undefined)
                .map((tab) => ({
                    id: tab.id,
                    windowId: tab.windowId,
                    index: tab.index,
                    url: tab.url,
                    title: tab.title,
                    active: tab.active,
                })),
        }
    },
}

export async function handleCommand(message, chrome) {
    const handler = handlers[message.method]
    if (!handler) {
        return { id: message.id, error: { code: 'UNKNOWN_METHOD', message: `Unsupported method: ${message.method}` } }
    }
    try {
        return { id: message.id, result: await handler(message.params ?? {}, chrome) }
    } catch (e) {
        return { id: message.id, error: { code: 'COMMAND_FAILED', message: e instanceof Error ? e.message : String(e) } }
    }
}

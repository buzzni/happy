/**
 * The daemon's own lookup of its owner's browser key, so a Chrome extension can
 * connect itself. The server applies the same local personal machine checks as
 * Desktop setup; only the daemon token decides whose key this is.
 */
export async function fetchBrowserExtensionScope({ origin, machineId, token, fetch = globalThis.fetch }: {
    origin: string | null
    machineId: string
    token: string
    fetch?: (url: string, init: RequestInit) => Promise<Response>
}): Promise<{ viewerKey: string; account: string }> {
    if (!origin) throw new Error('SCOPE_UNAVAILABLE')
    let response: Response
    try {
        response = await fetch(`${origin}/api/machines/${encodeURIComponent(machineId)}/browser-local-setup`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'extension-scope' }), signal: AbortSignal.timeout(10000),
        })
    } catch { throw new Error('SCOPE_UNAVAILABLE') }
    if (response.status === 401 || response.status === 403) throw new Error('MACHINE_NOT_ELIGIBLE')
    const body = response.ok ? await response.json().catch(() => null) as { viewerKey?: unknown; account?: { label?: unknown } } | null : null
    if (typeof body?.viewerKey !== 'string' || typeof body.account?.label !== 'string') throw new Error('SCOPE_UNAVAILABLE')
    return { viewerKey: body.viewerKey, account: body.account.label }
}

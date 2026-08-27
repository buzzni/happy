export const BROWSER_NATIVE_HOST_NAME = 'ai.saycode.happy_browser'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export async function attemptNativePairing(chromeApi) {
    const stored = await chromeApi.storage.local.get(['token', 'viewerKey'])
    const storedToken = stored.token
    const storedViewerKey = stored.viewerKey
    const viewerScoped = typeof stored.viewerKey === 'string'
        && /^bv1_[A-Za-z0-9_-]{32}$/.test(stored.viewerKey)
    if (hasToken(stored) && !viewerScoped) {
        return { status: 'already-configured' }
    }

    let response
    try {
        response = await chromeApi.runtime.sendNativeMessage(
            BROWSER_NATIVE_HOST_NAME,
            { type: 'pair' },
        )
    } catch {
        return { status: 'unavailable' }
    }

    if (!isValidPairingResponse(response)) {
        return { status: 'invalid-response' }
    }
    const current = await chromeApi.storage.local.get(['token', 'viewerKey'])
    if (current.token !== storedToken || current.viewerKey !== storedViewerKey) {
        return { status: 'already-configured' }
    }

    await chromeApi.storage.local.set({
        token: response.config.token,
        port: response.config.port,
        host: response.config.host,
        ...(response.config.viewerKey ? { viewerKey: response.config.viewerKey } : {}),
    })
    return { status: 'paired' }
}

function hasToken(stored) {
    return typeof stored.token === 'string' && Boolean(stored.token.trim())
}

function isValidPairingResponse(response) {
    const config = response?.config
    return response?.ok === true
        && typeof config?.token === 'string'
        && config.token.length > 0
        && Number.isInteger(config?.port)
        && config.port > 0
        && config.port <= 65535
        && (
            LOOPBACK_HOSTS.has(config?.host)
            || (
                config?.host === 'host.docker.internal'
                && typeof config?.viewerKey === 'string'
                && /^bv1_[A-Za-z0-9_-]{32}$/.test(config.viewerKey)
            )
        )
}

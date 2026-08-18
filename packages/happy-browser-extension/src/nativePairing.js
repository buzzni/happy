export const BROWSER_NATIVE_HOST_NAME = 'ai.saycode.happy_browser'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export async function attemptNativePairing(chromeApi) {
    const stored = await chromeApi.storage.local.get(['token'])
    if (hasToken(stored)) {
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
    if (hasToken(await chromeApi.storage.local.get(['token']))) {
        return { status: 'already-configured' }
    }

    await chromeApi.storage.local.set({
        token: response.config.token,
        port: response.config.port,
        host: response.config.host,
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
        && LOOPBACK_HOSTS.has(config?.host)
}

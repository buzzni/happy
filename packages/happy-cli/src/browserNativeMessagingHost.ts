import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BROWSER_BRIDGE_PORT, resolveBrowserBridgeHost } from './daemon/browserBridgeConfig'
import { runBrowserNativeMessagingHost } from './daemon/browserNativeMessagingHost'
import { readOrCreateBrowserBridgeToken, resolveBrowserBridgeTokenFile } from './daemon/browserBridgeToken'
import { readFile } from 'node:fs/promises'

const userHome = homedir()
const happyHomeDir = process.env.HAPPY_HOME_DIR?.replace(/^~/, userHome) ?? join(userHome, '.happy')
const bridgeToken = resolveBrowserBridgeTokenFile({ homeDir: userHome, happyHomeDir })

/** Offer and connect wait for the daemon's own Studio lookup (10s) and keep its coded refusal. */
const STUDIO_ROUND_TRIP = { keepRefusal: true, timeoutMs: 15000 }

void runBrowserNativeMessagingHost({
    input: process.stdin,
    write: (chunk) => { process.stdout.write(chunk) },
    writeError: (message) => { process.stderr.write(message) },
    readToken: () => readOrCreateBrowserBridgeToken(bridgeToken.tokenFile, {
        migrateFrom: bridgeToken.migrateFrom,
    }),
    port: DEFAULT_BROWSER_BRIDGE_PORT,
    host: resolveBrowserBridgeHost(process.env),
    consumeSetup: operationId => postLocalSetup('consume', { operationId }),
    offerConnect: () => postLocalSetup('offer', {}, STUDIO_ROUND_TRIP),
    connect: profile => postLocalSetup('connect', { profile }, STUDIO_ROUND_TRIP),
})

/** `keepRefusal` returns a daemon's coded 409 when no home accepts, instead of reporting no daemon. */
async function postLocalSetup(path: string, body: unknown, { keepRefusal = false, timeoutMs = 2000 } = {}): Promise<unknown> {
    let refusal: unknown
    // Chrome does not inherit the daemon's HAPPY_HOME_DIR. Probe only the
    // documented personal/Standalone homes; each endpoint authenticates
    // with that home's own control secret and accepts its own nonce only.
    for (const home of new Set([happyHomeDir, join(userHome, '.happy_local'), join(userHome, '.happy_local_dev')])) {
        try {
            const state = JSON.parse(await readFile(join(home, 'daemon.state.json'), 'utf8'))
            if (!Number.isInteger(state.httpPort) || state.httpPort < 1 || state.httpPort > 65535 || typeof state.controlSecret !== 'string') continue
            const response = await fetch(`http://127.0.0.1:${state.httpPort}/browser/local-setup/${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.controlSecret}` },
                body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
            })
            if (response.ok) return await response.json()
            if (keepRefusal && response.status === 409) refusal = await response.json()
        } catch { /* try the other explicitly known local runtime */ }
    }
    if (refusal !== undefined) return refusal
    throw new Error('SETUP_UNAVAILABLE')
}

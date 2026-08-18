import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BROWSER_BRIDGE_PORT, resolveBrowserBridgeHost } from './daemon/browserBridgeConfig'
import { runBrowserNativeMessagingHost } from './daemon/browserNativeMessagingHost'
import { readOrCreateBrowserBridgeToken, resolveBrowserBridgeTokenFile } from './daemon/browserBridgeToken'

const userHome = homedir()
const happyHomeDir = process.env.HAPPY_HOME_DIR?.replace(/^~/, userHome) ?? join(userHome, '.happy')
const bridgeToken = resolveBrowserBridgeTokenFile({ homeDir: userHome, happyHomeDir })

void runBrowserNativeMessagingHost({
    input: process.stdin,
    write: (chunk) => { process.stdout.write(chunk) },
    writeError: (message) => { process.stderr.write(message) },
    readToken: () => readOrCreateBrowserBridgeToken(bridgeToken.tokenFile, {
        migrateFrom: bridgeToken.migrateFrom,
    }),
    port: DEFAULT_BROWSER_BRIDGE_PORT,
    host: resolveBrowserBridgeHost(process.env),
})

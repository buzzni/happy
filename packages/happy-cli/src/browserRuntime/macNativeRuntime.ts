import type { RuntimeConfig } from './runtimeConfig'
import { acquireNativeWriterLock, dropMacServiceIdentity, verifyMacPrivateDirectory, verifyMacServiceFile } from './nativeHostPrimitives'
import { prepareMacNativeBrowser } from './macNativeBrowserProcess'
import { createNativeEgressProxy } from './nativeEgressProxy'

const root = '/Library/Application Support/SaycodeNative'

/** Fixed launchd service bootstrap. Only setup/identity code runs as root; CDP,
 * SOCKS and HTTP parsing start after the irreversible identity transition. */
export async function bootstrapMacNativeRuntime(config: RuntimeConfig, stateDir: string) {
    const native = config.nativeService
    if (!native || process.platform !== 'darwin' || process.getuid?.() !== 0 ||
        process.env.ABP_CONFIG_FILE !== `${root}/runtime.json` || stateDir !== `${root}/runtime-state` ||
        process.env.ABP_KEYS_FILE || process.env.ABP_PROFILES || process.env.ABP_VNC_PASSWORD || process.env.ABP_VNC_PASSWORD_FILE)
        throw new Error('ABP native service requires the installed protected configuration')
    await verifyMacServiceFile(`${root}/runtime.json`)
    await verifyMacPrivateDirectory(stateDir, native.runtimeUid)
    await verifyMacPrivateDirectory(`${root}/run`, native.runtimeUid, true)
    const lock = await acquireNativeWriterLock(`${root}/writer.lock`)
    const proxy = createNativeEgressProxy()
    let browser: Awaited<ReturnType<typeof prepareMacNativeBrowser>> | undefined
    try {
        browser = await prepareMacNativeBrowser({ ...native, runtimeUid: native.runtimeUid })
        dropMacServiceIdentity(native.runtimeUid, native.runtimeGid)
        await new Promise<void>((resolve, reject) => {
            proxy.server.once('error', reject)
            proxy.server.listen(native.proxyPort, '127.0.0.1', () => { proxy.server.off('error', reject); resolve() })
        })
        const session = await browser.connect({ maxAgentWindows: config.maxAgentWindows, setAllowedOrigins: origins => proxy.setAllowedOrigins(origins) })
        let closing: Promise<void> | undefined
        return { session,
            close: () => closing ??= (async () => {
                const result = await session.close()
                await proxy.close()
                await lock.close()
                if (!result.terminated) throw new Error('ABP native browser termination is unconfirmed')
            })(),
        }
    } catch (error) {
        // Startup failure is fatal; never fall back to a user-owned Chrome/socket.
        const cleanup = await Promise.allSettled([
            browser?.terminate(), proxy.close(), lock.close(),
        ])
        if (cleanup.some(result => result.status === 'rejected')) throw new Error('ABP native startup cleanup is unconfirmed')
        throw error
    }
}

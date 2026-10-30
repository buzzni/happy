// Bundled by windows-personal-runtime.check.mjs: opens one loopback page through the
// personal runtime bootstrap on the target host and prints one JSON line. Uses the
// caller's disposable user directory; never touches the signed-in user's own profile.
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { enterNativeOwnedJob } from '../src/browserRuntime/nativeHostPrimitives'
import { bootstrapPersonalDesktopRuntime } from '../src/browserRuntime/personalDesktopRuntime'
import { loadRuntimeConfig } from '../src/browserRuntime/runtimeConfig'

const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Personal</title><p>Personal mode canary</p>') })
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`
const runtime = await bootstrapPersonalDesktopRuntime(loadRuntimeConfig(process.env.ABP_CONFIG_FILE!), process.env.ABP_STATE_DIR!, { parent: new PassThrough() })
const result: Record<string, unknown> = {}
try {
    const tab = await runtime.session.driver.openTab(origin, [origin], { timeoutMs: 20000 })
    result.observed = JSON.stringify(await runtime.session.driver.observe(tab.tabId, [origin], { timeoutMs: 20000 })).includes('Personal mode canary')
    result.membersWhileOpen = process.platform === 'win32' ? enterNativeOwnedJob().members().length : undefined
    await runtime.session.check()
} finally {
    await runtime.close().then(() => { result.closed = true }, error => { result.closeError = (error as Error).message })
    result.membersAfterClose = process.platform === 'win32' ? enterNativeOwnedJob().members().length : undefined
    site.close()
}
process.stdout.write(JSON.stringify(result) + '\n')

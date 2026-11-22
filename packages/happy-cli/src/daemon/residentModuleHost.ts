import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

/**
 * Whether this daemon serves the resident bundle: a plain Node with synchronous loader hooks, unless disabled for comparison.
 * The bundle carries the sandbox runtime: macOS generates its Seatbelt profile, and Linux finds the seccomp filter that
 * bundle-resident-session.mjs copies to dist/vendor/seccomp, next to the bundled module URL.
 */
export function residentModulesEnabled(runtime: {
  platform: NodeJS.Platform
  versions: { electron?: string; bun?: string; [name: string]: string | undefined }
  hasRegisterHooks: boolean
  env: NodeJS.ProcessEnv
  /** Linux only: the bundle carries this machine's seccomp filter (bundledSeccompFilterPresent). */
  linuxSeccompFilter: boolean
}) {
  return ['win32', 'darwin', 'linux'].includes(runtime.platform) && !runtime.versions.electron && !runtime.versions.bun
    && runtime.hasRegisterHooks && runtime.env.HAPPY_DISABLE_RESIDENT_MODULES !== '1'
    && (runtime.platform !== 'linux' || runtime.linuxSeccompFilter)
}

/** The filter the bundled sandbox runtime looks up for this architecture, using its own x64/arm64 vendor names. */
export function bundledSeccompFilterPresent(root: string, arch: string = process.arch) {
  const vendorArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null
  return vendorArch !== null && existsSync(join(root, 'dist', 'vendor', 'seccomp', vendorArch, 'unix-block.bpf'))
}

/** Loads verified installation code once. Session data and project files never reach this listener. */
export function startResidentModuleHost(root: string) {
  const source = join(root, 'dist', 'win32-resident')
  const token = randomBytes(32).toString('hex')
  let descriptor: string | undefined
  let stopping = false
  let snapshot: Buffer | undefined
  const server = createServer({ requestTimeout: 2_000, headersTimeout: 2_000 }, (request, response) => {
    if (!snapshot || request.method !== 'GET' || request.url !== '/modules'
      || request.headers.authorization !== 'Bearer ' + token) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Content-Length', snapshot.length)
    response.end(snapshot)
  })

  const ready = (async () => {
    const files = (await readdir(source, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
    if (!files.some(entry => entry.name === 'index.mjs')) return false
    const modules: Array<[string, string]> = []
    for (const entry of files) {
      if (stopping) return false
      modules.push([entry.name, await readFile(join(source, entry.name), 'utf8')])
    }
    if (stopping) return false
    snapshot = Buffer.from(JSON.stringify(modules))
    if (snapshot.length > 32 * 1024 * 1024) { snapshot = undefined; return false }
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    if (stopping) { server.close(); return false }
    const address = server.address()
    if (!address || typeof address === 'string') { server.close(); return false }
    server.unref()
    descriptor = JSON.stringify({ version: 1, port: address.port, token })
    return true
  })().catch(() => false)

  return {
    ready,
    descriptor: () => descriptor,
    async close() {
      stopping = true
      descriptor = undefined
      snapshot = undefined
      await ready
      if (!server.listening) return
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    },
  }
}

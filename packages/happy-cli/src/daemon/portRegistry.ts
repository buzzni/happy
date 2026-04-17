/**
 * Per-project port allocation registry.
 *
 * Each daemon process owns a JSON file (typically `~/.happy-dev/port-registry.json`)
 * that maps `projectId -> { port, allocatedAt }`. A project gets one sticky port in
 * the configured range (default 30000-40000). If a previously assigned port is no
 * longer bindable, the entry is replaced with a freshly allocated port.
 *
 * Concurrent `allocate`/`release` calls are serialized with an in-process promise
 * chain so two parallel requests cannot race into the same port.
 */

import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export interface PortRegistryEntry {
  port: number
  allocatedAt: number
}

export type PortRegistryData = Record<string, PortRegistryEntry>

export interface AllocateResult {
  port: number
  reused: boolean
}

export interface PortRegistry {
  allocate(projectId: string): Promise<AllocateResult>
  release(projectId: string): Promise<boolean>
  readAll(): Promise<PortRegistryData>
}

export interface PortRegistryOptions {
  filePath: string
  portMin?: number
  portMax?: number
  /** Injected for testing. Default uses `net.createServer().listen()`. */
  isPortBindable?: (port: number) => Promise<boolean>
}

export const DEFAULT_PORT_MIN = 30000
export const DEFAULT_PORT_MAX = 40000

const defaultIsPortBindable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => {
      srv.close(() => resolve(true))
    })
    srv.listen(port, '0.0.0.0')
  })

async function readRegistry(filePath: string): Promise<PortRegistryData> {
  try {
    const text = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PortRegistryData
    }
    return {}
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { name?: string }
    if (err.code === 'ENOENT') return {}
    if (err.name === 'SyntaxError') return {}
    throw e
  }
}

async function writeRegistry(filePath: string, data: PortRegistryData): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, filePath)
}

export function createPortRegistry(opts: PortRegistryOptions): PortRegistry {
  const portMin = opts.portMin ?? DEFAULT_PORT_MIN
  const portMax = opts.portMax ?? DEFAULT_PORT_MAX
  const isBindable = opts.isPortBindable ?? defaultIsPortBindable
  let tail: Promise<unknown> = Promise.resolve()

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work)
    tail = next.catch(() => undefined)
    return next
  }

  const scanForFreePort = async (
    data: PortRegistryData,
  ): Promise<number | null> => {
    const taken = new Set<number>()
    for (const entry of Object.values(data)) taken.add(entry.port)
    for (let port = portMin; port <= portMax; port++) {
      if (taken.has(port)) continue
      if (await isBindable(port)) return port
    }
    return null
  }

  return {
    async readAll() {
      return readRegistry(opts.filePath)
    },

    async allocate(projectId) {
      return serialize(async () => {
        const data = await readRegistry(opts.filePath)
        const existing = data[projectId]
        if (existing && (await isBindable(existing.port))) {
          return { port: existing.port, reused: true }
        }
        if (existing) delete data[projectId]
        const port = await scanForFreePort(data)
        if (port === null) {
          throw new Error(`No available port in range ${portMin}-${portMax}`)
        }
        data[projectId] = { port, allocatedAt: Date.now() }
        await writeRegistry(opts.filePath, data)
        return { port, reused: false }
      })
    },

    async release(projectId) {
      return serialize(async () => {
        const data = await readRegistry(opts.filePath)
        if (!(projectId in data)) return false
        delete data[projectId]
        await writeRegistry(opts.filePath, data)
        return true
      })
    },
  }
}

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export type AgentBrokerResult = { stdout: string; exitCode: 0 | 3; projection?: unknown }
const MAX_BYTES = 1024 * 1024
const VERBS = new Set(['whoami', 'ls', 'read', 'wait', 'spawn', 'prompt', 'search', 'steer', 'stop'])

/** Session-local capability; neither arbitrary commands nor caller identity are accepted. */
export async function startAgentBroker(input: {
  execute: (argv: string[], signal: AbortSignal) => Promise<AgentBrokerResult>
}) {
  const token = randomBytes(32).toString('base64url')
  const active = new Set<AbortController>()
  const pending = new Set<Promise<void>>()
  let closing = false, spawning = false
  const server = createServer(async (req, res) => {
    if (closing) { res.writeHead(503).end(); return }
    if (req.headers.origin !== undefined) { res.writeHead(403).end(); return }
    const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return }
    if (req.method !== 'POST' || req.url !== '/agent') { res.writeHead(404).end(); return }
    if (active.size >= 8) { res.writeHead(429).end(); return }
    const controller = new AbortController()
    active.add(controller)
    let finished!: () => void
    const done = new Promise<void>(resolve => { finished = resolve })
    pending.add(done)
    const timer = setTimeout(() => { controller.abort(); res.destroy() }, 650_000)
    res.once('close', () => controller.abort())
    let isSpawn = false
    try {
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > MAX_BYTES) { res.writeHead(413).end(); return }
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (!body || Object.keys(body).sort().join(',') !== 'argv,version' || body.version !== 1
        || !Array.isArray(body.argv) || body.argv.length > 256 || !body.argv.every((s: unknown) => typeof s === 'string' && !s.includes('\0'))
        || !VERBS.has(body.argv[0])) { res.writeHead(400).end(); return }
      if (controller.signal.aborted || closing) { res.writeHead(503).end(); return }
      isSpawn = body.argv[0] === 'spawn'
      if (isSpawn && spawning) { isSpawn = false; res.writeHead(409).end(); return }
      if (isSpawn) spawning = true
      const result = await input.execute(body.argv, controller.signal)
      const serialized = JSON.stringify(result)
      if (Buffer.byteLength(serialized) > MAX_BYTES) { res.writeHead(502).end(); return }
      if (!controller.signal.aborted) res.writeHead(200, { 'content-type': 'application/json' }).end(serialized)
    } catch {
      if (!res.headersSent) res.writeHead(400).end()
    } finally {
      clearTimeout(timer); active.delete(controller); pending.delete(done); finished()
      if (isSpawn) spawning = false
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  return {
    environment: { SAYCODE_AGENT_BROKER_URL: `http://127.0.0.1:${port}/agent`, SAYCODE_AGENT_BROKER_CAPABILITY: token },
    close: async () => {
      closing = true
      for (const controller of active) controller.abort()
      server.closeAllConnections()
      await Promise.all([...pending])
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

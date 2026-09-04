import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import { createPortRegistry } from './portRegistry'
import { startDaemonControlServer } from './controlServer'
import { encrypt, decrypt, encodeBase64, decodeBase64, getRandomBytes } from '@/api/encryption'
import { getDaemonTerminalSession, getDaemonTerminalSessionCount, _resetDaemonTerminalSessionsForTest } from './daemonTerminalSessions'

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('waitFor timeout')
}

describe('/terminal WS auth (T6)', () => {
  let dir: string
  let port: number
  let controlSecret: string
  let stopServer: () => Promise<void>

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-terminal-ws-'))
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
    })
    port = server.port
    controlSecret = server.controlSecret
    stopServer = server.stop
  })

  afterEach(async () => {
    await stopServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects an upgrade with no Authorization header', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`)
    const outcome = await new Promise<'open' | { code: number }>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('unexpected-response', (_req, res) => resolve({ code: res.statusCode ?? 0 }))
      ws.on('error', () => { /* the unexpected-response handler already resolved */ })
    })
    expect(outcome).toEqual({ code: 401 })
  })

  it('rejects an upgrade with the wrong secret', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, {
      headers: { Authorization: 'Bearer not-the-secret' },
    })
    const outcome = await new Promise<'open' | { code: number }>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('unexpected-response', (_req, res) => resolve({ code: res.statusCode ?? 0 }))
      ws.on('error', () => {})
    })
    expect(outcome).toEqual({ code: 401 })
  })

  it('accepts an upgrade with the correct secret', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, {
      headers: { Authorization: `Bearer ${controlSecret}` },
    })
    const outcome = await new Promise<'open' | { code: number }>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('unexpected-response', (_req, res) => resolve({ code: res.statusCode ?? 0 }))
      ws.on('error', () => {})
    })
    expect(outcome).toBe('open')
    ws.close()
  })

  it('stop() closes an open /terminal connection instead of leaving it dangling', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, {
      headers: { Authorization: `Bearer ${controlSecret}` },
    })
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))
    const stop = stopServer
    stopServer = async () => {} // afterEach also stops; avoid a double app.close()
    await stop()
    await closed
  })
})

// T7/T8: terminal-open -> ack, then bidirectional frames/resize/close over
// the same connection, encrypted the same way the relay path is.
describe('/terminal WS protocol (T7-T8)', () => {
  let dir: string
  let port: number
  let controlSecret: string
  let stopServer: () => Promise<void>
  let machineEncryption: { encryptionKey: Uint8Array; encryptionVariant: 'legacy' } | null

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-terminal-ws-proto-'))
    machineEncryption = { encryptionKey: getRandomBytes(32), encryptionVariant: 'legacy' }
    const registry = createPortRegistry({
      filePath: path.join(dir, 'port-registry.json'),
      portMin: 30000,
      portMax: 30010,
      isPortBindable: async () => true,
    })
    const server = await startDaemonControlServer({
      getChildren: () => [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }),
      spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      portRegistry: registry,
      allowedRoot: dir,
      getMachineEncryption: () => machineEncryption,
    })
    port = server.port
    controlSecret = server.controlSecret
    stopServer = server.stop
  })

  afterEach(async () => {
    await stopServer()
    _resetDaemonTerminalSessionsForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  function connect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, {
      headers: { Authorization: `Bearer ${controlSecret}` },
    })
    return new Promise((resolve) => ws.on('open', () => resolve(ws)))
  }

  /** Encrypts open params the same way desktop's `openRemoteTerminal` does. */
  function openParams(overrides: Record<string, unknown> = {}): string {
    return encodeBase64(encrypt(machineEncryption!.encryptionKey, machineEncryption!.encryptionVariant, {
      userId: 'user-1',
      cols: 80,
      rows: 24,
      shell: process.execPath,
      args: ['-e', overrides.script ?? "process.stdout.write('READY\\n')"],
      ...overrides,
    }))
  }

  function nextMessage(ws: WebSocket): Promise<any> {
    return new Promise((resolve) => {
      ws.once('message', (raw: RawData) => resolve(JSON.parse(raw.toString())))
    })
  }

  function decryptFrame(msg: any): string {
    expect(msg.data.event).toBe('terminal-frame')
    return decrypt(machineEncryption!.encryptionKey, machineEncryption!.encryptionVariant, decodeBase64(msg.data.data))
  }

  it('opens a PTY and acks with sessionId + local:true caps', async () => {
    const ws = await connect()
    const reqId = randomUUID()
    ws.send(JSON.stringify({ reqId, event: 'terminal-open', data: { machineId: 'm1', params: openParams() } }))

    const ack = await nextMessage(ws)
    expect(ack.reqId).toBe(reqId)
    expect(ack.data.ok).toBe(true)
    expect(typeof ack.data.sessionId).toBe('string')
    expect(ack.data.caps).toEqual({ resume: false, snapshot: false, local: true })
    ws.close()
  })

  it('errors the ack instead of opening when the machine key is not ready yet', async () => {
    machineEncryption = null
    const ws = await connect()
    const reqId = randomUUID()
    ws.send(JSON.stringify({ reqId, event: 'terminal-open', data: { machineId: 'm1', params: 'irrelevant' } }))

    const ack = await nextMessage(ws)
    expect(ack.reqId).toBe(reqId)
    expect(ack.data).toBeUndefined()
    expect(ack.error).toMatch(/not ready/)
    ws.close()
  })

  it('errors the ack when params were encrypted with a different key', async () => {
    const ws = await connect()
    const reqId = randomUUID()
    const wrongKeyParams = encodeBase64(encrypt(getRandomBytes(32), 'legacy', { cols: 80, rows: 24 }))
    ws.send(JSON.stringify({ reqId, event: 'terminal-open', data: { machineId: 'm1', params: wrongKeyParams } }))

    const ack = await nextMessage(ws)
    expect(ack.error).toMatch(/decrypt/)
    ws.close()
  })

  it('relays an input frame to the pty and the pty output back as an encrypted frame', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({
      reqId: randomUUID(),
      event: 'terminal-open',
      data: {
        machineId: 'm1',
        params: openParams({
          script: "process.stdin.on('data', (c) => process.stdout.write('echo:' + c))",
        }),
      },
    }))
    const ack = await nextMessage(ws)
    const sessionId = ack.data.sessionId

    ws.send(JSON.stringify({
      event: 'terminal-frame',
      // Trailing \n: the pty's canonical-mode line discipline buffers input
      // until a newline, so the child's stdin 'data' handler never fires
      // without one — only the pty's own local echo of the raw keystrokes
      // would come back.
      data: { sessionId, data: encodeBase64(encrypt(machineEncryption!.encryptionKey, 'legacy', 'PING\n')) },
    }))

    // Collect frames until one contains the echo — startup timing can add an
    // extra frame or two before the echo arrives.
    let text = ''
    for (let i = 0; i < 10 && !text.includes('echo:PING'); i++) {
      text += decryptFrame(await nextMessage(ws))
    }
    expect(text).toContain('echo:PING')
    ws.close()
  })

  it('resizes the pty', async () => {
    // Asserts via the session registry's own cols/rows bookkeeping
    // (matches remoteTerminal.test.ts's "resize updates cols/rows on the
    // session"), not by observing SIGWINCH reach a spawned child — the
    // latter depends on the sandbox actually granting a real pty ioctl,
    // which this harness's environment does not reliably do.
    const ws = await connect()
    ws.send(JSON.stringify({
      reqId: randomUUID(),
      event: 'terminal-open',
      data: { machineId: 'm1', params: openParams({ script: 'setInterval(() => {}, 1000)' }) },
    }))
    const ack = await nextMessage(ws)
    const sessionId = ack.data.sessionId
    expect(getDaemonTerminalSession(sessionId)?.session.cols).toBe(80)

    ws.send(JSON.stringify({ event: 'terminal-resize', data: { sessionId, cols: 120, rows: 40 } }))
    await waitFor(() => getDaemonTerminalSession(sessionId)?.session.cols === 120, 3_000)

    expect(getDaemonTerminalSession(sessionId)?.session.rows).toBe(40)
    ws.close()
  })

  it('terminates the pty on terminal-close and pushes terminal-closed', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({
      reqId: randomUUID(),
      event: 'terminal-open',
      data: { machineId: 'm1', params: openParams({ script: "setInterval(() => {}, 1000)" }) },
    }))
    const ack = await nextMessage(ws)
    const sessionId = ack.data.sessionId
    expect(getDaemonTerminalSessionCount()).toBe(1)

    ws.send(JSON.stringify({ event: 'terminal-close', data: { sessionId } }))

    let closedMsg: any = null
    for (let i = 0; i < 5 && !closedMsg; i++) {
      const msg = await nextMessage(ws)
      if (msg.data?.event === 'terminal-closed') closedMsg = msg
    }
    expect(closedMsg.data.sessionId).toBe(sessionId)
    expect(getDaemonTerminalSessionCount()).toBe(0)
    ws.close()
  })

  it('pushes terminal-closed when the pty exits on its own', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({
      reqId: randomUUID(),
      event: 'terminal-open',
      data: { machineId: 'm1', params: openParams({ script: 'process.exit(3)' }) },
    }))
    const ack = await nextMessage(ws)
    const sessionId = ack.data.sessionId

    let closedMsg: any = null
    for (let i = 0; i < 5 && !closedMsg; i++) {
      const msg = await nextMessage(ws)
      if (msg.data?.event === 'terminal-closed') closedMsg = msg
    }
    expect(closedMsg.data.sessionId).toBe(sessionId)
    expect(closedMsg.data.code).toBe(3)
    expect(getDaemonTerminalSessionCount()).toBe(0)
    ws.close()
  })
})

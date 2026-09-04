import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createPortRegistry } from './portRegistry'
import { startDaemonControlServer } from './controlServer'

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

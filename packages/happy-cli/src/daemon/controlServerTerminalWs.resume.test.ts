/**
 * specs/codexcli-daemon-stream-durability B-R1 (Phase B2a) — the same-machine
 * direct path keeps a terminal across a dropped WebSocket: the PTY lives in a
 * daemon registry for a grace window, a new WebSocket takes it back with
 * `terminal-attach`, and `terminal-resume` replays what it missed by the same
 * rules as the relay path.
 *
 * Runs against a real PTY (a node child), like controlServerTerminalWs.test.ts,
 * with the grace window shortened through the route option rather than fake
 * timers — real sockets and fake clocks do not mix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import { attachTerminalWsRoute, type TerminalWsRoute } from './controlServerTerminalWs'
import { encrypt, decrypt, encodeBase64, decodeBase64, getRandomBytes } from '@/api/encryption'
import { getDaemonTerminalSession, getDaemonTerminalSessionCount, _resetDaemonTerminalSessionsForTest } from './daemonTerminalSessions'

const GRACE_MS = 1_500
const SECRET = 'test-control-secret'

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('waitFor timeout')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('/terminal WS reattach and replay (B2a)', () => {
  let dir: string
  let httpServer: Server
  let route: TerminalWsRoute
  let port: number
  const key = getRandomBytes(32)
  const machineEncryption = { encryptionKey: key, encryptionVariant: 'legacy' as const }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'control-server-terminal-ws-resume-'))
    httpServer = createServer()
    route = attachTerminalWsRoute(httpServer, {
      path: '/terminal',
      controlSecret: SECRET,
      allowedRoot: dir,
      getMachineEncryption: () => machineEncryption,
      detachGraceMs: GRACE_MS,
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
    port = (httpServer.address() as { port: number }).port
  })

  afterEach(async () => {
    await route.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    _resetDaemonTerminalSessionsForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Every message a socket receives, in order, from the moment it connects. */
  interface Client { ws: WebSocket; inbox: any[]; closed: Promise<number> }

  function connect(): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?token=${SECRET}`)
    const inbox: any[] = []
    ws.on('message', (raw: RawData) => inbox.push(JSON.parse(raw.toString())))
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    return new Promise((resolve) => ws.on('open', () => resolve({ ws, inbox, closed })))
  }

  const seal = (value: unknown, sealKey = key) => encodeBase64(encrypt(sealKey, 'legacy', value))
  const open = (value: string) => decrypt(key, 'legacy', decodeBase64(value)) as string

  async function request(client: Client, event: string, data: unknown): Promise<any> {
    const reqId = randomUUID()
    client.ws.send(JSON.stringify({ reqId, event, data }))
    await waitFor(() => client.inbox.some((m) => m.reqId === reqId), 5_000)
    return client.inbox.find((m) => m.reqId === reqId)
  }

  async function openTerminal(client: Client, script: string, userId = 'user-1') {
    const ack = await request(client, 'terminal-open', {
      machineId: 'm1',
      params: seal({ userId, cols: 80, rows: 24, shell: process.execPath, args: ['-e', script] }),
    })
    return ack
  }

  const frames = (client: Client) => client.inbox.filter((m) => m.data?.event === 'terminal-frame').map((m) => m.data)
  const pushes = (client: Client, event: string) => client.inbox.filter((m) => m.data?.event === event).map((m) => m.data)
  const ticks = (text: string) => [...text.matchAll(/T(\d+);/g)].map((m) => Number(m[1]))

  const TICKER = "let i = 0; setInterval(() => process.stdout.write('T' + (i++) + ';'), 20)"

  it('advertises resume, attach and paged resume, and sequences every frame', async () => {
    const client = await connect()
    const ack = await openTerminal(client, TICKER)
    expect(ack.data.caps).toEqual({ resume: true, snapshot: true, local: true, attach: true, pagedResume: true })
    await waitFor(() => frames(client).length >= 3, 5_000)
    expect(frames(client).slice(0, 3).map((f) => f.seq)).toEqual([1, 2, 3])
    client.ws.close()
  })

  it('reattaches a new WebSocket after a drop and replays the gap without loss or duplicates', async () => {
    const first = await connect()
    const { data: { sessionId } } = await openTerminal(first, TICKER)
    await waitFor(() => frames(first).length >= 3, 5_000)
    first.ws.terminate() // abrupt drop, no close handshake
    await first.closed
    const seen = frames(first)
    const lastSeen = seen[seen.length - 1].seq
    seen.forEach((frame, i) => expect(frame.seq).toBe(i + 1))
    await sleep(300) // the PTY keeps printing while nobody is attached

    expect(getDaemonTerminalSession(sessionId)).not.toBeNull()
    const second = await connect()
    const attach = await request(second, 'terminal-attach', {
      sessionId,
      params: seal({ sessionId, afterSeq: lastSeen, userId: 'user-1' }),
    })
    expect(attach.data).toMatchObject({ ok: true, sessionId, caps: { resume: true, attach: true } })
    second.ws.send(JSON.stringify({ event: 'terminal-resume', data: { sessionId, afterSeq: lastSeen } }))
    await sleep(300)

    // Live output reaches the new socket as soon as it attaches, ahead of the
    // replay; the desktop transport applies frames strictly in seq order and
    // drops anything else (transport.ts applyFrame). Apply the same rule.
    const applied: any[] = []
    let lastSeq = lastSeen
    for (const frame of frames(second)) {
      if (frame.seq !== lastSeq + 1) continue
      applied.push(frame)
      lastSeq = frame.seq
    }
    expect(applied.length).toBeGreaterThan(5)
    // Every frame the dropped socket missed came back, in order, exactly once.
    const delivered = Math.max(...frames(second).map((f) => f.seq))
    expect(lastSeq).toBe(delivered)
    const text = seen.map((f) => open(f.data)).join('') + applied.map((f) => open(f.data)).join('')
    const numbers = ticks(text)
    expect(numbers.length).toBeGreaterThan(10)
    numbers.forEach((n, i) => expect(n).toBe(i))
    second.ws.close()
  })

  it('terminates the PTY once the grace window passes with nobody attached, then refuses an attach as unknown', async () => {
    const first = await connect()
    const { data: { sessionId } } = await openTerminal(first, 'setInterval(() => {}, 1000)')
    first.ws.close()
    await first.closed
    await waitFor(() => getDaemonTerminalSession(sessionId) === null, GRACE_MS + 3_000)

    const second = await connect()
    const attach = await request(second, 'terminal-attach', {
      sessionId,
      params: seal({ sessionId, afterSeq: 0, userId: 'user-1' }),
    })
    expect(attach.error).toMatch(/unknown-session/)
    expect(pushes(second, 'terminal-closed')).toEqual([{ event: 'terminal-closed', sessionId, reason: 'unknown-session' }])
    second.ws.close()
  })

  it('refuses an attach sealed with another key, for another user, or for a different session id — all with the same answer', async () => {
    const first = await connect()
    const { data: { sessionId } } = await openTerminal(first, 'setInterval(() => {}, 1000)')
    first.ws.close()
    await first.closed

    const attempts = [
      seal({ sessionId, afterSeq: 0, userId: 'user-1' }, getRandomBytes(32)),
      seal({ sessionId, afterSeq: 0, userId: 'someone-else' }),
      seal({ sessionId: 'other-session', afterSeq: 0, userId: 'user-1' }),
    ]
    for (const params of attempts) {
      const client = await connect()
      const attach = await request(client, 'terminal-attach', { sessionId, params })
      expect(attach.error).toMatch(/unknown-session/)
      expect(pushes(client, 'terminal-closed')).toEqual([{ event: 'terminal-closed', sessionId, reason: 'unknown-session' }])
      client.ws.close()
    }
    // None of the refused attempts took the terminal: the PTY still waits in grace.
    expect(getDaemonTerminalSession(sessionId)).not.toBeNull()
  })

  it('moves the terminal to the newest attach and disconnects the old WebSocket', async () => {
    const first = await connect()
    const { data: { sessionId } } = await openTerminal(first, "process.stdin.on('data', (c) => process.stdout.write('echo:' + c))")
    const second = await connect()
    const attach = await request(second, 'terminal-attach', {
      sessionId,
      params: seal({ sessionId, afterSeq: 0, userId: 'user-1' }),
    })
    expect(attach.data.ok).toBe(true)
    await first.closed

    second.ws.send(JSON.stringify({ event: 'terminal-frame', data: { sessionId, data: seal('PING\n') } }))
    await waitFor(() => frames(second).map((f) => open(f.data)).join('').includes('echo:PING'), 5_000)
    expect(getDaemonTerminalSession(sessionId)).not.toBeNull()
    second.ws.close()
  })

  it('delivers the remaining output and the exit code to a client that reattaches after the PTY ended', async () => {
    const first = await connect()
    const { data: { sessionId } } = await openTerminal(first, "process.stdin.on('data', () => { process.stdout.write('BYE;'); process.exit(7) })")
    await sleep(200)
    first.ws.send(JSON.stringify({ event: 'terminal-frame', data: { sessionId, data: seal('x\n') } }))
    first.ws.terminate()
    await first.closed
    const lastSeen = frames(first).reduce((max, f) => Math.max(max, f.seq), 0)
    await sleep(500) // the PTY exits while nobody is attached

    const second = await connect()
    const attach = await request(second, 'terminal-attach', {
      sessionId,
      params: seal({ sessionId, afterSeq: lastSeen, userId: 'user-1' }),
    })
    expect(attach.data.ok).toBe(true)
    second.ws.send(JSON.stringify({ event: 'terminal-resume', data: { sessionId, afterSeq: lastSeen } }))
    await waitFor(() => pushes(second, 'terminal-closed').length > 0, 3_000)

    const text = [...frames(first), ...frames(second)].map((f) => open(f.data)).join('')
    expect(text).toContain('BYE;')
    expect(pushes(second, 'terminal-closed')[0]).toMatchObject({ sessionId, code: 7 })
    // The closed frame comes after the replayed output, never before it.
    const closedAt = second.inbox.findIndex((m) => m.data?.event === 'terminal-closed')
    const lastFrameAt = second.inbox.map((m) => m.data?.event).lastIndexOf('terminal-frame')
    expect(closedAt).toBeGreaterThan(lastFrameAt)
    await waitFor(() => getDaemonTerminalSession(sessionId) === null, 2_000)
    second.ws.close()
  })

  it('holds the exit back until the last page when the PTY ends during a paged replay', async () => {
    const client = await connect()
    const { data: { sessionId } } = await openTerminal(client, "process.stdout.write('x'.repeat(30000)); process.stdin.on('data', () => process.exit(5))")
    await waitFor(() => frames(client).reduce((n, f) => n + open(f.data).length, 0) >= 30_000, 5_000)
    const before = client.inbox.length
    client.ws.send(JSON.stringify({ event: 'terminal-resume', data: { sessionId, afterSeq: 0, maxChars: 4_096 } }))
    await waitFor(() => client.inbox.slice(before).some((m) => m.data?.more === true), 3_000)
    client.ws.send(JSON.stringify({ event: 'terminal-frame', data: { sessionId, data: seal('q\n') } })) // the shell exits mid-replay
    await sleep(500)
    expect(pushes(client, 'terminal-closed')).toEqual([])

    // Pull the remaining pages; the exit follows the last one.
    for (let guard = 0; guard < 50 && pushes(client, 'terminal-closed').length === 0; guard++) {
      const ends = client.inbox.slice(before).filter((m) => m.data?.more !== undefined)
      const last = ends[ends.length - 1].data
      client.ws.send(JSON.stringify({ event: 'terminal-resume', data: { sessionId, afterSeq: last.nextSeq, maxChars: 4_096 } }))
      await sleep(50)
    }
    const closedAt = client.inbox.findIndex((m) => m.data?.event === 'terminal-closed')
    const lastPageAt = client.inbox.map((m) => m.data?.more).lastIndexOf(false)
    expect(lastPageAt).toBeGreaterThan(-1)
    expect(closedAt).toBeGreaterThan(lastPageAt)
    expect(pushes(client, 'terminal-closed')[0]).toMatchObject({ code: 5 })
    client.ws.close()
  })

  it('pages a resume that names maxChars', async () => {
    const client = await connect()
    const { data: { sessionId } } = await openTerminal(client, "process.stdout.write('x'.repeat(30000))")
    await waitFor(() => frames(client).reduce((n, f) => n + open(f.data).length, 0) >= 30_000, 5_000)
    const before = client.inbox.length
    client.ws.send(JSON.stringify({ event: 'terminal-resume', data: { sessionId, afterSeq: 0, maxChars: 8_192 } }))
    await waitFor(() => client.inbox.slice(before).some((m) => m.data?.more !== undefined), 3_000)
    const page = client.inbox.slice(before).filter((m) => m.data?.event === 'terminal-frame').map((m) => m.data)
    const last = page[page.length - 1]
    expect(last).toMatchObject({ more: true, nextSeq: last.seq })
    expect(page.reduce((n, f) => n + open(f.data).length, 0)).toBeLessThanOrEqual(8_192)
    client.ws.close()
  })

  it('caps direct terminals per user at the relay\'s limit', async () => {
    const clients: Client[] = []
    for (let i = 0; i < 5; i++) {
      const client = await connect()
      clients.push(client)
      expect((await openTerminal(client, 'setInterval(() => {}, 1000)')).data.ok).toBe(true)
    }
    const sixth = await connect()
    expect((await openTerminal(sixth, 'setInterval(() => {}, 1000)')).error).toMatch(/Too many active terminals/)
    // Another user is counted separately.
    const other = await connect()
    expect((await openTerminal(other, 'setInterval(() => {}, 1000)', 'user-2')).data.ok).toBe(true)
    expect(getDaemonTerminalSessionCount()).toBe(6)
    for (const client of [...clients, sixth, other]) client.ws.close()
  })

  // Cross review I4 #2: a closed or ended terminal waits out no grace window
  // inside the cap — closing one of five and opening another must not fall back to the relay.
  it('frees a cap slot as soon as the user closes a terminal and its socket goes', async () => {
    const clients: Client[] = []
    for (let i = 0; i < 5; i++) {
      const client = await connect()
      clients.push(client)
      expect((await openTerminal(client, 'setInterval(() => {}, 1000)')).data.ok).toBe(true)
    }
    const closing = clients.shift()!
    closing.ws.send(JSON.stringify({ event: 'terminal-close', data: {} }))
    closing.ws.close() // the desktop closes its socket right after sending terminal-close
    await closing.closed

    const next = await connect()
    expect((await openTerminal(next, 'setInterval(() => {}, 1000)')).data.ok).toBe(true)
    for (const client of [...clients, next]) client.ws.close()
  })

  it('does not count a terminal that ended while detached, though it waits for its client', async () => {
    const clients: Client[] = []
    for (let i = 0; i < 4; i++) {
      const client = await connect()
      clients.push(client)
      expect((await openTerminal(client, 'setInterval(() => {}, 1000)')).data.ok).toBe(true)
    }
    const ending = await connect()
    const { data: { sessionId } } = await openTerminal(ending, 'setTimeout(() => process.exit(0), 300)')
    ending.ws.terminate()
    await ending.closed
    await waitFor(() => getDaemonTerminalSession(sessionId)?.exit != null, 3_000)

    const next = await connect()
    expect((await openTerminal(next, 'setInterval(() => {}, 1000)')).data.ok).toBe(true)
    // Still kept for a client that re-attaches within the grace window.
    expect(getDaemonTerminalSession(sessionId)).not.toBeNull()
    expect(getDaemonTerminalSessionCount()).toBe(5)
    for (const client of [...clients, next]) client.ws.close()
  })
})

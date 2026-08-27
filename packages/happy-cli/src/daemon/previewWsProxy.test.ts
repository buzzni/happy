import { describe, it, expect, afterEach, vi } from 'vitest'
import net, { AddressInfo } from 'node:net'
import { PreviewWsProxy } from './previewWsProxy'

/** Collects the events the proxy would emit back to happy-server. */
class RecordingEmitter {
  public data: Array<{ tunnelId: string; dataB64: string }> = []
  public closed: string[] = []
  emit(event: 'proxy-ws-data' | 'proxy-ws-close', payload: any): void {
    if (event === 'proxy-ws-data') this.data.push(payload)
    else this.closed.push(payload.tunnelId)
  }
}

async function startTcpServer(onConn: (socket: net.Socket) => void): Promise<{ port: number; stop: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    onConn(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as AddressInfo).port,
    // Destroy live sockets first — otherwise server.close() blocks on the
    // open tunnel connection until its keep-alive expires.
    stop: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('PreviewWsProxy', () => {
  let stop: (() => Promise<void>) | null = null
  let activeProxy: PreviewWsProxy | null = null
  afterEach(async () => {
    activeProxy?.closeAll()
    activeProxy = null
    if (stop) await stop()
    stop = null
  })

  it('opens a tunnel, replays the initial bytes, and streams upstream data back', async () => {
    const received: Buffer[] = []
    const srv = await startTcpServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk)
        // Echo an upstream reply (stands in for websockify's 101 + frames).
        socket.write(Buffer.from('HELLO-FROM-UPSTREAM'))
      })
    })
    stop = srv.stop

    const emitter = new RecordingEmitter()
    const proxy = new PreviewWsProxy(emitter)
    activeProxy = proxy
    const initial = Buffer.from('GET /websockify HTTP/1.1\r\nUpgrade: websocket\r\n\r\n')

    const ack = await proxy.open({ tunnelId: 't1', port: srv.port, dataB64: initial.toString('base64') })
    expect(ack.ok).toBe(true)

    await waitFor(() => emitter.data.length > 0)
    expect(Buffer.concat(received).toString()).toContain('GET /websockify')
    const back = Buffer.concat(emitter.data.map((d) => Buffer.from(d.dataB64, 'base64'))).toString()
    expect(back).toBe('HELLO-FROM-UPSTREAM')
    expect(proxy.size).toBe(1)
  })

  it('forwards browser→upstream data frames after open', async () => {
    const received: Buffer[] = []
    const srv = await startTcpServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk))
    })
    stop = srv.stop

    const proxy = new PreviewWsProxy(new RecordingEmitter())
    await proxy.open({ tunnelId: 't2', port: srv.port, dataB64: '' })
    proxy.data({ tunnelId: 't2', dataB64: Buffer.from('frame-1').toString('base64') })

    await waitFor(() => Buffer.concat(received).toString().includes('frame-1'))
    expect(Buffer.concat(received).toString()).toBe('frame-1')
  })

  it('reports the target port while an active relay carries browser traffic', async () => {
    const srv = await startTcpServer((socket) => { socket.on('data', () => {}) })
    stop = srv.stop
    const onActivity = vi.fn()
    const proxy = new PreviewWsProxy(new RecordingEmitter(), { onActivity })
    activeProxy = proxy

    await proxy.open({ tunnelId: 'active', port: srv.port, dataB64: '' })
    proxy.data({ tunnelId: 'active', dataB64: Buffer.from('vnc-frame').toString('base64') })

    expect(onActivity).toHaveBeenCalledWith(srv.port)
    expect(onActivity).toHaveBeenCalledTimes(2)
  })

  it('rejects an out-of-range port without connecting', async () => {
    const proxy = new PreviewWsProxy(new RecordingEmitter())
    const ack = await proxy.open({ tunnelId: 't3', port: 70000, dataB64: '' })
    expect(ack.ok).toBe(false)
    expect(ack.code).toBe('INVALID_PORT')
    expect(proxy.size).toBe(0)
  })

  it('returns CONNECTION_REFUSED when nothing is listening', async () => {
    // Reserve then release a port so we know it is closed.
    const probe = await startTcpServer(() => {})
    const deadPort = probe.port
    await probe.stop()

    const proxy = new PreviewWsProxy(new RecordingEmitter())
    const ack = await proxy.open({ tunnelId: 't4', port: deadPort, dataB64: '' })
    expect(ack.ok).toBe(false)
    expect(ack.code).toBe('CONNECTION_REFUSED')
  })

  it('emits proxy-ws-close when the upstream errors mid-stream (not just clean close)', async () => {
    const srv = await startTcpServer((socket) => {
      // Accept, then destroy WITH an error once data arrives — fires 'error'
      // then 'close' on the daemon's upstream socket.
      // The accepted server-side socket also needs an error listener; otherwise
      // Node reports the intentionally injected error as uncaught after the
      // assertion has already passed.
      socket.on('error', () => {})
      socket.on('data', () => socket.destroy(new Error('boom')))
    })
    stop = srv.stop

    const emitter = new RecordingEmitter()
    const proxy = new PreviewWsProxy(emitter)
    activeProxy = proxy
    await proxy.open({ tunnelId: 'terr', port: srv.port, dataB64: Buffer.from('go').toString('base64') })

    await waitFor(() => emitter.closed.includes('terr'))
    expect(proxy.size).toBe(0)
  })

  it('emits proxy-ws-close when the upstream closes', async () => {
    const srv = await startTcpServer((socket) => {
      socket.on('data', () => socket.end())
    })
    stop = srv.stop

    const emitter = new RecordingEmitter()
    const proxy = new PreviewWsProxy(emitter)
    activeProxy = proxy
    await proxy.open({ tunnelId: 't5', port: srv.port, dataB64: Buffer.from('x').toString('base64') })

    await waitFor(() => emitter.closed.includes('t5'))
    expect(proxy.size).toBe(0)
  })

  it('closeAll tears down every live tunnel', async () => {
    const srv = await startTcpServer((socket) => { socket.on('data', () => {}) })
    stop = srv.stop
    const proxy = new PreviewWsProxy(new RecordingEmitter())
    await proxy.open({ tunnelId: 'a', port: srv.port, dataB64: '' })
    await proxy.open({ tunnelId: 'b', port: srv.port, dataB64: '' })
    expect(proxy.size).toBe(2)
    proxy.closeAll()
    expect(proxy.size).toBe(0)
  })
})

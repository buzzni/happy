import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createElectronGuiBridgeServer, type ElectronGuiScreencastSource, type ElectronGuiInputEvent } from './bridgeServer'

type Started = Awaited<ReturnType<typeof createElectronGuiBridgeServer>>

function fakeSource() {
    const inputs: ElectronGuiInputEvent[] = []
    let onFrame: ((frame: { data: string; width: number; height: number }) => void) | null = null
    let stops = 0
    const source: ElectronGuiScreencastSource = {
        async startScreencast(handler) { onFrame = handler },
        async stopScreencast() { stops += 1; onFrame = null },
        async dispatchInput(event) { inputs.push(event) },
    }
    return {
        source,
        inputs,
        emit: (data: string) => onFrame?.({ data, width: 800, height: 600 }),
        stops: () => stops,
        active: () => onFrame !== null,
    }
}

// 서버는 연결 직후 바로 'ready' 를 보내므로, 리스너를 나중에 달면 첫 메시지를
// 놓친다 — 연결 시점부터 버퍼링한다.
class Client {
    readonly ws: WebSocket
    private queue: string[] = []
    private waiters: Array<(message: string) => void> = []
    constructor(port: number, path: string) {
        this.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
        this.ws.on('message', (raw) => {
            const message = raw.toString()
            const waiter = this.waiters.shift()
            if (waiter) waiter(message)
            else this.queue.push(message)
        })
    }
    open(): Promise<this> {
        return new Promise((resolve, reject) => { this.ws.once('open', () => resolve(this)); this.ws.once('error', reject) })
    }
    next(): Promise<string> {
        const queued = this.queue.shift()
        if (queued !== undefined) return Promise.resolve(queued)
        return new Promise((resolve) => this.waiters.push(resolve))
    }
    send(value: string) { this.ws.send(value) }
    close() { this.ws.close() }
}

async function openClient(port: number, path = '/websockify'): Promise<Client> {
    return new Client(port, path).open()
}

function nextMessage(client: Client): Promise<string> {
    return client.next()
}

function slowSource() {
    const calls: string[] = []
    let releaseStart: (() => void) | null = null
    const source: ElectronGuiScreencastSource = {
        startScreencast: () => new Promise<void>((resolve) => { calls.push('start'); releaseStart = resolve }),
        async stopScreencast() { calls.push('stop') },
        async dispatchInput() {},
    }
    return { source, calls, finishStart: () => releaseStart?.() }
}

describe('electron GUI bridge server', () => {
    let started: Started | null = null
    afterEach(async () => { await started?.close(); started = null })

    it('serves the viewer page at / and /vnc.html so the desktop noVNC URL scheme keeps working', async () => {
        started = await createElectronGuiBridgeServer({ port: 0, host: '127.0.0.1', source: fakeSource().source })
        for (const path of ['/', '/vnc.html', '/vnc.html?autoconnect=true&path=v1/preview/m/6080/websockify']) {
            const response = await fetch(`http://127.0.0.1:${started.port}${path}`)
            expect(response.status).toBe(200)
            expect(response.headers.get('content-type')).toContain('text/html')
            expect(await response.text()).toContain('websockify')
        }
        expect((await fetch(`http://127.0.0.1:${started.port}/nope`)).status).toBe(404)
    })

    // The cloud relay's HTML shim strips the prefix from location.pathname and
    // does not re-prefix ws:// URLs (scheme differs from ORIGIN), so the socket
    // path must come from document.baseURI, where the injected <base> keeps it.
    it('derives the socket path from document.baseURI, never from location.pathname', async () => {
        started = await createElectronGuiBridgeServer({ port: 0, host: '127.0.0.1', source: fakeSource().source })
        const html = await (await fetch(`http://127.0.0.1:${started.port}/vnc.html`)).text()
        expect(html).toContain("new URL('websockify', document.baseURI)")
        expect(html).not.toContain('location.pathname')
    })

    it('streams screencast frames to a viewer connected at /websockify and stops when it leaves', async () => {
        const fake = fakeSource()
        started = await createElectronGuiBridgeServer({ port: 0, host: '127.0.0.1', source: fake.source })
        const ws = await openClient(started.port)
        // ready 메시지가 먼저 오고, 그 다음부터 프레임.
        expect(JSON.parse(await nextMessage(ws))).toMatchObject({ t: 'ready' })
        expect(fake.active()).toBe(true)
        const framePromise = nextMessage(ws)
        fake.emit('AAAA')
        expect(JSON.parse(await framePromise)).toEqual({ t: 'frame', data: 'AAAA', width: 800, height: 600 })
        ws.close()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(fake.stops()).toBe(1)
    })

    it('accepts /websockify under a relay sub-path', async () => {
        started = await createElectronGuiBridgeServer({ port: 0, host: '127.0.0.1', source: fakeSource().source })
        const ws = await openClient(started.port, '/v1/preview/m-1/6080/websockify')
        expect(JSON.parse(await nextMessage(ws))).toMatchObject({ t: 'ready' })
        ws.close()
    })

    it('forwards viewer input to the source and ignores malformed messages', async () => {
        const fake = fakeSource()
        started = await createElectronGuiBridgeServer({ port: 0, host: '127.0.0.1', source: fake.source })
        const ws = await openClient(started.port)
        await nextMessage(ws)
        ws.send('not json')
        ws.send(JSON.stringify({ t: 'mouse', kind: 'mousePressed', nx: 0.5, ny: 0.25, button: 'left', clickCount: 1 }))
        ws.send(JSON.stringify({ t: 'key', kind: 'keyDown', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 }))
        ws.send(JSON.stringify({ t: 'wheel', nx: 0.1, ny: 0.1, deltaX: 0, deltaY: 120 }))
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(fake.inputs).toEqual([
            { t: 'mouse', kind: 'mousePressed', nx: 0.5, ny: 0.25, button: 'left', clickCount: 1 },
            { t: 'key', kind: 'keyDown', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 },
            { t: 'wheel', nx: 0.1, ny: 0.1, deltaX: 0, deltaY: 120 },
        ])
        ws.close()
    })

    // The desktop's liveness probe opens a socket on the same path moments
    // before (or while) the canvas connects, and a user may open the stream in a
    // second tab. One shared screencast fans out to every viewer; a "busy"
    // rejection would turn the probe into a race against the real viewer.
    it('fans one screencast out to every viewer and stops only after the last one leaves', async () => {
        const fake = fakeSource()
        started = await createElectronGuiBridgeServer({ port: 0, host: '127.0.0.1', source: fake.source })
        const first = await openClient(started.port)
        expect(JSON.parse(await nextMessage(first))).toMatchObject({ t: 'ready' })
        fake.emit('FIRST')
        expect(JSON.parse(await nextMessage(first))).toMatchObject({ t: 'frame', data: 'FIRST' })

        const second = await openClient(started.port)
        expect(JSON.parse(await nextMessage(second))).toMatchObject({ t: 'ready' })
        // A late joiner is painted immediately from the last frame instead of
        // waiting for the window to change.
        expect(JSON.parse(await nextMessage(second))).toMatchObject({ t: 'frame', data: 'FIRST' })
        fake.emit('SECOND')
        expect(JSON.parse(await nextMessage(first))).toMatchObject({ t: 'frame', data: 'SECOND' })
        expect(JSON.parse(await nextMessage(second))).toMatchObject({ t: 'frame', data: 'SECOND' })

        first.close()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(fake.stops()).toBe(0)
        second.close()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(fake.stops()).toBe(1)
    })

    // Hot reload (electronmon / electron-vite) restarts the whole main process;
    // the new bridge can reach listen() while the old process still holds the
    // port for a moment. Giving up on the first EADDRINUSE would leave the
    // preview dead until the next manual restart.
    it('retries listen while the port is still held by the previous process', async () => {
        const { createServer } = await import('node:http')
        const blocker = createServer()
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
        const address = blocker.address()
        const port = typeof address === 'object' && address ? address.port : 0
        setTimeout(() => blocker.close(), 400)
        started = await createElectronGuiBridgeServer({
            port,
            host: '127.0.0.1',
            source: fakeSource().source,
            listenRetry: { attempts: 20, delayMs: 100 },
        })
        expect(started.port).toBe(port)
        expect((await fetch(`http://127.0.0.1:${port}/vnc.html`)).status).toBe(200)
    })

    it('stops a screencast whose start was still pending when the last viewer left', async () => {
        const slow = slowSource()
        started = await createElectronGuiBridgeServer({ port: 0, host: '127.0.0.1', source: slow.source })
        const viewer = await openClient(started.port)
        await nextMessage(viewer)
        viewer.close()
        await new Promise((resolve) => setTimeout(resolve, 100))
        // Stop must wait for the start to settle — otherwise the debugger ends
        // up attached with a capture nobody consumes.
        expect(slow.calls).toEqual(['start'])
        slow.finishStart()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(slow.calls).toEqual(['start', 'stop'])
    })
})

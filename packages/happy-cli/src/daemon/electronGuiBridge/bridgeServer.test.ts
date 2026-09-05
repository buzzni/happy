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

    it('rejects a second viewer while one is streaming instead of double-attaching', async () => {
        const fake = fakeSource()
        started = await createElectronGuiBridgeServer({ port: 0, host: '127.0.0.1', source: fake.source })
        const first = await openClient(started.port)
        await nextMessage(first)
        const second = await openClient(started.port)
        const message = JSON.parse(await nextMessage(second))
        expect(message).toMatchObject({ t: 'error', reason: 'busy' })
        first.close(); second.close()
    })
})

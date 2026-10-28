import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { CdpConnection, CdpProtocolError } from './cdpConnection'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function pipes(options: { timeoutMs?: number; maxPayload?: number } = {}) {
    const input = new PassThrough(), output = new PassThrough()
    const requests: string[] = []
    input.on('data', chunk => requests.push(chunk.toString()))
    const connection = CdpConnection.fromPipe(input, output, options)
    cleanups.push(() => connection.close())
    return { connection, input, output, requests }
}

describe('CDP inherited pipe transport', () => {
    it('frames commands and handles split UTF-8 and several responses in one chunk', async () => {
        const h = pipes()
        const one = h.connection.send('Runtime.evaluate', { expression: '1' }, 'session-a')
        const two = h.connection.send('Browser.getVersion')
        expect(h.requests.map(raw => JSON.parse(raw.slice(0, -1)))).toEqual([
            { id: 1, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'session-a' },
            { id: 2, method: 'Browser.getVersion', params: {} },
        ])
        expect(h.requests.every(raw => raw.endsWith('\0'))).toBe(true)
        const data = Buffer.from('{"id":1,"result":{"value":"한글"}}\0{"id":2,"result":{"product":"Chrome"}}\0')
        const split = data.indexOf(Buffer.from('한')) + 1
        h.output.write(data.subarray(0, split))
        h.output.write(data.subarray(split))
        expect(await one).toEqual({ value: '한글' })
        expect(await two).toEqual({ product: 'Chrome' })
    })

    it('preserves flattened session events and protocol errors', async () => {
        const h = pipes(), events: unknown[] = []
        h.connection.on('Page.loadEventFired', (params, session) => events.push({ params, session }))
        h.output.write('{"method":"Page.loadEventFired","params":{"timestamp":1},"sessionId":"page-1"}\0')
        expect(events).toEqual([{ params: { timestamp: 1 }, session: 'page-1' }])
        const pending = h.connection.send('Unknown.method').catch(error => error)
        h.output.write('{"id":1,"error":{"code":-32601,"message":"unknown method"}}\0')
        expect(await pending).toBeInstanceOf(CdpProtocolError)
    })

    it('ignores malformed frames without crashing the service or losing a later valid reply', async () => {
        const h = pipes()
        const pending = h.connection.send('Browser.getVersion')
        h.output.write('not-json\0null\0[]\0true\0{"id":1,"result":{"product":"Chrome"}}\0')
        expect(await pending).toEqual({ product: 'Chrome' })
    })

    it.each(['eof', 'error', 'oversized', 'timeout'])('fails pending commands and closes both pipes on %s', async failure => {
        const h = pipes({ timeoutMs: 20, maxPayload: 128 })
        let closed = 0
        h.connection.onClose(() => closed++)
        const pending = h.connection.send('Browser.getVersion').catch(error => error)
        if (failure === 'eof') h.output.end()
        if (failure === 'error') h.output.destroy(new Error('synthetic pipe error'))
        if (failure === 'oversized') { h.output.write(Buffer.alloc(100, 120)); h.output.write(Buffer.alloc(29, 120)) }
        expect(await pending).toMatchObject({ code: 'RUNTIME_UNAVAILABLE', retryable: false, mayHaveSideEffects: true })
        await h.connection.closedPromise
        expect(h.connection.closed).toBe(true)
        expect(h.input.destroyed).toBe(true)
        expect(h.output.destroyed).toBe(true)
        h.connection.close()
        expect(closed).toBe(1)
        await expect(h.connection.send('Browser.getVersion')).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    })

    it('rejects an already closed pipe and invalid bounds', () => {
        const input = new PassThrough(), output = new PassThrough()
        output.destroy()
        const connection = CdpConnection.fromPipe(input, output)
        expect(connection.closed).toBe(true)
        expect(() => pipes({ timeoutMs: 0 })).toThrow()
        expect(() => pipes({ maxPayload: -1 })).toThrow()
    })
})

it('retains the Linux WebSocket command path', async () => {
    const server = createServer(), ws = new WebSocketServer({ server })
    cleanups.push(async () => {
        for (const client of ws.clients) client.terminate()
        await new Promise<void>(resolve => ws.close(() => resolve()))
        await new Promise<void>(resolve => server.close(() => resolve()))
    })
    ws.on('connection', client => client.on('message', data => {
        const { id } = JSON.parse(data.toString())
        client.send(JSON.stringify({ id, result: { product: 'Chrome' } }))
    }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${address.port}`)
    cleanups.push(() => connection.close())
    expect(await connection.send('Browser.getVersion')).toEqual({ product: 'Chrome' })
})

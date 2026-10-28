import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserInstanceId } from '../contracts'
import { CdpConnection } from './cdpConnection'
import { CdpDriver } from './cdpDriver'

const cleanup: CdpDriver[] = []
afterEach(async () => { for (const driver of cleanup.splice(0)) await driver.close() })
function pipe() {
    const input = new PassThrough(), output = new PassThrough()
    const commands: string[] = []
    input.on('data', chunk => {
        const request = JSON.parse(chunk.toString().slice(0, -1))
        commands.push(request.method)
        output.write(JSON.stringify({ id: request.id, result: {} }) + '\0')
    })
    const connection = CdpConnection.fromPipe(input, output)
    return { connection, commands }
}
function driver(connectPipe: () => Promise<{ connection: CdpConnection; browserInstanceId: BrowserInstanceId }>) {
    const value = new CdpDriver({ connectPipe })
    cleanup.push(value)
    return value
}
const identity = 'native-boot-pid-start' as BrowserInstanceId

it('connects the actual driver through inherited pipes without WebSocket discovery', async () => {
    const h = pipe(), d = driver(async () => ({ connection: h.connection, browserInstanceId: identity }))
    expect(await d.connect()).toBe(identity)
    expect(d.isConnected()).toBe(true)
    expect(h.commands).toEqual(['Target.setDiscoverTargets', 'Target.setAutoAttach'])
    await d.close()
    expect(h.connection.closed).toBe(true)
    expect(d.isConnected()).toBe(false)
    expect(() => d.browserInstanceId()).toThrow()
})

it('does not accept a network endpoint on a pipe driver', async () => {
    const h = pipe(), connect = vi.fn(async () => ({ connection: h.connection, browserInstanceId: identity })), d = driver(connect)
    await d.connect()
    await expect(d.reconnect('ws://127.0.0.1:9222')).rejects.toThrow()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(d.isConnected()).toBe(true)
})

it('does not revive a driver closed while its supervisor was connecting', async () => {
    const h = pipe()
    let resolve!: (value: { connection: CdpConnection; browserInstanceId: BrowserInstanceId }) => void
    const d = driver(() => new Promise(r => { resolve = r }))
    const pending = d.connect().catch(error => error)
    await d.close()
    resolve({ connection: h.connection, browserInstanceId: identity })
    expect(await pending).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(h.connection.closed).toBe(true)
    expect(h.commands).toEqual([])
    expect(d.isConnected()).toBe(false)
})

it('deduplicates concurrent connects and invalidates identity on pipe loss', async () => {
    const h = pipe(), connect = vi.fn(async () => ({ connection: h.connection, browserInstanceId: identity })), d = driver(connect)
    const disconnected = vi.fn()
    d.onDisconnect(disconnected)
    expect(await Promise.all([d.connect(), d.connect()])).toEqual([identity, identity])
    expect(connect).toHaveBeenCalledTimes(1)
    h.connection.close()
    expect(disconnected).toHaveBeenCalledTimes(1)
    expect(d.isConnected()).toBe(false)
    expect(() => d.browserInstanceId()).toThrow()
})

it('rejects a pipe closed before its supervisor returned it', async () => {
    const h = pipe()
    h.connection.close()
    const d = driver(async () => ({ connection: h.connection, browserInstanceId: identity }))
    await expect(d.connect()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(h.commands).toEqual([])
    expect(d.isConnected()).toBe(false)
})

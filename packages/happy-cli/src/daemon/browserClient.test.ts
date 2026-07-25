import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { requestBrowser, BrowserClientError } from './browserClient'

/** Stands in for the daemon control server's /browser/request route. */
function startFakeDaemon(handler: (body: any) => { status: number; body: any }) {
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
            const { status, body } = handler(JSON.parse(raw || '{}'))
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
        })
    })
    return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: (server.address() as AddressInfo).port,
            close: () => new Promise<void>((r) => server.close(() => r())),
        }))
    })
}

describe('requestBrowser', () => {
    let daemon: { port: number; close: () => Promise<void> }
    let received: any

    afterEach(async () => {
        await daemon?.close()
    })

    it('returns the extension result on success', async () => {
        daemon = await startFakeDaemon((body) => {
            received = body
            return { status: 200, body: { result: { tabs: [{ id: 1 }] } } }
        })
        const result = await requestBrowser({ port: daemon.port, method: 'tabs_list', params: { a: 1 } })
        expect(result).toEqual({ tabs: [{ id: 1 }] })
        expect(received).toMatchObject({ method: 'tabs_list', params: { a: 1 } })
    })

    it('throws NO_EXTENSION_CONNECTED when the daemon reports 503', async () => {
        daemon = await startFakeDaemon(() => ({
            status: 503,
            body: { code: 'NO_EXTENSION_CONNECTED', error: 'no Chrome extension is connected to the bridge' },
        }))
        await expect(requestBrowser({ port: daemon.port, method: 'tabs_list' }))
            .rejects.toMatchObject({ code: 'NO_EXTENSION_CONNECTED' })
    })

    it('throws TIMEOUT when the daemon reports 504', async () => {
        daemon = await startFakeDaemon(() => ({ status: 504, body: { code: 'TIMEOUT', error: 'extension did not respond' } }))
        await expect(requestBrowser({ port: daemon.port, method: 'tabs_list' }))
            .rejects.toMatchObject({ code: 'TIMEOUT' })
    })

    it('surfaces an extension-side error code', async () => {
        daemon = await startFakeDaemon(() => ({ status: 502, body: { code: 'TAB_NOT_FOUND', error: 'no such tab' } }))
        await expect(requestBrowser({ port: daemon.port, method: 'browser_click' }))
            .rejects.toMatchObject({ code: 'TAB_NOT_FOUND', message: 'no such tab' })
    })

    it('throws BRIDGE_UNAVAILABLE when the daemon is too old to have the route', async () => {
        daemon = await startFakeDaemon(() => ({ status: 404, body: { message: 'Route POST:/browser/request not found' } }))
        await expect(requestBrowser({ port: daemon.port, method: 'tabs_list' }))
            .rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' })
    })

    it('throws DAEMON_UNREACHABLE when nothing is listening', async () => {
        daemon = await startFakeDaemon(() => ({ status: 200, body: {} }))
        const deadPort = daemon.port
        await daemon.close()
        await expect(requestBrowser({ port: deadPort, method: 'tabs_list' }))
            .rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE' })
        daemon = { port: 0, close: async () => {} }
    })

    it('errors are BrowserClientError instances', async () => {
        daemon = await startFakeDaemon(() => ({ status: 503, body: { code: 'NO_EXTENSION_CONNECTED', error: 'x' } }))
        await expect(requestBrowser({ port: daemon.port, method: 'tabs_list' }))
            .rejects.toBeInstanceOf(BrowserClientError)
    })
})

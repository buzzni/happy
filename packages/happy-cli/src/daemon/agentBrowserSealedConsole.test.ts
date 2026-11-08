import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forwardSealedConsoleRequest, sealedConsoleRuntimeUrl } from './agentBrowserSealedConsole'

describe('forwardSealedConsoleRequest', () => {
    let runtime: Server
    let runtimeUrl = ''
    let seen: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = []

    beforeEach(async () => {
        seen = []
        runtime = createServer(async (req, res) => {
            let body = ''
            for await (const chunk of req) body += chunk
            seen.push({ method: req.method, url: req.url, headers: req.headers, body })
            if (req.url === '/v1/ops/getPageFrame') {
                res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1', 'x-internal': 'no' })
                res.end(JSON.stringify({ ok: true, result: { frame: 'x'.repeat(200) } }))
                return
            }
            if (req.url === '/v1/ops/huge') {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end('x'.repeat(5 * 1024 * 1024))
                return
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'" })
            res.end('<html>console</html>')
        })
        await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
        runtimeUrl = `http://127.0.0.1:${(runtime.address() as { port: number }).port}`
    })

    afterEach(async () => {
        runtime.closeAllConnections()
        await new Promise((resolve) => runtime.close(resolve))
    })

    it('serves the remote page console and returns only the page headers', async () => {
        const result = await forwardSealedConsoleRequest({ method: 'GET', path: '/console?remotePage=1&agentSessionId=s1&lang=ko' }, runtimeUrl)
        expect(result).toMatchObject({ ok: true, status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'" } })
        expect(Buffer.from((result as { bodyB64: string }).bodyB64, 'base64').toString()).toBe('<html>console</html>')
        expect(seen[0]).toMatchObject({ method: 'GET', url: '/console?remotePage=1&agentSessionId=s1&lang=ko' })
    })

    it('forwards an operation with its capability and drops every other request and response header', async () => {
        const result = await forwardSealedConsoleRequest({
            method: 'POST', path: '/v1/ops/getPageFrame',
            headers: { 'content-type': 'application/json', authorization: 'Bearer abp2.a.b.c', cookie: 'session=1', origin: 'https://evil.test' },
            bodyB64: Buffer.from('{"viewId":"v"}').toString('base64'),
        }, runtimeUrl)
        expect(result).toMatchObject({ ok: true, status: 200, headers: { 'content-type': 'application/json' } })
        expect(Object.keys((result as { headers: object }).headers)).toEqual(['content-type'])
        expect(seen[0].headers.authorization).toBe('Bearer abp2.a.b.c')
        expect(seen[0].headers.cookie).toBeUndefined()
        expect(seen[0].headers.origin).toBeUndefined()
        expect(seen[0].body).toBe('{"viewId":"v"}')
    })

    it.each([
        ['GET', '/console'],
        ['GET', '/console?remotePage=0'],
        ['GET', '/v1/health'],
        ['GET', '/viewer/websockify'],
        ['POST', '/v1/ops/getPageFrame?x=1'],
        ['POST', '/v1/ops/../../admin'],
        ['POST', '/v1/ops/get-page'],
        ['GET', '//evil.test/console?remotePage=1'],
        ['PUT', '/v1/ops/getPageFrame'],
    ])('refuses %s %s without reaching the runtime', async (method, path) => {
        const result = await forwardSealedConsoleRequest({ method, path }, runtimeUrl)
        expect(result).toMatchObject({ ok: false })
        expect(seen).toHaveLength(0)
    })

    it('refuses a malformed request', async () => {
        expect(await forwardSealedConsoleRequest({ method: 'GET' }, runtimeUrl)).toEqual({ ok: false, code: 'INVALID_REQUEST' })
        expect(await forwardSealedConsoleRequest({ method: 'GET', path: '/console?remotePage=1', extra: 1 }, runtimeUrl)).toEqual({ ok: false, code: 'INVALID_REQUEST' })
    })

    it('refuses a runtime that is not this machine\'s loopback runtime', async () => {
        expect(await forwardSealedConsoleRequest({ method: 'GET', path: '/console?remotePage=1' }, undefined)).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' })
        expect(await forwardSealedConsoleRequest({ method: 'GET', path: '/console?remotePage=1' }, 'http://10.0.0.5:38700')).toEqual({ ok: false, code: 'RUNTIME_UNAVAILABLE' })
    })

    it('reports a runtime that is not listening', async () => {
        runtime.closeAllConnections()
        await new Promise((resolve) => runtime.close(resolve))
        expect(await forwardSealedConsoleRequest({ method: 'GET', path: '/console?remotePage=1' }, runtimeUrl)).toEqual({ ok: false, code: 'RUNTIME_UNREACHABLE' })
        runtime = createServer()
        await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    })

    it('refuses a response larger than the console needs instead of returning part of it', async () => {
        expect(await forwardSealedConsoleRequest({ method: 'POST', path: '/v1/ops/huge' }, runtimeUrl)).toEqual({ ok: false, code: 'TOO_LARGE' })
    })
})

describe('sealedConsoleRuntimeUrl', () => {
    it('names the runtime only where the personal desktop runtime serves the remote page console', () => {
        expect(sealedConsoleRuntimeUrl({ HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:38700', HAPPY_BROWSER_TASK_SEALED_CONSOLE: '1' })).toBe('http://127.0.0.1:38700')
        expect(sealedConsoleRuntimeUrl({ HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:38700' })).toBeUndefined()
    })
})

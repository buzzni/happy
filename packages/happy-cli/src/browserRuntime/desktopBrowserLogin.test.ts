import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createDesktopBrowserLoginClient } from './desktopBrowserLogin'
const scope = { machineId: 'machine', workspaceId: 'company', principalId: 'user', profileId: 'personal' }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
it('checks a live scoped login on every admission and denies cached credentials after app loss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bcl-'))
    const descriptor = { ...scope, protocol: 1, socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\saycode-browser-login-' + randomBytes(32).toString('hex') : join(root, 'relay.sock'), secret: 's'.repeat(43), loginId: 'l'.repeat(43) }
    let loggedIn = true, denied = false
    const server = createServer((req, res) => {
        res.writeHead(loggedIn && !denied && req.headers['x-saycode-browser-login'] === descriptor.secret ? 200 : 403)
        res.end(JSON.stringify(denied ? { error: 'DESKTOP_BROWSER_LOGIN_DENIED' } : { ...scope, protocol: 1, loginId: descriptor.loginId }))
    })
    await new Promise<void>(resolve => server.listen(descriptor.socketPath, resolve))
    cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
    const client = createDesktopBrowserLoginClient(descriptor, scope)
    await expect(client.check()).resolves.toBeUndefined()
    loggedIn = false
    await expect(client.check()).rejects.toMatchObject({ code: 'UNAUTHORIZED', retryable: false })
    loggedIn = true; denied = true
    await expect(client.check()).rejects.toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
    expect(() => createDesktopBrowserLoginClient(descriptor, { ...scope, principalId: 'other' })).toThrow('SCOPE_CHANGED')
    expect(() => createDesktopBrowserLoginClient({ ...descriptor, url: 'https://arbitrary' }, scope)).toThrow()
})

/**
 * The console's Spaces panel in a real Chrome against a fake Runtime: rows are named after the conversations the
 * host knows, and fall back to the session id for a conversation it does not.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderConsolePage } from './consolePage'
import { HarnessCdp, eventually, findChrome, launchChrome, type LaunchedChrome } from './drivers/pocTestKit'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const capability = `abp2.${b64({ alg: 'EdDSA', kid: 'k', typ: 'abp-cap' })}.${b64({ kind: 'interactive', profileId: 'profile-a', principalId: 'user-1',
    viewerSessionId: 'viewer-this', capabilityId: 'cap', expiresAtMs: Date.now() + 600_000,
    operations: ['listTasks', 'getTask', 'cancel', 'subscribe', 'listSpaces', 'closeSpace', 'setSpaceQuota'] })}.sig`
const KNOWN = 'session-known-0001', UNKNOWN = 'session-other-0002'

async function until<T>(fn: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
    const value = await eventually(fn, ok, timeoutMs)
    if (!ok(value)) throw new Error(`condition not met within ${timeoutMs} ms; last value: ${JSON.stringify(value)?.slice(0, 300)}`)
    return value
}

describe.skipIf(!findChrome())('console spaces panel (real Chrome, fake Runtime)', () => {
    let chrome: LaunchedChrome
    let harness: HarnessCdp
    let server: http.Server
    let origin = ''
    const space = (taskSpaceId: string, sessionId: string) => ({ taskSpaceId, profileId: 'profile-a', createdAtMs: Date.now(), closed: false, tabs: [],
        memberSessionIds: [sessionId], membershipEvents: [], reclaiming: false, lastActivityAtMs: Date.now(), tasks: [] })

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === '/console') {
                res.writeHead(200, { 'content-type': 'text/html' })
                res.end(renderConsolePage())
                return
            }
            const m = /^\/v1\/ops\/(\w+)$/.exec(url.pathname)
            if (!m) { res.writeHead(404); res.end(); return }
            req.resume()
            req.on('end', () => {
                const result = m[1] === 'listSpaces' ? {
                    quota: { used: 2, reclaimingReserve: 0, hidden: 0, limit: 4, mode: 'fixed', reason: 'fixed', preference: { ceiling: null, revision: 0 } },
                    spaces: [space('space-aaaaaaaaaaaa', KNOWN), space('space-bbbbbbbbbbbb', UNKNOWN)],
                } : m[1] === 'listTasks' ? { tasks: [] } : {}
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, result }))
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        chrome = await launchChrome()
        harness = await HarnessCdp.connect(chrome.browserWsUrl)
    }, 60_000)

    afterAll(async () => {
        harness?.close()
        await chrome?.stop()
        await new Promise<void>((resolve) => server?.close(() => resolve()))
    })

    const names = (target: string) => harness.evaluate(target, `[...document.querySelectorAll('#spaceRows .space-name')].map(n => n.textContent)`) as Promise<string[]>

    it('names a space after its conversation title once the host hands the titles over', async () => {
        const target = await harness.openFrontTab(`${origin}/console?lang=en`)
        try {
            await until(() => harness.evaluate(target, 'window.__abpSpaceManagement'), (v) => v === 1)
            await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(capability)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
            await harness.evaluate(target, `document.getElementById('spaceToggle').click()`)
            expect(await until(() => names(target), (list) => list.length === 2)).toEqual(['Conversation session-know', 'Conversation session-othe'])
            await harness.evaluate(target, `window.postMessage({ type: 'abp-session-titles', titles: { ${JSON.stringify(KNOWN)}: 'Open the GA report' } }, location.origin)`)
            expect(await until(() => names(target), (list) => list[0] === 'Open the GA report')).toEqual(['Open the GA report', 'Conversation session-othe'])
            // Malformed titles are ignored rather than shown.
            await harness.evaluate(target, `window.postMessage({ type: 'abp-session-titles', titles: { ${JSON.stringify(UNKNOWN)}: 42 } }, location.origin)`)
            await harness.evaluate(target, 'new Promise(r => setTimeout(r, 300))')
            expect((await names(target))[1]).toBe('Conversation session-othe')
        } finally { await harness.closeTarget(target) }
    }, 30_000)
})

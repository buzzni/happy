/**
 * The console's Spaces panel in a real Chrome against a fake Runtime: rows are named after the conversations the
 * host knows, and fall back to the session id for a conversation it does not; a space kept because a write outcome is
 * unknown can still be closed after a warning.
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
    const ops: Array<{ op: string; body: Record<string, unknown> }> = []
    const space = (taskSpaceId: string, sessionId: string, tasks: unknown[] = []) => ({ taskSpaceId, profileId: 'profile-a', createdAtMs: Date.now(), closed: false, tabs: [],
        memberSessionIds: [sessionId], membershipEvents: [], reclaiming: false, lastActivityAtMs: Date.now(), tasks })
    const defaultSpaces = () => [space('space-aaaaaaaaaaaa', KNOWN), space('space-bbbbbbbbbbbb', UNKNOWN), { ...space('space-cccccccccccc', KNOWN), memberSessionIds: [KNOWN, UNKNOWN] }]
    let spaces = defaultSpaces()

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
            let raw = ''
            req.on('data', (chunk) => { raw += chunk })
            req.on('end', () => {
                ops.push({ op: m[1], body: JSON.parse(raw || '{}') })
                const result = m[1] === 'listSpaces' ? {
                    quota: { used: spaces.length, reclaimingReserve: 0, hidden: 0, limit: 4, mode: 'fixed', reason: 'fixed', preference: { ceiling: null, revision: 0 } },
                    spaces,
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

    const open = async (lang = 'en') => {
        const target = await harness.openFrontTab(`${origin}/console?lang=${lang}`)
        await until(() => harness.evaluate(target, 'window.__abpSpaceManagement'), (v) => v === 1)
        await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(capability)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
        await harness.evaluate(target, `document.getElementById('spaceToggle').click()`)
        return target
    }
    const names = (target: string) => harness.evaluate(target, `[...document.querySelectorAll('#spaceRows .space-name')].map(n => n.textContent)`) as Promise<string[]>

    it('names a space after its conversation title once the host hands the titles over', async () => {
        const target = await open()
        try {
            expect(await until(() => names(target), (list) => list.length === 3)).toEqual(['Conversation session-know', 'Conversation session-othe', 'Conversation session-know, session-othe'])
            await harness.evaluate(target, `window.postMessage({ type: 'abp-session-titles', titles: { ${JSON.stringify(KNOWN)}: 'Open the GA report' } }, location.origin)`)
            // A shared space keeps its untitled member visible.
            expect(await until(() => names(target), (list) => list[0] === 'Open the GA report')).toEqual(['Open the GA report', 'Conversation session-othe', 'Open the GA report, Conversation session-othe'])
            // Malformed titles are ignored rather than shown.
            await harness.evaluate(target, `window.postMessage({ type: 'abp-session-titles', titles: { ${JSON.stringify(UNKNOWN)}: 42 } }, location.origin)`)
            await harness.evaluate(target, 'new Promise(r => setTimeout(r, 300))')
            expect((await names(target))[1]).toBe('Conversation session-othe')
        } finally { await harness.closeTarget(target) }
    }, 30_000)

    it('offers Close beside View task for a space whose write outcome is unknown, warns, then cancels and closes it', async () => {
        spaces = [space('space-uncertain00', KNOWN, [{ taskId: 'task-u', status: 'paused', pauseReason: 'cancelled-with-unknown-effect', pendingApproval: false, uncertain: true, inFlight: false }])]
        ops.length = 0
        const target = await open('ko')
        try {
            expect(await harness.evaluate(target, 'window.__abpSpaceReviewClose')).toBe(1)
            const buttons = () => harness.evaluate(target, `[...document.querySelectorAll('#spaceRows .space-row button')].map(b => b.textContent)`) as Promise<string[]>
            expect(await until(buttons, (list) => list.length === 2)).toEqual(['작업 보기', '닫기'])
            await harness.evaluate(target, `[...document.querySelectorAll('#spaceRows .space-row button')][1].click()`)
            const dialog = JSON.parse(await harness.evaluate(target, `JSON.stringify({ open: document.getElementById('spaceConfirm').open,
                title: document.getElementById('spaceConfirmTitle').textContent, body: document.getElementById('spaceConfirmBody').textContent })`))
            expect(dialog).toMatchObject({ open: true, title: '작업 공간을 닫을까요?' })
            expect(dialog.body).toContain('결과를 확인하지 못했어요')
            expect(dialog.body).toContain('열린 탭')
            await harness.evaluate(target, `document.getElementById('spaceConfirmYes').click()`)
            const sent = await until(() => ops.filter((o) => ['cancel', 'closeSpace'].includes(o.op)), (list) => list.length === 2)
            expect(sent.map((o) => [o.op, o.body.taskId ?? o.body.taskSpaceId])).toEqual([['cancel', 'task-u'], ['closeSpace', 'space-uncertain00']])
        } finally { await harness.closeTarget(target); spaces = defaultSpaces() }
    }, 30_000)

    it('does not redraw the panel for titles while the usage-limit settings are being edited', async () => {
        const target = await harness.openFrontTab(`${origin}/console?lang=en`)
        try {
            await until(() => harness.evaluate(target, 'window.__abpSpaceManagement'), (v) => v === 1)
            await harness.evaluate(target, `window.postMessage({ type: 'abp-capability', token: ${JSON.stringify(capability)}, expiresAtMs: Date.now() + 600_000 }, location.origin)`)
            await harness.evaluate(target, `document.getElementById('spaceToggle').click()`)
            await until(() => names(target), (list) => list.length === 3)
            await harness.evaluate(target, `(() => { const s = document.getElementById('spaceSettings'); s.open = true; const m = document.getElementById('spaceMode'); m.value = 'manual'; m.onchange(); })()`)
            await harness.evaluate(target, `window.postMessage({ type: 'abp-session-titles', titles: { ${JSON.stringify(KNOWN)}: 'Open the GA report' } }, location.origin)`)
            await harness.evaluate(target, 'new Promise(r => setTimeout(r, 300))')
            expect(await harness.evaluate(target, `document.getElementById('spaceMode').value`)).toBe('manual')
            expect((await names(target))[0]).toBe('Conversation session-know')
            // Once the settings are closed, the next refresh shows the titles.
            await harness.evaluate(target, `(() => { document.getElementById('spaceSettings').open = false; document.getElementById('spaceRefresh').click(); })()`)
            expect(await until(() => names(target), (list) => list[0] === 'Open the GA report')).toHaveLength(3)
        } finally { await harness.closeTarget(target) }
    }, 30_000)

    it('keeps only View task for a space that is reclaiming without an unknown outcome', async () => {
        spaces = [{ ...space('space-reclaiming0', KNOWN, [{ taskId: 'task-r', status: 'running', pendingApproval: false, uncertain: false, inFlight: true }]), reclaiming: true }]
        const target = await open('ko')
        try {
            const buttons = () => harness.evaluate(target, `[...document.querySelectorAll('#spaceRows .space-row button')].map(b => b.textContent)`) as Promise<string[]>
            expect(await until(buttons, (list) => list.length > 0)).toEqual(['작업 보기'])
        } finally { await harness.closeTarget(target); spaces = defaultSpaces() }
    }, 30_000)
})

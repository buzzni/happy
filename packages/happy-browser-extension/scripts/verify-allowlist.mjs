/**
 * Unattended real-Chrome verification of the Phase 4 site allowlist.
 *
 * The allowlist deliberately has no protocol command — an agent that could
 * edit its own restrictions would not be a restriction. So the one manual
 * step (saving the allowlist in the options page) is inherent, not a gap in
 * the harness. The script detects that it took effect by *behaviour*: it
 * polls tabs_list until every tab it can see is on the allowed origin.
 *
 *   node scripts/verify-allowlist.mjs
 */

import { WebSocketServer } from 'ws'
import http from 'node:http'
import { randomBytes } from 'node:crypto'

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 41777
const ALLOWED_PORT = Number(process.env.ALLOWED_PORT) || 41778
const DENIED_PORT = Number(process.env.DENIED_PORT) || 41779
const token = process.env.BRIDGE_TOKEN || randomBytes(32).toString('hex')

const page = (title) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><button id="b">Click me</button></body></html>`

function servePage(port, title) {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(page(title))
    })
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

const allowedServer = await servePage(ALLOWED_PORT, 'Allowed page')
const deniedServer = await servePage(DENIED_PORT, 'Denied page')
const allowedUrl = `http://127.0.0.1:${ALLOWED_PORT}/`
const deniedUrl = `http://127.0.0.1:${DENIED_PORT}/`

let extension = null
let nextId = 1
const pending = new Map()

const wss = new WebSocketServer({ host: '127.0.0.1', port: BRIDGE_PORT })
await new Promise((resolve) => wss.on('listening', resolve))

console.log(`bridge listening on 127.0.0.1:${BRIDGE_PORT}`)
console.log(`token: ${token}`)
console.log('')
console.log('확장 옵션에서 위 토큰으로 연결하세요. allowlist 는 지금은 비워 둔 상태여야 합니다.\n')

function call(method, params = {}) {
    const id = nextId++
    const answered = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    extension.send(JSON.stringify({ id, method, params }))
    return answered
}

/** Run a call that is expected to be refused by the allowlist. */
async function expectDenied(label, method, params) {
    try {
        const result = await call(method, params)
        throw new Error(`${label} — expected SITE_NOT_ALLOWED, but it succeeded with ${JSON.stringify(result)}`)
    } catch (e) {
        if (/TAB_NOT_FOUND/.test(e.message)) {
            // Distinguish "the harness lost its fixture" from "the product
            // failed to refuse" — they look the same in a red test otherwise.
            throw new Error(`${label} — 검증용 탭이 닫혀 있어 확인할 수 없습니다. Phase A 에서 열린 "Denied page" 탭을 닫지 말고 다시 실행해 주세요.`)
        }
        if (!/SITE_NOT_ALLOWED/.test(e.message)) throw new Error(`${label} — expected SITE_NOT_ALLOWED, got: ${e.message}`)
        // The refusal must not hand back the URL it is hiding.
        if (e.message.includes(`:${DENIED_PORT}`)) {
            throw new Error(`${label} — 거부 메시지가 가려야 할 URL 을 노출했습니다: ${e.message}`)
        }
        console.log(`  ok  ${label}`)
    }
}

function check(label, condition, detail) {
    if (!condition) throw new Error(`${label} — ${detail}`)
    console.log(`  ok  ${label}`)
}

let started = false

wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== token) {
        socket.close(4401, 'invalid token')
        return
    }
    extension = socket
    // The handler goes on every socket — a reconnect must still deliver
    // responses for the run already in flight.
    socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return }
        const p = pending.get(message.id)
        if (!p) return
        pending.delete(message.id)
        if (message.error) p.reject(new Error(`${message.error.code}: ${message.error.message}`))
        else p.resolve(message.result)
    })

    // Reloading the extension mid-run reconnects; without this guard the run
    // restarted and two interleaved runs shared one request-id counter.
    if (started) {
        console.log('✓ extension reconnected — continuing the run in progress')
        return
    }
    started = true
    console.log('✓ extension connected\n')
    run().then(
        () => { console.log('\n=== ALL CHECKS PASSED ==='); cleanup(0) },
        (err) => { console.error('\n=== FAILED ===\n', err.message); cleanup(1) }
    )
})

function cleanup(code) {
    allowedServer.close()
    deniedServer.close()
    wss.close()
    process.exit(code)
}

async function waitForAllowlist() {
    console.log('')
    console.log('──────────────────────────────────────────────────────────────')
    console.log('  확장 옵션 페이지에서 allowlist 에 아래 한 줄을 넣고 저장하세요:')
    console.log('')
    console.log(`      127.0.0.1:${ALLOWED_PORT}`)
    console.log('')
    console.log('  (에이전트가 스스로 allowlist 를 바꿀 수 없는 게 이 기능의 요점이라')
    console.log('   이 단계만 사람이 해야 합니다. 저장하면 자동으로 이어집니다.)')
    console.log('──────────────────────────────────────────────────────────────\n')

    // Wait for the end state itself — "every listed tab is on the allowed
    // origin" — not for one tab to vanish. A single tab disappearing also
    // happens when the user simply closes it, and an earlier version of this
    // script took that as proof and ran the whole Phase B against an
    // unrestricted extension.
    const deadline = Date.now() + 5 * 60_000
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        const { tabs } = await call('tabs_list')
        const outside = tabs.filter((tab) => !(tab.url ?? '').startsWith(allowedUrl))
        if (outside.length === 0) return
    }
    throw new Error('allowlist 가 5분 안에 적용되지 않았습니다')
}

async function run() {
    console.log('Phase A — allowlist 없이 기준선 확인')
    const deniedTab = await call('tabs_open', { url: deniedUrl })
    check('열어 둔 탭이 tabs_list 에 보인다', (await call('tabs_list')).tabs.some((t) => t.id === deniedTab.id), 'tab missing')

    await waitForAllowlist()

    console.log('Phase B — allowlist 적용 후')
    const listed = (await call('tabs_list')).tabs

    check(
        'allowlist 밖 탭은 tabs_list 에서 사라진다',
        !listed.some((t) => t.id === deniedTab.id),
        `still listed: ${JSON.stringify(listed.map((t) => t.url))}`,
    )
    check(
        'tabs_list 에 남은 탭은 전부 허용된 오리진이다 (실제 브라우저의 다른 탭들이 걸러졌는지)',
        listed.every((t) => (t.url ?? '').startsWith(`http://127.0.0.1:${ALLOWED_PORT}`)),
        `leaked: ${JSON.stringify(listed.map((t) => t.url))}`,
    )

    await expectDenied('허용되지 않은 탭 snapshot 거부', 'snapshot', { tabId: deniedTab.id })
    await expectDenied('허용되지 않은 탭 screenshot 거부', 'screenshot', { tabId: deniedTab.id })
    await expectDenied('허용되지 않은 탭 click 거부', 'click', { tabId: deniedTab.id, ref: '@e1' })
    await expectDenied('허용되지 않은 탭 close 거부', 'tabs_close', { tabId: deniedTab.id })
    await expectDenied('허용되지 않은 URL 로 tabs_open 거부', 'tabs_open', { url: deniedUrl })

    console.log('')
    console.log('허용된 경로는 그대로 동작하는지')
    const allowedTab = await call('tabs_open', { url: allowedUrl })
    check('허용된 URL 은 열린다', typeof allowedTab.id === 'number', JSON.stringify(allowedTab))

    let snap
    for (let i = 0; i < 6 && !snap?.elements?.length; i++) {
        await new Promise((r) => setTimeout(r, 300))
        snap = await call('snapshot', { tabId: allowedTab.id })
    }
    check('허용된 탭 snapshot 동작', snap.elements.length > 0, JSON.stringify(snap))
    const buttonRef = snap.elements.find((e) => e.role === 'button')?.ref
    check('허용된 탭 click 동작', (await call('click', { tabId: allowedTab.id, ref: buttonRef })).ok === true, 'click failed')

    // The bypass that makes an allowlist pointless if missed: move a permitted
    // tab to a forbidden site, then act on it there.
    await expectDenied('허용된 탭을 금지된 URL 로 navigate 거부', 'navigate', { tabId: allowedTab.id, url: deniedUrl })

    check('ping 은 allowlist 와 무관하게 동작', (await call('ping')) === 'pong', 'ping failed')

    console.log('')
    let selfEditRejected = false
    try {
        await call('set_allowlist', { allowlist: '' })
    } catch (e) {
        selfEditRejected = /UNKNOWN_METHOD/.test(e.message)
    }
    check('에이전트가 allowlist 를 바꾸는 명령은 존재하지 않는다', selfEditRejected, 'a self-edit command exists — that would defeat the allowlist')

    await call('tabs_close', { tabId: allowedTab.id })
    console.log('')
    console.log(`정리: 허용되지 않은 탭(${deniedUrl})은 확장이 닫기를 거부하므로 직접 닫아 주세요 — 의도된 동작입니다.`)
}

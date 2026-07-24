/**
 * Unattended real-Chrome verification of the Phase 5 debugger tier.
 *
 * Two manual steps are inherent, not gaps in the harness: enabling the
 * optional `debugger` permission requires a user gesture on the options page
 * (chrome.permissions.request), by design — same reasoning as the allowlist
 * in verify-allowlist.mjs. The script detects the grant by polling
 * `capabilities` rather than being told, so a stale "done" click can't fool it.
 *
 *   node scripts/verify-debugger.mjs
 */

import { WebSocketServer } from 'ws'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 41777
const PAGE_PORT = Number(process.env.VERIFY_PAGE_PORT) || 41780
const token = process.env.BRIDGE_TOKEN || randomBytes(32).toString('hex')

const pageServer = http.createServer(async (_req, res) => {
    const html = await readFile(path.join(__dirname, 'verify-debugger.html'))
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
})
await new Promise((resolve) => pageServer.listen(PAGE_PORT, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${PAGE_PORT}/`

let extension = null
let nextId = 1
const pending = new Map()

const wss = new WebSocketServer({ host: '127.0.0.1', port: BRIDGE_PORT })
await new Promise((resolve) => wss.on('listening', resolve))
console.log(`bridge listening on 127.0.0.1:${BRIDGE_PORT}`)
console.log(`token: ${token}`)
console.log('')
console.log('확장 옵션에서 위 토큰으로 연결하세요. "정밀 제어" 토글은 지금은 꺼둔 상태여야 합니다.\n')

function call(method, params = {}) {
    const id = nextId++
    const answered = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    extension.send(JSON.stringify({ id, method, params }))
    return answered
}

async function expectDebuggerUnavailable(label, method, params) {
    try {
        const result = await call(method, params)
        throw new Error(`${label} — expected DEBUGGER_NOT_AVAILABLE, but it succeeded with ${JSON.stringify(result)}`)
    } catch (e) {
        if (!/DEBUGGER_NOT_AVAILABLE/.test(e.message)) throw new Error(`${label} — expected DEBUGGER_NOT_AVAILABLE, got: ${e.message}`)
        if (!/options/i.test(e.message)) throw new Error(`${label} — refusal doesn't say how to enable it: ${e.message}`)
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
    socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return }
        const p = pending.get(message.id)
        if (!p) return
        pending.delete(message.id)
        if (message.error) p.reject(new Error(`${message.error.code}: ${message.error.message}`))
        else p.resolve(message.result)
    })
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
    pageServer.close()
    wss.close()
    process.exit(code)
}

async function snapshotUntilReady(tabId, tries = 6) {
    for (let i = 0; i < tries; i++) {
        const snap = await call('snapshot', { tabId })
        if (snap.elements.length > 0) return snap
        await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error('page never produced a snapshot with elements — did it load?')
}

async function waitForDebuggerPermission() {
    console.log('')
    console.log('──────────────────────────────────────────────────────────────')
    console.log('  확장 옵션 페이지에서 "정밀 제어 켜기" 버튼을 눌러 주세요.')
    console.log('  (에이전트가 스스로 켤 수 없는 게 이 기능의 요점이라')
    console.log('   이 단계만 사람이 해야 합니다. 켜면 자동으로 이어집니다.)')
    console.log('──────────────────────────────────────────────────────────────\n')

    const deadline = Date.now() + 5 * 60_000
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        const caps = await call('capabilities')
        if (caps.debugger) return
    }
    throw new Error('정밀 제어가 5분 안에 켜지지 않았습니다')
}

async function run() {
    console.log('Phase A — 정밀 제어 꺼진 상태')
    const caps1 = await call('capabilities')
    check('capabilities 가 debugger:false 를 보고한다', caps1.debugger === false, JSON.stringify(caps1))
    check('capabilities 가 명령 목록을 제공한다', caps1.commands.includes('snapshot'), JSON.stringify(caps1))

    const tab = await call('tabs_open', { url: pageUrl })
    const snap1 = await snapshotUntilReady(tab.id)
    const buttonRef = snap1.elements.find((e) => e.name?.includes('Trusted-only'))?.ref
    const textRef = snap1.elements.find((e) => e.name === 'Text target')?.ref
    check('트리거 버튼을 찾았다', !!buttonRef, JSON.stringify(snap1.elements))
    check('텍스트 입력을 찾았다', !!textRef, JSON.stringify(snap1.elements))

    await expectDebuggerUnavailable('trusted click 은 권한 없이 실패한다', 'click', { tabId: tab.id, ref: buttonRef, trusted: true })
    await expectDebuggerUnavailable('trusted fill 은 권한 없이 실패한다', 'fill', { tabId: tab.id, ref: textRef, value: 'x', trusted: true })
    await expectDebuggerUnavailable('fullPage screenshot 은 권한 없이 실패한다', 'screenshot', { tabId: tab.id, fullPage: true })

    console.log('')
    console.log('일반(untrusted) click 은 권한 없이도 그대로 동작하는지')
    await call('click', { tabId: tab.id, ref: buttonRef })
    const afterPlainClick = await call('snapshot', { tabId: tab.id })
    const markerAfterPlain = afterPlainClick.elements.find((e) => e.name === 'Marker')?.value
    check('untrusted click 은 트리거되지만 isTrusted 는 false 다', markerAfterPlain === 'untrusted-clicked', `got: ${markerAfterPlain}`)

    await waitForDebuggerPermission()

    console.log('Phase B — 정밀 제어 켜진 상태')
    const caps2 = await call('capabilities')
    check('capabilities 가 debugger:true 를 보고한다', caps2.debugger === true, JSON.stringify(caps2))

    console.log('')
    console.log('trusted click 이 실제로 isTrusted 이벤트를 발생시키는지')
    await call('click', { tabId: tab.id, ref: buttonRef, trusted: true })
    const afterTrustedClick = await call('snapshot', { tabId: tab.id })
    const markerAfterTrusted = afterTrustedClick.elements.find((e) => e.name === 'Marker')?.value
    check('trusted click 은 isTrusted:true 로 도착한다', markerAfterTrusted === 'trusted-clicked', `got: ${markerAfterTrusted}`)

    console.log('')
    console.log('trusted fill 이 실제로 텍스트를 입력하는지')
    await call('fill', { tabId: tab.id, ref: textRef, value: 'typed by CDP', trusted: true })
    const afterFill = await call('snapshot', { tabId: tab.id })
    const textValue = afterFill.elements.find((e) => e.name === 'Text target')?.value
    check('trusted fill 값이 실제로 들어갔다', textValue === 'typed by CDP', `got: ${JSON.stringify(textValue)}`)

    console.log('')
    console.log('fullPage screenshot 이 뷰포트 캡처보다 더 많은 내용을 담는지 (바이트 크기로 추정)')
    const viewportShot = await call('screenshot', { tabId: tab.id })
    const fullShot = await call('screenshot', { tabId: tab.id, fullPage: true })
    check('둘 다 PNG 데이터를 반환한다', viewportShot.dataB64.length > 100 && fullShot.dataB64.length > 100, 'missing data')
    console.log(`      viewport: ${viewportShot.dataB64.length} chars, fullPage: ${fullShot.dataB64.length} chars`)
    check(
        'fullPage 캡처가 뷰포트 캡처보다 뚜렷이 크다 (페이지 하단의 빨간 마커까지 담겼다는 신호)',
        fullShot.dataB64.length > viewportShot.dataB64.length * 1.3,
        `viewport=${viewportShot.dataB64.length} fullPage=${fullShot.dataB64.length}`,
    )

    console.log('')
    console.log('디버거 티어도 allowlist 를 따르는지는 verify-allowlist.mjs 에서 이미 확인했습니다 (protocol.test.js 로도 고정됨).')

    await call('tabs_close', { tabId: tab.id })
}

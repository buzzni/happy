/**
 * Unattended real-Chrome verification of shadow-DOM and iframe snapshots.
 *
 * The interesting part is not "does it list more elements" but whether a
 * frame-qualified ref actually acts inside that frame — the merge assigns
 * refs, and a wrong frame would click something else entirely.
 *
 *   node scripts/verify-frames.mjs
 */

import { WebSocketServer } from 'ws'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 41777
const PAGE_PORT = Number(process.env.VERIFY_PAGE_PORT) || 41781
const token = process.env.BRIDGE_TOKEN || randomBytes(32).toString('hex')

const pageServer = http.createServer(async (req, res) => {
    const file = req.url === '/frame' ? 'verify-frames-child.html' : 'verify-frames.html'
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(await readFile(path.join(__dirname, file)))
})
await new Promise((resolve) => pageServer.listen(PAGE_PORT, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${PAGE_PORT}/`

let extension = null
let nextId = 1
const pending = new Map()

const wss = new WebSocketServer({ host: '127.0.0.1', port: BRIDGE_PORT })
await new Promise((resolve) => wss.on('listening', resolve))
console.log(`bridge listening on 127.0.0.1:${BRIDGE_PORT}`)
console.log(`token: ${token}\n`)

function call(method, params = {}) {
    const id = nextId++
    const answered = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    extension.send(JSON.stringify({ id, method, params }))
    return answered
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
    if (started) { console.log('✓ extension reconnected'); return }
    started = true
    console.log('✓ extension connected\n')
    run().then(
        () => { console.log('\n=== ALL CHECKS PASSED ==='); cleanup(0) },
        (err) => { console.error('\n=== FAILED ===\n', err.message); cleanup(1) },
    )
})

function cleanup(code) {
    pageServer.close()
    wss.close()
    process.exit(code)
}

const named = (snap, name) => snap.elements.find((e) => e.name === name)

async function snapshotUntilFrameReady(tabId, tries = 10) {
    for (let i = 0; i < tries; i++) {
        const snap = await call('snapshot', { tabId })
        if (named(snap, 'Frame button')) return snap
        await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error('iframe never appeared in the snapshot — did the child frame load?')
}

async function run() {
    const tab = await call('tabs_open', { url: pageUrl })
    const snap = await snapshotUntilFrameReady(tab.id)
    console.log(`  (${snap.elements.length} elements: ${snap.elements.map((e) => e.ref).join(', ')})\n`)

    check('light DOM 버튼을 찾았다', !!named(snap, 'Light DOM button'), JSON.stringify(snap.elements))
    check('shadow root 안의 버튼을 찾았다', !!named(snap, 'Shadow button'), JSON.stringify(snap.elements))
    check('iframe 안의 버튼을 찾았다', !!named(snap, 'Frame button'), JSON.stringify(snap.elements))

    const frameButton = named(snap, 'Frame button')
    check('iframe 요소의 ref 가 프레임 id 로 한정된다', /^@f\d+:e\d+$/.test(frameButton.ref), `ref=${frameButton.ref}`)
    check('iframe 요소에 frameUrl 이 붙는다', typeof frameButton.frameUrl === 'string', JSON.stringify(frameButton))
    check('메인 프레임 요소는 한정되지 않은 ref 를 유지한다', /^@e\d+$/.test(named(snap, 'Light DOM button').ref), named(snap, 'Light DOM button').ref)
    check('메인 프레임 요소가 목록 앞에 온다', snap.elements[0].ref.startsWith('@e'), snap.elements[0].ref)

    console.log('')
    console.log('각 ref 가 실제로 자기 영역에서 동작하는지')

    await call('click', { tabId: tab.id, ref: named(snap, 'Shadow button').ref })
    const afterShadow = await call('snapshot', { tabId: tab.id })
    check('shadow root 안의 클릭이 그 안의 상태를 바꿨다', named(afterShadow, 'Shadow result')?.value === 'shadow-clicked', `got: ${named(afterShadow, 'Shadow result')?.value}`)
    check('shadow 클릭이 메인 프레임을 건드리지 않았다', named(afterShadow, 'Light result')?.value === 'untouched', `got: ${named(afterShadow, 'Light result')?.value}`)

    await call('click', { tabId: tab.id, ref: named(afterShadow, 'Frame button').ref })
    const afterFrame = await call('snapshot', { tabId: tab.id })
    check('iframe 안의 클릭이 그 프레임의 상태를 바꿨다', named(afterFrame, 'Frame result')?.value === 'frame-clicked', `got: ${named(afterFrame, 'Frame result')?.value}`)
    check('iframe 클릭이 메인 프레임을 건드리지 않았다', named(afterFrame, 'Light result')?.value === 'untouched', `got: ${named(afterFrame, 'Light result')?.value}`)

    await call('fill', { tabId: tab.id, ref: named(afterFrame, 'Frame text').ref, value: 'typed in frame' })
    const afterFill = await call('snapshot', { tabId: tab.id })
    check('iframe 안의 입력이 그 프레임에 들어갔다', named(afterFill, 'Frame text')?.value === 'typed in frame', `got: ${named(afterFill, 'Frame text')?.value}`)

    await call('click', { tabId: tab.id, ref: named(afterFill, 'Light DOM button').ref })
    const afterLight = await call('snapshot', { tabId: tab.id })
    check('메인 프레임 클릭도 정상 동작한다', named(afterLight, 'Light result')?.value === 'light-clicked', `got: ${named(afterLight, 'Light result')?.value}`)

    await call('tabs_close', { tabId: tab.id })
}

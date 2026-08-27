/**
 * Unattended real-Chrome verification of Phase 2/3: snapshot, fill, click,
 * screenshot, and contenteditable — against a local, deterministic test
 * page so the check doesn't depend on whatever tabs happen to be open.
 *
 * Speaks the same protocol as happy-cli's BrowserBridge (see dev-bridge.mjs).
 * The user only has to point the already-loaded extension at this bridge
 * (same token flow as dev-bridge) and load the printed URL, or the script
 * opens it itself via tabs_open once connected.
 *
 *   node scripts/verify-interaction.mjs
 */

import { WebSocketServer } from 'ws'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 41777
const PAGE_PORT = Number(process.env.VERIFY_PAGE_PORT) || 41778
const token = process.env.BRIDGE_TOKEN || randomBytes(32).toString('hex')

const pageServer = http.createServer(async (req, res) => {
    const html = await readFile(path.join(__dirname, 'verify-page.html'))
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
console.log(`test page: ${pageUrl}`)
console.log('Point the extension options page at this token (reload the extension if it was already connected elsewhere), then wait.\n')

function call(method, params) {
    const id = nextId++
    const answered = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    extension.send(JSON.stringify({ id, method, params }))
    return answered
}

wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== token) {
        socket.close(4401, 'invalid token')
        return
    }
    console.log('✓ extension connected — running verification\n')
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
    runVerification().then(
        () => { console.log('\n=== ALL CHECKS PASSED ==='); cleanup(0) },
        (err) => { console.error('\n=== FAILED ===\n', err); cleanup(1) }
    )
})

function cleanup(code) {
    pageServer.close()
    wss.close()
    process.exit(code)
}

function check(label, condition, detail) {
    if (!condition) throw new Error(`${label} — ${detail}`)
    console.log(`  ok  ${label}`)
}

async function snapshotUntilReady(tabId, tries = 6) {
    for (let i = 0; i < tries; i++) {
        const snap = await call('snapshot', { tabId })
        if (snap.elements.length > 0) return snap
        await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error('page never produced a snapshot with elements — did it load?')
}

async function snapshotUntilNamed(tabId, name, tries = 10) {
    for (let i = 0; i < tries; i++) {
        const snap = await call('snapshot', { tabId })
        if (snap.elements.some((element) => element.name === name)) return snap
        await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`${name} never appeared after scrolling`)
}

async function runVerification() {
    console.log('1. tabs_open')
    const tab = await call('tabs_open', { url: pageUrl })
    check('new tab has an id', typeof tab.id === 'number', JSON.stringify(tab))

    console.log('2. snapshot (initial)')
    const snap1 = await snapshotUntilReady(tab.id)
    check('found the name input', snap1.elements.some((e) => e.role === 'textbox' && e.name === 'Your name'), JSON.stringify(snap1.elements))
    check('found the submit button', snap1.elements.some((e) => e.role === 'button' && e.name === 'Submit'), JSON.stringify(snap1.elements))
    check('hidden ancestor subtrees stay out of the snapshot', !snap1.elements.some((e) => e.name.endsWith('fixture action')), JSON.stringify(snap1.elements))
    check('closed details exposes its summary', snap1.elements.some((e) => e.role === 'button' && e.name === 'Collapsed details summary'), JSON.stringify(snap1.elements))
    check('closed details keeps collapsed controls out', !snap1.elements.some((e) => e.name === 'Collapsed details action'), JSON.stringify(snap1.elements))
    check('clipped controls stay out of the viewport tail', !snap1.elements.some((e) => e.role === 'button' && e.name.startsWith('Clipped fixture action')), JSON.stringify(snap1.elements))
    check('a visible control after clipped controls stays actionable', snap1.elements.some((e) => e.name === 'Visible after clipped controls'), JSON.stringify(snap1.elements))
    check('a fixed control escapes a non-containing overflow ancestor', snap1.elements.some((e) => e.name === 'Fixed escape action'), JSON.stringify(snap1.elements))
    const inputRef = snap1.elements.find((e) => e.name === 'Your name').ref
    const buttonRef = snap1.elements.find((e) => e.name === 'Submit').ref
    const editableRef = snap1.elements.find((e) => e.role === 'textbox' && e.tag === 'div')?.ref

    console.log('3. fill the name input, then snapshot to confirm the value actually landed')
    const fillResult = await call('fill', { tabId: tab.id, ref: inputRef, value: 'Happy' })
    console.log(`   fill() immediate readback: ${JSON.stringify(fillResult)}`)
    const snapAfterFill = await call('snapshot', { tabId: tab.id })
    const nameValue = (snapAfterFill.elements.find((e) => e.name === 'Your name') || {}).value
    check('name input value is "Happy" after fill', nameValue === 'Happy', `got: ${JSON.stringify(snapAfterFill.elements.map((e) => [e.name, e.value]))}`)

    console.log('4. click submit, then snapshot to confirm its click handler ran')
    await call('click', { tabId: tab.id, ref: buttonRef })
    const snap2 = await call('snapshot', { tabId: tab.id })
    const resultValue = (snap2.elements.find((e) => e.name === 'Result') || {}).value
    check('page shows "Hello, Happy!"', resultValue === 'Hello, Happy!', `got: ${JSON.stringify(snap2.elements.map((e) => [e.name, e.value]))}`)

    if (editableRef) {
        console.log('6. fill contenteditable')
        await call('fill', { tabId: tab.id, ref: editableRef, value: 'edited by happy' })
        const snap3 = await call('snapshot', { tabId: tab.id })
        check('contenteditable text updated', snap3.elements.some((e) => e.name === 'edited by happy'), JSON.stringify(snap3.elements))
    } else {
        console.log('6. (skipped — no contenteditable ref found in snapshot)')
    }

    console.log('7. scroll a nested lazy-loading region')
    const nestedBefore = await call('snapshot', { tabId: tab.id })
    check('nested lazy item starts absent', !nestedBefore.elements.some((element) => element.name === 'Nested lazy item'), JSON.stringify(nestedBefore.elements))
    const nestedRegion = nestedBefore.elements.find((element) => element.role === 'scrollable' && element.name === 'Nested lazy results')
    check('snapshot exposes the nested scrollable region', !!nestedRegion, JSON.stringify(nestedBefore.elements))
    const nestedScroll = await call('scroll', { tabId: tab.id, ref: nestedRegion.ref, deltaY: 800 })
    check('nested region actually moved', nestedScroll.moved && nestedScroll.after.y > nestedScroll.before.y, JSON.stringify(nestedScroll))
    await snapshotUntilNamed(tab.id, 'Nested lazy item')
    console.log('  ok  nested lazy item appeared after scroll + re-snapshot')

    console.log('8. scroll an overflow-hidden region with forced instant behavior')
    const hiddenOverflowBefore = await call('snapshot', { tabId: tab.id })
    const hiddenOverflowRegion = hiddenOverflowBefore.elements.find((element) => element.role === 'scrollable' && element.name === 'Hidden overflow results')
    check('snapshot exposes the overflow-hidden region', !!hiddenOverflowRegion, JSON.stringify(hiddenOverflowBefore.elements))
    const hiddenOverflowScroll = await call('scroll', { tabId: tab.id, ref: hiddenOverflowRegion.ref, deltaY: 400 })
    check('overflow-hidden region moves immediately despite smooth CSS', hiddenOverflowScroll.moved && hiddenOverflowScroll.after.y > hiddenOverflowScroll.before.y, JSON.stringify(hiddenOverflowScroll))

    console.log('9. scroll a shadow container through its slotted control')
    const slottedBefore = await call('snapshot', { tabId: tab.id })
    const slottedItem = slottedBefore.elements.find((element) => element.name === 'Slotted first item')
    check('snapshot exposes the slotted control', !!slottedItem, JSON.stringify(slottedBefore.elements))
    const slottedScroll = await call('scroll', { tabId: tab.id, ref: slottedItem.ref, deltaY: 300 })
    check('assigned-slot traversal reaches the shadow scroller', slottedScroll.moved && slottedScroll.after.y > slottedScroll.before.y, JSON.stringify(slottedScroll))

    console.log('10. scroll the document to a lazy-loading item')
    const documentBefore = await call('snapshot', { tabId: tab.id })
    check('long page snapshot is truncated', documentBefore.truncated === true, JSON.stringify(documentBefore))
    check('document lazy item starts absent', !documentBefore.elements.some((element) => element.name === 'Document lazy item'), JSON.stringify(documentBefore.elements))
    const documentScroll = await call('scroll', { tabId: tab.id, deltaY: 10_000 })
    check('document actually moved', documentScroll.moved && documentScroll.after.y > documentScroll.before.y, JSON.stringify(documentScroll))
    const documentAfter = await snapshotUntilNamed(tab.id, 'Document lazy item')
    const documentLazyRef = documentAfter.elements.find((element) => element.name === 'Document lazy item').ref
    check('document lazy item is actionable beyond the first 200 refs', Number(documentLazyRef.slice(2)) > 200, documentLazyRef)

    console.log('11. screenshot')
    const shot = await call('screenshot', { tabId: tab.id })
    check('screenshot has png data', shot.mimeType === 'image/png' && shot.dataB64.length > 100, `len=${shot.dataB64?.length}`)

    console.log('12. REF_NOT_FOUND on an unknown ref')
    let staleRejected = false
    let staleOutcome
    try {
        staleOutcome = await call('click', { tabId: tab.id, ref: '@e999' })
        console.log(`   click(@e999) did NOT error — resolved with: ${JSON.stringify(staleOutcome)}`)
    } catch (e) {
        staleOutcome = e.message
        staleRejected = /REF_NOT_FOUND|No element for/.test(e.message)
    }
    check('unknown ref is rejected with guidance', staleRejected, `expected a REF_NOT_FOUND-style error, got: ${JSON.stringify(staleOutcome)}`)

    console.log('13. tabs_close')
    await call('tabs_close', { tabId: tab.id })
}

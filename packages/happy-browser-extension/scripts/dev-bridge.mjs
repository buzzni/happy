/**
 * Standalone bridge for verifying the extension without running a daemon.
 *
 * Speaks the same protocol as happy-cli's BrowserBridge, so the extension
 * connects exactly as it would in production. Useful when the real daemon is
 * busy with live sessions and must not be restarted.
 *
 *   node scripts/dev-bridge.mjs
 *   > paste the printed token into the extension options page
 *   > then type a method name (ping / tabs_list) and press enter
 *
 * BRIDGE_AUTO=1 runs ping + tabs_list automatically on the first connection
 * and exits — for unattended verification.
 */

import { WebSocketServer } from 'ws'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'

const PORT = Number(process.env.BRIDGE_PORT) || 41777
const token = process.env.BRIDGE_TOKEN || randomBytes(32).toString('hex')

let extension = null
let nextId = 1
const pending = new Map()

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })

wss.on('listening', () => {
    console.log(`bridge listening on 127.0.0.1:${PORT}`)
    console.log(`token: ${token}`)
    console.log('extension 옵션 페이지에 위 토큰을 입력하세요. 연결되면 명령을 입력할 수 있습니다.\n')
})

wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== token) {
        console.log('✗ rejected a connection with a bad token')
        socket.close(4401, 'invalid token')
        return
    }
    const profile = url.searchParams.get('profile') || 'default'
    console.log(`✓ extension connected (profile=${profile})`)
    extension = socket

    socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }))
            return
        }
        const resolve = pending.get(message.id)
        if (!resolve) return
        pending.delete(message.id)
        resolve(message)
    })

    socket.on('close', () => {
        if (extension === socket) extension = null
        console.log('✗ extension disconnected')
    })
})

function call(method) {
    const id = nextId++
    const answered = new Promise((resolve) => pending.set(id, resolve))
    extension.send(JSON.stringify({ id, method, params: {} }))
    return answered
}

if (process.env.BRIDGE_AUTO) {
    wss.on('connection', async (socket) => {
        if (extension !== socket) return
        // Let the extension finish its own setup before probing it.
        await new Promise((r) => setTimeout(r, 200))
        for (const method of ['ping', 'tabs_list']) {
            console.log(`\n--- ${method} ---`)
            console.log(JSON.stringify(await call(method), null, 2))
        }
        console.log('\nOK — 확장이 실제 Chrome에서 응답했습니다.')
        process.exit(0)
    })
} else {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'method> ' })
    rl.prompt()
    rl.on('line', async (line) => {
        const method = line.trim()
        if (!method) return rl.prompt()
        if (!extension) {
            console.log('아직 확장이 연결되지 않았습니다.')
            return rl.prompt()
        }
        console.log(JSON.stringify(await call(method), null, 2))
        rl.prompt()
    })
}

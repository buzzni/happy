/**
 * The direct route with terminal workers (aplus specs/terminal-survive-runner-restart): a scripted
 * worker connection stands in for the worker, so the awaits a worker adds can be held open.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import { bindRpcRequest } from '@slopus/happy-wire'
import { encodeBase64, encrypt, getRandomBytes } from '@/api/encryption'
import { attachTerminalWsRoute, MAX_DIRECT_TERMINALS_PER_USER, type TerminalWsRoute } from './controlServerTerminalWs'
import { _resetDaemonTerminalSessionsForTest } from './daemonTerminalSessions'
import { fakeWorkerConnection } from './terminalWorker/fakeWorkerConnection.testing'
import type { WorkerTerminalMeta } from './terminalWorker/protocol'
import { TerminalWorkerHost } from './terminalWorker/workerHost'

describe('/terminal with terminal workers', () => {
    let dir: string
    let server: Server
    let route: TerminalWsRoute
    let port: number
    const key = getRandomBytes(32)
    const creates: Array<{ id: string; meta: WorkerTerminalMeta }> = []
    let releaseCreates: () => void
    let createsHeld: Promise<void>

    beforeEach(async () => {
        dir = mkdtempSync(path.join(tmpdir(), 'tw-route-'))
        creates.length = 0
        createsHeld = new Promise((resolve) => { releaseCreates = resolve })
        const fake = fakeWorkerConnection(async (op, args) => {
            if (op !== 'create') return {}
            creates.push(args as { id: string; meta: WorkerTerminalMeta })
            await createsHeld
            return { pid: 4242 }
        })
        const host = new TerminalWorkerHost({ happyHome: dir, cliVersion: '1', enabled: true, log: () => {}, launch: async () => ({ connection: fake.connection, pid: 1 }) })
        server = createServer()
        route = attachTerminalWsRoute(server, {
            path: '/terminal', controlSecret: 'secret', allowedRoot: dir,
            getMachineEncryption: () => ({ encryptionKey: key, encryptionVariant: 'legacy', machineId: 'm1' }),
            terminalWorkers: host,
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        port = (server.address() as { port: number }).port
    })
    afterEach(async () => {
        releaseCreates()
        await route.close()
        server.close()
        _resetDaemonTerminalSessionsForTest()
        rmSync(dir, { recursive: true, force: true })
    })

    const connect = () => new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?token=secret`)
        ws.on('open', () => resolve(ws))
    })
    const open = (ws: WebSocket, params: string) => new Promise<{ data?: { ok?: boolean; sessionId?: string; caps?: Record<string, unknown> }; error?: string }>((resolve) => {
        const reqId = randomUUID()
        const receive = (raw: RawData) => {
            const message = JSON.parse(raw.toString())
            if (message.reqId !== reqId) return
            ws.off('message', receive)
            resolve(message)
        }
        ws.on('message', receive)
        ws.send(JSON.stringify({ reqId, event: 'terminal-open', data: { params } }))
    })
    const v1Params = () => encodeBase64(encrypt(key, 'legacy', { userId: 'user-1', cols: 80, rows: 24 }))
    const waitFor = async (check: () => boolean) => {
        for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
        expect(check()).toBe(true)
    }

    it('counts opens still waiting on the worker toward the per-user limit', async () => {
        const sockets = await Promise.all(Array.from({ length: MAX_DIRECT_TERMINALS_PER_USER + 3 }, connect))
        const answers = sockets.map((ws) => open(ws, v1Params()))
        await waitFor(() => creates.length === MAX_DIRECT_TERMINALS_PER_USER)
        releaseCreates()
        const settled = await Promise.all(answers)
        expect(settled.filter((answer) => answer.data?.ok === true)).toHaveLength(MAX_DIRECT_TERMINALS_PER_USER)
        expect(settled.filter((answer) => answer.error === 'Too many active terminals')).toHaveLength(3)
        expect(settled.find((answer) => answer.data?.ok)?.data?.caps).toMatchObject({ survive: true })
        for (const ws of sockets) ws.close()
    })

    it('creates a v2 terminal in the worker with its binding already in place, under the id it answers with', async () => {
        releaseCreates()
        const params = encodeBase64(encrypt(key, 'legacy', bindRpcRequest({
            method: 'terminal-open', scope: 'm1', nonce: encodeBase64(getRandomBytes(16)), issuedAt: Date.now(),
            params: { terminalBinding: 1, terminalKey: encodeBase64(getRandomBytes(32)), terminalId: encodeBase64(getRandomBytes(16)), cols: 80, rows: 24 },
        })))
        const ws = await connect()
        const answer = await open(ws, params)
        expect(answer.data?.ok).toBe(true)
        expect(creates).toHaveLength(1)
        expect(creates[0].id).toBe(answer.data?.sessionId)
        expect(creates[0].meta).toMatchObject({ contract: 'v2', binding: { terminalKey: expect.any(String), daemonNonce: expect.any(String), lastInSeq: 0 } })
        // `survive` is beside the proof, never in it (the proof caps are a strict schema on the client).
        expect(answer.data?.caps).toMatchObject({ survive: true, terminalBinding: { version: 1 } })
        ws.close()
    })
})

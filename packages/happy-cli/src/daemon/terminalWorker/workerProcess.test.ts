/**
 * The worker's protocol and lifetime rules (spec HR5·HR7), in-process with real PTYs: the same
 * `startTerminalWorker` the `terminal-worker` command runs, with short timers.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeFrame } from './frames'
import { connectTerminalWorker, type WorkerConnection } from './workerClient'
import { createWorkerPtySession } from './workerPtySession'
import { startTerminalWorker, type StartedTerminalWorker } from './workerProcess'
import { terminalWorkerRecordPath } from './record'
import type { WorkerDumpResult, WorkerEvent, WorkerListResult, WorkerTerminalMeta } from './protocol'

const posix = process.platform !== 'win32'
const meta: WorkerTerminalMeta = { userId: 'u1', route: 'direct', machineId: null, openedAt: 1 }

async function waitFor<T>(read: () => T | undefined | false, ms = 5_000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
        const value = read()
        if (value) return value
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

describe.runIf(posix)('terminal worker process', () => {
    let home: string
    let worker: StartedTerminalWorker | null
    let exited: number[]
    const connections: WorkerConnection[] = []

    beforeEach(() => {
        // Short: the socket path budget is 103 bytes on macOS.
        home = mkdtempSync('/tmp/twp-')
        worker = null
        exited = []
    })
    afterEach(async () => {
        for (const connection of connections.splice(0)) connection.close()
        await worker?.shutdown('test end')
        rmSync(home, { recursive: true, force: true })
    })

    const start = async (overrides: Partial<Parameters<typeof startTerminalWorker>[0]> = {}) => {
        worker = await startTerminalWorker({
            happyHome: home,
            recordId: '0123abcd-0000-4000-8000-000000000001',
            cliVersion: '9.9.9',
            protocolVersion: 1,
            log: () => {},
            onExit: (code) => exited.push(code),
            ...overrides,
        })
        return worker
    }
    const controller = async () => {
        const connection = await connectTerminalWorker(worker!.record)
        connections.push(connection)
        return connection
    }

    it('answers hello with its identity, and runs a shell whose output carries the seq it assigned', async () => {
        await start()
        const connection = await controller()
        expect(connection.ack).toMatchObject({ type: 'helloAck', pid: process.pid, protocolVersion: 1, cliVersion: '9.9.9' })

        const events: WorkerEvent[] = []
        connection.onEvent((event) => events.push(event))
        const { pid } = await connection.request<{ pid: number }>('create', { id: 't1', shell: '/bin/sh', args: [], meta })
        expect(pid).toBeGreaterThan(0)
        connection.post('write', { id: 't1', data: 'echo worker-$((40+2))\n' })
        await waitFor(() => events.some((event) => event.event === 'output' && event.data.includes('worker-42')))
        const seqs = events.flatMap((event) => event.event === 'output' ? [event.seq] : [])
        expect(seqs).toEqual(seqs.map((_, index) => index + 1))

        const dump = await connection.request<WorkerDumpResult>('dump', { id: 't1' })
        expect(dump).toMatchObject({ id: 't1', pid, meta, exit: null, lastSeq: seqs.at(-1) })
        expect(dump.frames.map((frame) => frame.chunk).join('')).toContain('worker-42')

        expect(await connection.request<WorkerListResult>('list')).toEqual({ terminals: [{ id: 't1', pid, exited: false }] })
        expect(await connection.request('terminate', { id: 't1', graceMs: 500 })).toEqual({ outcome: 'exited' })
        await waitFor(() => events.some((event) => event.event === 'exit' && event.id === 't1'))
    })

    it('drops a connection with the wrong secret and keeps its controller', async () => {
        await start()
        const connection = await controller()
        await expect(connectTerminalWorker({ ...worker!.record, secret: 'wrong' })).rejects.toThrow()
        expect(connection.isOpen()).toBe(true)
    })

    it('hands control to the newest authenticated connection and drops the previous one', async () => {
        await start()
        const first = await controller()
        const closed = new Promise<void>((resolve) => first.onClose(resolve))
        const second = await controller()
        await closed
        expect(first.isOpen()).toBe(false)
        expect(second.isOpen()).toBe(true)
    })

    it('keeps its terminals running when the controller goes, for the next one to take back', async () => {
        await start()
        const first = await controller()
        const { pid } = await first.request<{ pid: number }>('create', { id: 't1', shell: '/bin/sh', args: [], meta })
        first.close()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(exited).toEqual([])
        expect(() => process.kill(pid, 0)).not.toThrow()

        const second = await controller()
        expect(await second.request<WorkerListResult>('list')).toEqual({ terminals: [{ id: 't1', pid, exited: false }] })
    })

    it('a PtySession proxy writes, reports output with seqs, and its exit', async () => {
        await start()
        const connection = await controller()
        const { pid } = await connection.request<{ pid: number }>('create', { id: 't1', shell: '/bin/sh', args: [], meta, cols: 80, rows: 24 })
        const session = createWorkerPtySession({ connection, id: 't1', userId: 'u1', pid, cols: 80, rows: 24 })
        const output: Array<[number, string]> = []
        session.onOutput((seq, chunk) => output.push([seq, chunk]))
        const exit = new Promise<[number, number | null]>((resolve) => session.onExit((code, signal) => resolve([code, signal])))
        session.write('echo proxied\n')
        await waitFor(() => output.some(([, chunk]) => chunk.includes('proxied')))
        expect(session.isAlive()).toBe(true)
        session.write('exit 3\n')
        expect(await exit).toEqual([3, 0])
        expect(session.isAlive()).toBe(false)
        expect(await session.terminate()).toBe('already-gone')
    })

    it('exits when no controller arrives and it has no terminal (HR7 a)', async () => {
        await start({ firstControllerGraceMs: 50 })
        await waitFor(() => exited.length > 0)
        expect(existsSync(terminalWorkerRecordPath(home, worker!.record.recordId))).toBe(false)
        worker = null
    })

    it('exits once its last terminal ended and nobody controls it (HR7 b)', async () => {
        await start()
        const connection = await controller()
        await connection.request('create', { id: 't1', shell: '/bin/sh', args: [], meta })
        connection.close()
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(exited).toEqual([])
        // Nobody is attached; the shell ends on its own.
        const again = await controller()
        again.post('write', { id: 't1', data: 'exit\n' })
        await new Promise((resolve) => setTimeout(resolve, 300))
        again.close()
        await waitFor(() => exited.length > 0)
        worker = null
    })

    it('closes its terminals and exits when its record disappears (HR7 c)', async () => {
        await start({ recordCheckIntervalMs: 50 })
        const connection = await controller()
        const { pid } = await connection.request<{ pid: number }>('create', { id: 't1', shell: '/bin/sh', args: [], meta })
        rmSync(terminalWorkerRecordPath(home, worker!.record.recordId))
        await waitFor(() => exited.length > 0)
        await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } })
        worker = null
    })

    it('closes everything after too long without a controller (HR7 d)', async () => {
        await start({ recordCheckIntervalMs: 50, controllerlessLimitMs: 100 })
        const connection = await controller()
        await connection.request('create', { id: 't1', shell: '/bin/sh', args: [], meta })
        connection.close()
        await waitFor(() => exited.length > 0)
        worker = null
    })

    it('shuts down on the frozen shutdown request and ends its shells', async () => {
        await start()
        const connection = await controller()
        const { pid } = await connection.request<{ pid: number }>('create', { id: 't1', shell: '/bin/sh', args: [], meta })
        await connection.request('shutdown')
        await waitFor(() => exited.length > 0)
        await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } })
        worker = null
    })

    it('takes no new terminal or controller once shutting down, and answers only when its shells are gone', async () => {
        await start()
        const connection = await controller()
        // Ignores the hangup: shutdown has to wait out the grace and escalate.
        const { pid } = await connection.request<{ pid: number }>('create', { id: 't1', shell: '/bin/sh', args: ['-c', 'trap "" HUP; while :; do sleep 0.1; done'], meta })
        const shuttingDown = connection.request('shutdown')
        await expect(connection.request('create', { id: 't2', shell: '/bin/sh', args: [], meta })).rejects.toThrow('shutting down')
        await expect(connectTerminalWorker(worker!.record)).rejects.toThrow()
        await shuttingDown
        expect(() => process.kill(pid, 0)).toThrow()
        await waitFor(() => exited.length > 0)
        worker = null
    })

    it('drops a connection that never says hello', async () => {
        await start({ helloTimeoutMs: 50 })
        const socket = connect(worker!.socketPath)
        await new Promise<void>((resolve) => socket.once('close', () => resolve()))
    })

    it('destroys a connection that sends a malformed frame', async () => {
        await start()
        const socket = connect(worker!.socketPath)
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
        const header = Buffer.alloc(4)
        header.writeUInt32BE(3, 0)
        socket.write(Buffer.concat([header, Buffer.from('{{{'), encodeFrame({ type: 'hello' })]))
        await new Promise<void>((resolve) => socket.once('close', () => resolve()))
    })
})

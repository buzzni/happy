/**
 * Real processes (spec HR9): the built `happy terminal-worker`, launched detached the way the
 * daemon launches it. Needs `pnpm build` first (the vitest global setup runs it).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from '@/api/encryption'
import { readCurrentBootIdSync } from '@/utils/bootIdentity'
import { getProcessStartedAt } from '@/utils/processStartTime'
import { resolveHappyCliSpawnCommand } from '@/utils/spawnHappyCLI'
import { TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV, type WorkerListResult } from './protocol'
import { listTerminalWorkerRecords, writeTerminalWorkerRecord, type TerminalWorkerRecord } from './record'
import { connectTerminalWorker, launchTerminalWorker, type WorkerConnection } from './workerClient'

const posix = process.platform !== 'win32'
const meta = { userId: 'u1', route: 'direct', machineId: null, openedAt: 1 }

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
}
function pgidOf(pid: number): number {
    return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
}
async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}

describe.runIf(posix)('terminal worker as a real detached process', () => {
    let home: string
    const opened: WorkerConnection[] = []
    beforeEach(() => { home = mkdtempSync('/tmp/twi-') })
    afterEach(async () => {
        for (const connection of opened.splice(0)) {
            if (connection.isOpen()) await connection.request('shutdown').catch(() => {})
            connection.close()
        }
        rmSync(home, { recursive: true, force: true })
    })

    const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, HAPPY_HOME_DIR: home, ...extra })

    it('reports its protocol version from the installed build', () => {
        const command = resolveHappyCliSpawnCommand(['terminal-worker', '--protocol-version'])
        expect(execFileSync(command.runtime, command.args, { encoding: 'utf8', env: env() }).trim()).toBe('1')
    })

    it('runs in its own process group, records itself owner-only, and keeps its shells across controllers', async () => {
        const { connection, pid } = await launchTerminalWorker({ happyHome: home, env: env() })
        opened.push(connection)
        expect(connection.ack.pid).toBe(pid)
        expect(pgidOf(pid)).toBe(pid)
        expect(pgidOf(pid)).not.toBe(pgidOf(process.pid))

        const [file] = listTerminalWorkerRecords(home)
        if (!('record' in file)) throw file.error
        expect(statSync(file.path).mode & 0o777).toBe(0o600)
        expect(file.record).toMatchObject({ pid, protocolVersion: 1, startedAt: expect.any(Number) })

        const { pid: shellPid } = await connection.request<{ pid: number }>('create', { id: 't1', shell: '/bin/sh', args: [], meta })
        connection.close()
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(alive(pid)).toBe(true)
        expect(alive(shellPid)).toBe(true)

        const again = await connectTerminalWorker(file.record)
        opened.push(again)
        expect(await again.request<WorkerListResult>('list')).toEqual({ terminals: [{ id: 't1', pid: shellPid, exited: false }] })
        await again.request('shutdown')
        await waitFor(() => !alive(pid) && !alive(shellPid))
        expect(listTerminalWorkerRecords(home)).toEqual([])
    })

    it('a worker built for another protocol still answers the frozen hello and shutdown', async () => {
        const { connection, pid } = await launchTerminalWorker({ happyHome: home, env: env({ [TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV]: '7' }) })
        opened.push(connection)
        expect(connection.ack.protocolVersion).toBe(7)
        await connection.request('shutdown')
        await waitFor(() => !alive(pid))
    })
})

// ── A daemon restarting around its terminals (HR9) ──────────────────────────

const fixture = resolve(__dirname, 'terminalWorker.integration.fixture.ts')

interface Fixture { child: ChildProcess; port: number }
interface Frame { event: string; [key: string]: unknown }

class TerminalClient {
    readonly frames: Frame[] = []
    readonly acks = new Map<string, { data?: Record<string, unknown>; error?: string }>()
    private constructor(private readonly ws: WebSocket, private readonly key: Uint8Array) {
        ws.on('message', (raw) => {
            const message = JSON.parse(raw.toString()) as { reqId?: string; data?: Frame; error?: string }
            if (message.reqId) this.acks.set(message.reqId, { data: message.data as Record<string, unknown> | undefined, error: message.error })
            else if (message.data) this.frames.push(message.data)
        })
    }
    static async connect(port: number, key: Uint8Array): Promise<TerminalClient> {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?token=fixture-secret`)
        await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
        return new TerminalClient(ws, key)
    }
    private seal(value: unknown): string {
        return encodeBase64(encrypt(this.key, 'legacy', value))
    }
    async request(event: string, data: Record<string, unknown>): Promise<{ data?: Record<string, unknown>; error?: string }> {
        const reqId = randomUUID()
        this.ws.send(JSON.stringify({ reqId, event, data }))
        await waitFor(() => this.acks.has(reqId))
        return this.acks.get(reqId)!
    }
    open() {
        return this.request('terminal-open', { params: this.seal({ userId: 'u1', shell: '/bin/sh', args: [], cols: 80, rows: 24 }) })
    }
    attach(sessionId: string) {
        return this.request('terminal-attach', { sessionId, params: this.seal({ sessionId, userId: 'u1' }) })
    }
    type(sessionId: string, text: string) {
        this.ws.send(JSON.stringify({ event: 'terminal-frame', data: { sessionId, data: this.seal(text) } }))
    }
    resume(afterSeq: number) {
        this.ws.send(JSON.stringify({ event: 'terminal-resume', data: { afterSeq } }))
    }
    /** Output frames, opened, in arrival order. */
    output(): Array<{ seq: number; text: string }> {
        return this.frames.flatMap((frame) => {
            if (frame.event === 'terminal-frame') return [{ seq: frame.seq as number, text: decrypt(this.key, 'legacy', decodeBase64(frame.data as string)) as string }]
            if (frame.event === 'terminal-snapshot') return [{ seq: frame.seq as number, text: decrypt(this.key, 'legacy', decodeBase64(frame.data as string)) as string }]
            return []
        })
    }
    text(): string {
        return this.output().map((entry) => entry.text).join('')
    }
    close() { this.ws.close() }
}

describe.runIf(posix)('a daemon restarting around its terminals (HR9)', () => {
    let home: string
    let key: Uint8Array
    const children: ChildProcess[] = []
    beforeEach(() => {
        home = mkdtempSync('/tmp/twd-')
        key = getRandomBytes(32)
    })
    afterEach(async () => {
        for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
        // Whatever workers remain belong to this test's home; close them through their records.
        for (const file of listTerminalWorkerRecords(home)) {
            if (!('record' in file)) continue
            try {
                const connection = await connectTerminalWorker(file.record)
                await connection.request('shutdown').catch(() => {})
                connection.close()
            } catch {/* already gone */}
        }
        rmSync(home, { recursive: true, force: true })
    })

    const startDaemon = async (env: NodeJS.ProcessEnv = {}): Promise<Fixture> => {
        const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
            env: { ...process.env, HAPPY_HOME_DIR: home, FIXTURE_KEY: encodeBase64(key), ...env },
            stdio: 'ignore',
        })
        children.push(child)
        const portFile = join(home, `fixture-${child.pid}.port`)
        await waitFor(() => existsSync(portFile), 60_000)
        return { child, port: Number(readFileSync(portFile, 'utf8')) }
    }
    const stopDaemon = async (daemon: Fixture, signal: NodeJS.Signals) => {
        daemon.child.kill(signal)
        await waitFor(() => daemon.child.exitCode !== null || daemon.child.signalCode !== null, 20_000)
    }
    /** Opens a shell and learns its pid from the shell itself. */
    const openShell = async (daemon: Fixture) => {
        const client = await TerminalClient.connect(daemon.port, key)
        const ack = await client.open()
        expect(ack.error).toBeUndefined()
        const sessionId = ack.data!.sessionId as string
        client.type(sessionId, 'echo "pid=$$"\n')
        await waitFor(() => /pid=\d+/.test(client.text()))
        const shellPid = Number(/pid=(\d+)/.exec(client.text())![1])
        return { client, sessionId, shellPid, ack }
    }

    it('a crashed daemon\'s shell keeps running, and the next daemon takes it back with its output and seq', async () => {
        const first = await startDaemon()
        const { client, sessionId, shellPid, ack } = await openShell(first)
        expect(ack.data!.caps).toMatchObject({ attach: true, survive: true })
        client.type(sessionId, 'echo before-$((40+2))\n')
        await waitFor(() => client.text().includes('before-42'))
        const lastSeq = Math.max(...client.output().map((entry) => entry.seq))

        await stopDaemon(first, 'SIGKILL')
        client.close()
        await new Promise((r) => setTimeout(r, 300))
        expect(alive(shellPid)).toBe(true)

        const second = await startDaemon()
        const again = await TerminalClient.connect(second.port, key)
        const attached = await again.attach(sessionId)
        expect(attached.data).toMatchObject({ ok: true, sessionId, caps: { survive: true } })
        // The output before the crash is still there to resume from…
        again.resume(0)
        await waitFor(() => again.text().includes('before-42'))
        // …and the shell is the same one, numbering on from where it was.
        again.type(sessionId, 'echo "after pid=$$"\n')
        await waitFor(() => again.text().includes(`after pid=${shellPid}`))
        const afterSeqs = again.output().filter((entry) => entry.text.includes('after')).map((entry) => entry.seq)
        expect(Math.min(...afterSeqs)).toBeGreaterThan(lastSeq)
        again.close()

        await stopDaemon(second, 'SIGTERM')
        await waitFor(() => !alive(shellPid))
    })

    it('a restart that keeps terminals leaves the shell to the next daemon; a stop closes it', async () => {
        const first = await startDaemon()
        const { client, sessionId, shellPid } = await openShell(first)
        client.close()
        await stopDaemon(first, 'SIGUSR2')
        expect(alive(shellPid)).toBe(true)

        const second = await startDaemon()
        const again = await TerminalClient.connect(second.port, key)
        expect((await again.attach(sessionId)).data).toMatchObject({ ok: true })
        again.close()
        await stopDaemon(second, 'SIGTERM')
        await waitFor(() => !alive(shellPid))
        expect(listTerminalWorkerRecords(home)).toEqual([])
    })

    it('a worker of another protocol is shut down by the next daemon, never adopted', async () => {
        const first = await startDaemon({ [TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV]: '7' })
        const { client, sessionId, shellPid } = await openShell(first)
        client.close()
        await stopDaemon(first, 'SIGKILL')
        expect(alive(shellPid)).toBe(true)

        const second = await startDaemon()
        await waitFor(() => !alive(shellPid))
        const again = await TerminalClient.connect(second.port, key)
        expect(await again.attach(sessionId)).toMatchObject({ error: 'unknown-session' })
        again.close()
    })

    it('with workers off, the next daemon closes what an earlier one left (HR11)', async () => {
        const first = await startDaemon()
        const { client, shellPid, ack } = await openShell(first)
        client.close()
        await stopDaemon(first, 'SIGKILL')

        const second = await startDaemon({ FIXTURE_WORKERS: '0' })
        await waitFor(() => !alive(shellPid))
        const local = await TerminalClient.connect(second.port, key)
        const opened = await local.open()
        // Opened in the daemon itself, as before workers existed: nothing to promise about restarts.
        expect(opened.data!.caps).not.toHaveProperty('survive')
        expect(ack.data!.caps).toHaveProperty('survive', true)
        local.close()
    })

    it('retires orphan records without signalling anything, and leaves an unanswering live one alone', async () => {
        const write = (overrides: Partial<TerminalWorkerRecord>) => writeTerminalWorkerRecord(home, {
            recordId: randomUUID(), pid: process.pid, startedAt: getProcessStartedAt(process.pid) ?? null, bootId: readCurrentBootIdSync() ?? null,
            socketPath: join(home, 'nobody.sock'), secret: 'x', protocolVersion: 1, cliVersion: '1.0.0-test', createdAt: 1, ...overrides,
        })
        write({ bootId: 'an-earlier-boot' })        // this test's own pid, from "another boot"
        write({ pid: 2 ** 22 - 3 })                  // a pid nobody has
        write({ startedAt: 1 })                      // this test's pid, but someone else's start time
        write({})                                    // this test's pid and start: alive, socket silent
        await startDaemon()
        const left = listTerminalWorkerRecords(home)
        expect(left).toHaveLength(1)
        expect(left[0]).toMatchObject({ record: { pid: process.pid, startedAt: getProcessStartedAt(process.pid) ?? null } })
        expect(alive(process.pid)).toBe(true)
    })
})

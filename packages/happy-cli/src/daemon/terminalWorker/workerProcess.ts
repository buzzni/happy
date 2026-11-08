/**
 * The terminal worker (specs/terminal-survive-runner-restart HR1·HR5·HR7): a detached process
 * that owns PTYs so they outlive the daemon that opened them. One daemon controls it at a time
 * over an owner-only unix socket; whichever daemon authenticates last takes it over.
 *
 * Output is coalesced and numbered here, exactly as the daemon did in-process, so the seq a
 * client resumes from means the same thing before and after a restart (plan §2.3).
 *
 * Everything this module needs is imported statically: after an update replaced the installed
 * files, a lazily loaded chunk would no longer be there.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { readCurrentBootIdSync } from '@/utils/bootIdentity'
import { getProcessStartedAt } from '@/utils/processStartTime'
import { createPtySession, type PtySession, type TerminateOutcome } from '../remoteTerminal'
import { createTerminalOutputBuffer, type TerminalOutputBuffer } from '../terminalOutputBuffer'
import { createTerminalOutputCoalescer, type TerminalOutputCoalescer } from '../terminalOutputCoalescer'
import { attachFramedSocket, type FramedSocket } from './frames'
import {
    isRecord,
    type WorkerCreateArgs,
    type WorkerDumpResult,
    type WorkerEvent,
    type WorkerListResult,
    type WorkerRequest,
    type WorkerResponse,
    type WorkerTerminalMeta,
} from './protocol'
import { readTerminalWorkerRecord, retireTerminalWorkerRecord, terminalWorkerRecordPath, writeTerminalWorkerRecord, type TerminalWorkerRecord } from './record'
import { resolveTerminalWorkerSocketPath } from './socketPath'

export interface TerminalWorkerOptions {
    happyHome: string
    recordId: string
    cliVersion: string
    protocolVersion: number
    log: (message: string) => void
    /** HR7(a): no controller and no terminal this long after start → exit. */
    firstControllerGraceMs?: number
    /** HR7(c): how often the worker checks that its record still exists. */
    recordCheckIntervalMs?: number
    /** HR7(d): no controller this long → close everything and exit. */
    controllerlessLimitMs?: number
    /** Unauthenticated connections are dropped after this. */
    helloTimeoutMs?: number
    /** Called once the worker is gone, instead of exiting the process (tests). */
    onExit?: (code: number) => void
}

interface WorkerTerminal {
    readonly id: string
    readonly pty: PtySession
    readonly output: TerminalOutputBuffer
    readonly coalescer: TerminalOutputCoalescer
    meta: WorkerTerminalMeta
    exit: { code: number; signal: number | null } | null
}

const DEFAULT_FIRST_CONTROLLER_GRACE_MS = 30_000
const DEFAULT_RECORD_CHECK_INTERVAL_MS = 10_000
const DEFAULT_CONTROLLERLESS_LIMIT_MS = 24 * 60 * 60 * 1000
const DEFAULT_HELLO_TIMEOUT_MS = 5_000

function secretsMatch(expected: Buffer, presented: unknown): boolean {
    if (typeof presented !== 'string') return false
    const given = Buffer.from(presented, 'utf8')
    return given.length === expected.length && timingSafeEqual(given, expected)
}

export interface StartedTerminalWorker {
    socketPath: string
    record: TerminalWorkerRecord
    /** Closes every terminal and exits (SIGTERM does the same). */
    shutdown(why: string): Promise<void>
}

export async function startTerminalWorker(options: TerminalWorkerOptions): Promise<StartedTerminalWorker> {
    const log = options.log
    const secretText = randomBytes(32).toString('base64url')
    const secret = Buffer.from(secretText, 'utf8')
    const socketPath = resolveTerminalWorkerSocketPath({ happyHome: options.happyHome, recordId: options.recordId })
    const terminals = new Map<string, WorkerTerminal>()
    let controller: FramedSocket | null = null
    let controllerlessSince: number | null = Date.now()
    let exiting = false

    const liveCount = () => [...terminals.values()].filter((terminal) => terminal.exit === null).length

    const emit = (event: WorkerEvent) => { controller?.send(event) }

    const server: Server = createServer((socket) => handleConnection(socket))
    rmSync(socketPath, { force: true })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
            server.off('error', reject)
            resolve()
        })
    })
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600)

    const record: TerminalWorkerRecord = {
        recordId: options.recordId,
        pid: process.pid,
        startedAt: getProcessStartedAt(process.pid) ?? null,
        bootId: readCurrentBootIdSync() ?? null,
        socketPath,
        secret: secretText,
        protocolVersion: options.protocolVersion,
        cliVersion: options.cliVersion,
        createdAt: Date.now(),
    }
    writeTerminalWorkerRecord(options.happyHome, record)
    log(`[TERMINAL-WORKER] listening record=${record.recordId} pid=${record.pid} protocol=${record.protocolVersion} cli=${record.cliVersion}`)

    const timers: Array<ReturnType<typeof setInterval>> = []

    async function terminateAll(): Promise<TerminateOutcome[]> {
        return Promise.all([...terminals.values()].map((terminal) => terminal.exit
            ? Promise.resolve<TerminateOutcome>('already-gone')
            : terminal.pty.terminate().catch((): TerminateOutcome => 'escaped')))
    }

    async function shutdown(why: string): Promise<void> {
        if (exiting) return
        exiting = true
        log(`[TERMINAL-WORKER] shutting down (${why}) live=${liveCount()}`)
        for (const timer of timers) clearInterval(timer)
        const outcomes = await terminateAll()
        const escaped = outcomes.filter((outcome) => outcome === 'escaped').length
        if (escaped > 0) log(`[TERMINAL-WORKER] ${escaped} terminal(s) escaped termination`)
        finish()
    }

    /** Leaves without touching terminals — only reached when none is left alive. */
    function finish(): void {
        exiting = true
        for (const timer of timers) clearInterval(timer)
        try { retireTerminalWorkerRecord(options.happyHome, record) } catch {/* best effort */}
        controller?.close()
        server.close()
        log(`[TERMINAL-WORKER] exited record=${record.recordId}`)
        if (options.onExit) options.onExit(0)
        else process.exit(0)
    }

    /** HR7(b): nothing left to keep and nobody to keep it for. */
    function exitIfIdle(): void {
        if (!exiting && controller === null && liveCount() === 0) finish()
    }

    const firstGrace = setTimeout(() => {
        if (controller === null && terminals.size === 0) {
            log('[TERMINAL-WORKER] no controller arrived; exiting')
            finish()
        }
    }, options.firstControllerGraceMs ?? DEFAULT_FIRST_CONTROLLER_GRACE_MS)
    firstGrace.unref?.()

    timers.push(setInterval(() => {
        // HR7(c): the record is how daemons find this worker; without it nobody ever will again.
        let mine = false
        try {
            mine = readTerminalWorkerRecord(terminalWorkerRecordPath(options.happyHome, record.recordId)).recordId === record.recordId
        } catch {
            mine = false
        }
        if (!mine) {
            void shutdown('record removed')
            return
        }
        // HR7(d)
        const limit = options.controllerlessLimitMs ?? DEFAULT_CONTROLLERLESS_LIMIT_MS
        if (controllerlessSince !== null && Date.now() - controllerlessSince >= limit) void shutdown('no controller for too long')
    }, options.recordCheckIntervalMs ?? DEFAULT_RECORD_CHECK_INTERVAL_MS))

    function createTerminal(args: WorkerCreateArgs): { pid: number } {
        if (terminals.has(args.id)) throw new Error('terminal id already exists')
        const pty = createPtySession({
            userId: args.meta.userId,
            shell: args.shell,
            args: args.args,
            cwd: args.cwd,
            env: args.env,
            cols: args.cols,
            rows: args.rows,
        })
        const output = createTerminalOutputBuffer(args.bufferChars, args.bufferFrames)
        const coalescer = createTerminalOutputCoalescer({
            sessionId: args.id,
            emit: (chunk) => {
                const seq = output.push(chunk)
                emit({ type: 'event', event: 'output', id: args.id, seq, data: chunk })
            },
        })
        const terminal: WorkerTerminal = { id: args.id, pty, output, coalescer, meta: args.meta, exit: null }
        terminals.set(args.id, terminal)
        pty.onData((chunk) => coalescer.push(chunk))
        pty.onExit((code, signal) => {
            coalescer.flush()
            coalescer.dispose()
            terminal.exit = { code, signal }
            emit({ type: 'event', event: 'exit', id: args.id, code, signal })
            exitIfIdle()
        })
        return { pid: pty.pid }
    }

    function terminalOf(args: unknown): WorkerTerminal {
        const id = isRecord(args) ? args.id : undefined
        const terminal = typeof id === 'string' ? terminals.get(id) : undefined
        if (!terminal) throw new Error('unknown terminal')
        return terminal
    }

    async function handleRequest(request: WorkerRequest): Promise<unknown> {
        const args = request.args
        switch (request.op) {
            // ── frozen ──
            case 'list': {
                const result: WorkerListResult = {
                    terminals: [...terminals.values()].map((terminal) => ({ id: terminal.id, pid: terminal.pty.pid, exited: terminal.exit !== null })),
                }
                return result
            }
            case 'shutdown':
                // Answered first; the caller only needs to know it was heard.
                setImmediate(() => { void shutdown('requested') })
                return {}
            // ── version 1 ──
            case 'create':
                if (!isRecord(args) || typeof args.id !== 'string' || !isRecord(args.meta)) throw new Error('invalid create')
                return createTerminal(args as unknown as WorkerCreateArgs)
            case 'write': {
                const terminal = terminalOf(args)
                if (terminal.exit === null && isRecord(args) && typeof args.data === 'string') terminal.pty.write(args.data)
                return {}
            }
            case 'resize': {
                const terminal = terminalOf(args)
                if (terminal.exit === null && isRecord(args) && Number.isInteger(args.cols) && Number.isInteger(args.rows)) {
                    terminal.pty.resize(args.cols as number, args.rows as number)
                }
                return {}
            }
            case 'signal': {
                const terminal = terminalOf(args)
                if (terminal.exit === null && isRecord(args) && typeof args.signal === 'string') terminal.pty.kill(args.signal as NodeJS.Signals)
                return {}
            }
            case 'terminate': {
                const terminal = terminalOf(args)
                const graceMs = isRecord(args) && typeof args.graceMs === 'number' ? args.graceMs : undefined
                return { outcome: await terminal.pty.terminate(graceMs === undefined ? undefined : { graceMs }) }
            }
            case 'dump': {
                const terminal = terminalOf(args)
                const result: WorkerDumpResult = {
                    id: terminal.id,
                    pid: terminal.pty.pid,
                    cols: terminal.pty.cols,
                    rows: terminal.pty.rows,
                    meta: terminal.meta,
                    frames: terminal.output.frames(),
                    lastSeq: terminal.output.lastSeq(),
                    exit: terminal.exit,
                }
                return result
            }
            case 'setMeta': {
                const terminal = terminalOf(args)
                if (isRecord(args) && isRecord(args.meta)) terminal.meta = args.meta as unknown as WorkerTerminalMeta
                return {}
            }
            case 'forget': {
                const terminal = terminalOf(args)
                if (terminal.exit === null) throw new Error('terminal is still running')
                terminals.delete(terminal.id)
                return {}
            }
            default:
                throw new Error(`unknown op ${request.op}`)
        }
    }

    function handleConnection(socket: Socket): void {
        let authenticated = false
        const helloTimer = setTimeout(() => { if (!authenticated) socket.destroy() }, options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)
        helloTimer.unref?.()
        const framed = attachFramedSocket(socket, (message) => {
            if (!isRecord(message)) return
            if (!authenticated) {
                if (message.type !== 'hello' || !secretsMatch(secret, message.secret)) {
                    socket.destroy()
                    return
                }
                authenticated = true
                clearTimeout(helloTimer)
                // The newest authenticated connection is the controller; the previous one is dropped.
                const previous = controller
                controller = framed
                controllerlessSince = null
                if (previous && previous !== framed) previous.socket.destroy()
                framed.send({ type: 'helloAck', pid: process.pid, protocolVersion: options.protocolVersion, cliVersion: options.cliVersion })
                return
            }
            if (message.type !== 'request' || typeof message.requestId !== 'string' || typeof message.op !== 'string') return
            const request = message as unknown as WorkerRequest
            handleRequest(request).then(
                (result) => framed.send({ type: 'response', requestId: request.requestId, ok: true, result } satisfies WorkerResponse),
                (error) => framed.send({ type: 'response', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse),
            )
        })
        socket.on('error', () => { /* the close handler does the bookkeeping */ })
        socket.on('close', () => {
            clearTimeout(helloTimer)
            if (controller !== framed) return
            controller = null
            controllerlessSince = Date.now()
            exitIfIdle()
        })
    }

    return { socketPath, record, shutdown }
}

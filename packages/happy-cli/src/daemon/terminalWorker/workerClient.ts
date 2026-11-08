/**
 * The daemon's side of the terminal worker socket (specs/terminal-survive-runner-restart §2.1·2.2):
 * launching a worker, connecting to one named by a record, and talking the frozen envelope.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { resolveHappyCliSpawnCommand } from '@/utils/spawnHappyCLI'
import { sanitizeChildEnv } from '@/utils/childEnv'
import { attachFramedSocket } from './frames'
import { isRecord, TERMINAL_WORKER_PROTOCOL_VERSION, TERMINAL_WORKER_RECORD_ID_ENV, type WorkerEvent, type WorkerHelloAck } from './protocol'
import { newTerminalWorkerRecordId, readTerminalWorkerRecord, terminalWorkerLogPath, terminalWorkerRecordPath, type TerminalWorkerRecord } from './record'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000
export const WORKER_READY_TIMEOUT_MS = 15_000

export interface WorkerConnection {
    readonly record: TerminalWorkerRecord
    readonly ack: WorkerHelloAck
    request<T = unknown>(op: string, args?: unknown, timeoutMs?: number): Promise<T>
    /** Fire and forget, still in order with every other message (write·resize). */
    post(op: string, args?: unknown): void
    onEvent(listener: (event: WorkerEvent) => void): () => void
    onClose(listener: () => void): () => void
    isOpen(): boolean
    /** Drops the connection; the worker and its terminals keep running. */
    close(): void
}

export class WorkerConnectError extends Error {
    constructor(message: string, readonly code: 'refused' | 'timeout' | 'auth' | 'closed') {
        super(message)
        this.name = 'WorkerConnectError'
    }
}

/** Connects and authenticates. Taking a worker over drops whichever daemon held it before. */
export function connectTerminalWorker(record: TerminalWorkerRecord, options: { timeoutMs?: number; protocolVersion?: number } = {}): Promise<WorkerConnection> {
    return new Promise((resolve, reject) => {
        const socket = connect(record.socketPath)
        const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
        const eventListeners = new Set<(event: WorkerEvent) => void>()
        const closeListeners = new Set<() => void>()
        let ack: WorkerHelloAck | null = null
        let settled = false
        const fail = (error: WorkerConnectError) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.destroy()
            reject(error)
        }
        const timer = setTimeout(() => fail(new WorkerConnectError('terminal worker did not answer hello', 'timeout')), options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)

        const framed = attachFramedSocket(socket, (message) => {
            if (!isRecord(message)) return
            if (!ack) {
                if (message.type !== 'helloAck' || typeof message.pid !== 'number') return
                ack = { type: 'helloAck', pid: message.pid, protocolVersion: message.protocolVersion as number, cliVersion: String(message.cliVersion ?? '') }
                settled = true
                clearTimeout(timer)
                resolve(connection)
                return
            }
            if (message.type === 'response' && typeof message.requestId === 'string') {
                const waiter = pending.get(message.requestId)
                if (!waiter) return
                pending.delete(message.requestId)
                clearTimeout(waiter.timer)
                if (message.ok === true) waiter.resolve(message.result)
                else waiter.reject(new Error(typeof message.error === 'string' ? message.error : 'terminal worker request failed'))
                return
            }
            if (message.type === 'event') for (const listener of eventListeners) listener(message as unknown as WorkerEvent)
        })

        socket.on('connect', () => {
            framed.send({ type: 'hello', secret: record.secret, protocolVersion: options.protocolVersion ?? TERMINAL_WORKER_PROTOCOL_VERSION })
        })
        socket.on('error', (error: NodeJS.ErrnoException) => {
            fail(new WorkerConnectError(error.message, error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'refused' : 'closed'))
        })
        socket.on('close', () => {
            fail(new WorkerConnectError('terminal worker closed the connection', 'auth'))
            for (const [requestId, waiter] of pending) {
                clearTimeout(waiter.timer)
                waiter.reject(new Error('terminal worker connection closed'))
                pending.delete(requestId)
            }
            for (const listener of closeListeners) listener()
            closeListeners.clear()
        })

        const connection: WorkerConnection = {
            record,
            get ack() { return ack! },
            request(op, args, timeoutMs) {
                return new Promise((resolveRequest, rejectRequest) => {
                    const requestId = randomUUID()
                    const requestTimer = setTimeout(() => {
                        pending.delete(requestId)
                        rejectRequest(new Error(`terminal worker ${op} timed out`))
                    }, timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
                    pending.set(requestId, { resolve: resolveRequest as (value: unknown) => void, reject: rejectRequest, timer: requestTimer })
                    if (!framed.send({ type: 'request', requestId, op, args })) {
                        pending.delete(requestId)
                        clearTimeout(requestTimer)
                        rejectRequest(new Error('terminal worker connection closed'))
                    }
                })
            },
            post(op, args) {
                framed.send({ type: 'request', requestId: `post-${randomUUID()}`, op, args })
            },
            onEvent(listener) {
                eventListeners.add(listener)
                return () => eventListeners.delete(listener)
            },
            onClose(listener) {
                closeListeners.add(listener)
                return () => closeListeners.delete(listener)
            },
            isOpen: () => !socket.destroyed,
            close: () => { socket.destroy() },
        }
    })
}

/**
 * Whether something accepts connections on the socket — without saying hello, so the worker's
 * current controller is not taken over by a mere check (plan §2.2).
 */
export function probeWorkerSocket(socketPath: string, timeoutMs = 1_000): Promise<'accepting' | 'refused' | 'unknown'> {
    return new Promise((resolve) => {
        const socket = connect(socketPath)
        const done = (answer: 'accepting' | 'refused' | 'unknown') => {
            clearTimeout(timer)
            socket.destroy()
            resolve(answer)
        }
        const timer = setTimeout(() => done('unknown'), timeoutMs)
        socket.once('connect', () => done('accepting'))
        socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'refused' : 'unknown'))
    })
}

export interface LaunchTerminalWorkerOptions {
    happyHome: string
    /** Overrides how the worker is started (tests run it from source). */
    command?: (recordId: string) => { runtime: string; args: string[]; env?: NodeJS.ProcessEnv }
    readyTimeoutMs?: number
    env?: NodeJS.ProcessEnv
}

export interface LaunchedTerminalWorker {
    connection: WorkerConnection
    /** The launched process, already unref'd; its pid equals `connection.ack.pid`. */
    pid: number
}

/**
 * Starts a worker detached — its own session and process group, reparented to init when this
 * daemon exits — and connects to it. A worker that does not say `ready` in time is SIGKILLed:
 * it is the child just spawned, so its pid cannot have been reused yet.
 */
export async function launchTerminalWorker(options: LaunchTerminalWorkerOptions): Promise<LaunchedTerminalWorker> {
    const recordId = newTerminalWorkerRecordId()
    const command = options.command?.(recordId) ?? (() => {
        const resolved = resolveHappyCliSpawnCommand(['terminal-worker', '--record-id', recordId])
        return {
            runtime: resolved.runtime,
            args: resolved.args,
            env: resolved.tsconfigPath ? { TSX_TSCONFIG_PATH: resolved.tsconfigPath } : undefined,
        }
    })()
    const logPath = terminalWorkerLogPath(options.happyHome)
    let logFd: number | 'ignore' = 'ignore'
    try {
        mkdirSync(dirname(logPath), { recursive: true })
        logFd = openSync(logPath, 'a', 0o600)
    } catch {
        logFd = 'ignore'
    }
    let child: ChildProcess
    try {
        child = spawn(command.runtime, command.args, {
            detached: true,
            // Not inside any project: the worker must not look like a project process (Desktop process list).
            cwd: homedir(),
            stdio: ['ignore', 'pipe', logFd],
            windowsHide: true,
            env: {
                ...sanitizeChildEnv(options.env ?? process.env),
                ...command.env,
                [TERMINAL_WORKER_RECORD_ID_ENV]: recordId,
            },
        })
    } finally {
        if (typeof logFd === 'number') closeSync(logFd)
    }

    const ready = await new Promise<boolean>((resolve) => {
        let buffered = ''
        const timer = setTimeout(() => resolve(false), options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS)
        child.stdout?.on('data', (chunk: Buffer) => {
            buffered += chunk.toString('utf8')
            if (buffered.includes('\n')) {
                clearTimeout(timer)
                resolve(buffered.startsWith('ready '))
            }
        })
        child.once('exit', () => {
            clearTimeout(timer)
            resolve(false)
        })
        child.once('error', () => {
            clearTimeout(timer)
            resolve(false)
        })
    })
    child.stdout?.destroy()
    if (!ready) {
        try { child.kill('SIGKILL') } catch {/* already gone */}
        throw new Error('terminal worker did not become ready')
    }
    child.unref()
    const record = readTerminalWorkerRecord(terminalWorkerRecordPath(options.happyHome, recordId))
    const connection = await connectTerminalWorker(record)
    return { connection, pid: child.pid! }
}

/**
 * A `PtySession` whose PTY lives in a terminal worker (specs/terminal-survive-runner-restart §2.4).
 * The callers that hold a `PtySession` keep working unchanged; the two things a worker terminal
 * adds are its worker-assigned output seq (`onOutput`) and `detach()`, which lets go of it for a
 * daemon restart without ending it.
 */
import type { PtySession, TerminateOpts, TerminateOutcome } from '../remoteTerminal'
import type { WorkerConnection } from './workerClient'
import type { WorkerTerminalMeta } from './protocol'

export interface WorkerPtySession extends PtySession {
    readonly survives: true
    /** Output with the seq the worker gave it — the seq the daemon's replay buffer must use. */
    onOutput(cb: (seq: number, chunk: string) => void): () => void
    setMeta(meta: WorkerTerminalMeta): Promise<void>
    /** Stops forwarding and leaves the PTY running in the worker. Its exit is never reported here. */
    detach(): void
    /** Tells the worker an ended terminal is no longer needed. */
    forget(): void
    readonly connection: WorkerConnection
}

export function isWorkerPtySession(session: PtySession): session is WorkerPtySession {
    return (session as Partial<WorkerPtySession>).survives === true
}

export function createWorkerPtySession(input: {
    connection: WorkerConnection
    id: string
    userId: string
    pid: number
    cols: number
    rows: number
    /** An adopted terminal that had already ended. */
    exit?: { code: number; signal: number | null } | null
}): WorkerPtySession {
    const { connection, id } = input
    let cols = input.cols
    let rows = input.rows
    let exit = input.exit ?? null
    let detached = false
    const dataListeners = new Set<(chunk: string) => void>()
    const outputListeners = new Set<(seq: number, chunk: string) => void>()
    const exitListeners = new Set<(code: number, signal: number | null) => void>()

    const reportExit = (code: number, signal: number | null) => {
        if (exit !== null) return
        exit = { code, signal }
        const listeners = [...exitListeners]
        exitListeners.clear()
        for (const listener of listeners) listener(code, signal)
    }

    const offEvent = connection.onEvent((event) => {
        if (detached || event.id !== id) return
        if (event.event === 'output') {
            for (const listener of outputListeners) listener(event.seq, event.data)
            for (const listener of dataListeners) listener(event.data)
        } else if (event.event === 'exit') {
            reportExit(event.code, event.signal)
        }
    })
    // A worker that went away took its PTYs with it (the master side closed: the shell got SIGHUP).
    const offClose = connection.onClose(() => {
        if (!detached && exit === null) reportExit(0, 1)
    })

    const pidAlive = () => {
        try {
            process.kill(input.pid, 0)
            return true
        } catch {
            return false
        }
    }

    return {
        id,
        userId: input.userId,
        pid: input.pid,
        survives: true,
        connection,
        get cols() { return cols },
        get rows() { return rows },
        write(data) {
            if (exit === null) connection.post('write', { id, data })
        },
        resize(c, r) {
            cols = c
            rows = r
            if (exit === null) connection.post('resize', { id, cols: c, rows: r })
        },
        kill(signal: NodeJS.Signals = 'SIGHUP') {
            if (exit === null) connection.post('signal', { id, signal })
        },
        isAlive: () => exit === null && connection.isOpen(),
        async terminate(opts?: TerminateOpts): Promise<TerminateOutcome> {
            if (exit !== null) return 'already-gone'
            if (!connection.isOpen()) return pidAlive() ? 'escaped' : 'already-gone'
            try {
                const window = (opts?.graceMs ?? 2_000) + (opts?.killGraceMs ?? 1_000) + 5_000
                const result = await connection.request<{ outcome: TerminateOutcome }>('terminate', { id, graceMs: opts?.graceMs }, window)
                return result.outcome
            } catch {
                return pidAlive() ? 'escaped' : 'already-gone'
            }
        },
        onData(cb) {
            dataListeners.add(cb)
            return () => dataListeners.delete(cb)
        },
        onOutput(cb) {
            outputListeners.add(cb)
            return () => outputListeners.delete(cb)
        },
        onExit(cb) {
            if (exit !== null) {
                const ended = exit
                queueMicrotask(() => cb(ended.code, ended.signal))
                return () => {}
            }
            exitListeners.add(cb)
            return () => exitListeners.delete(cb)
        },
        async setMeta(meta) {
            if (!connection.isOpen()) return
            await connection.request('setMeta', { id, meta })
        },
        detach() {
            detached = true
            offEvent()
            offClose()
        },
        forget() {
            if (connection.isOpen()) connection.request('forget', { id }).catch(() => {})
        },
    }
}

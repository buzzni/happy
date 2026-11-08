/**
 * A `PtySession` whose PTY lives in a terminal worker (specs/terminal-survive-runner-restart §2.4).
 * The callers that hold a `PtySession` keep working unchanged; the two things a worker terminal
 * adds are its worker-assigned output seq (`onOutput`) and `detach()`, which lets go of it for a
 * daemon restart without ending it.
 *
 * A session listens before the request that names its terminal goes out (`create`, `dump`) and
 * holds output until someone reads it: a reply and the first output can arrive in one socket read,
 * and output that nobody was listening for yet would be gone for good.
 */
import type { PtySession, TerminateOpts, TerminateOutcome } from '../remoteTerminal'
import type { WorkerConnection } from './workerClient'
import type { WorkerTerminalMeta } from './protocol'

export interface WorkerPtySession extends PtySession {
    readonly survives: true
    /** Output with the seq the worker gave it — the seq the daemon's replay buffer must use. */
    onOutput(cb: (seq: number, chunk: string) => void): () => void
    setMeta(meta: WorkerTerminalMeta): Promise<void>
    /** Output the daemon made (a banner), numbered by the worker in line with the shell's. */
    inject(data: string): void
    /** Stops forwarding and leaves the PTY running in the worker. Its exit is never reported here. */
    detach(): void
    /** Tells the worker an ended terminal is no longer needed. */
    forget(): void
    /** Fills in what the worker answered about the terminal (`create` or `dump`). */
    settle(facts: { pid: number; userId?: string; cols?: number; rows?: number; exit?: { code: number; signal: number | null } | null }): void
    readonly connection: WorkerConnection
}

export function isWorkerPtySession(session: PtySession): session is WorkerPtySession {
    return (session as Partial<WorkerPtySession>).survives === true
}

export function createWorkerPtySession(input: {
    connection: WorkerConnection
    id: string
    userId: string
    /** 0 until `settle` says otherwise. */
    pid?: number
    cols?: number
    rows?: number
}): WorkerPtySession {
    const { connection, id } = input
    let pid = input.pid ?? 0
    let userId = input.userId
    let cols = input.cols ?? 80
    let rows = input.rows ?? 24
    let exit: { code: number; signal: number | null } | null = null
    let detached = false
    let held: Array<[number, string]> | null = []
    const dataListeners = new Set<(chunk: string) => void>()
    const outputListeners = new Set<(seq: number, chunk: string) => void>()
    const exitListeners = new Set<(code: number, signal: number | null) => void>()

    const deliver = (seq: number, data: string) => {
        for (const listener of outputListeners) listener(seq, data)
        for (const listener of dataListeners) listener(data)
    }
    /** Output held until the first reader, then handed to it in order. */
    const release = () => {
        const pending = held
        held = null
        for (const [seq, data] of pending ?? []) deliver(seq, data)
    }

    let offEvent = () => {}
    let offClose = () => {}
    const stopListening = () => {
        offEvent()
        offClose()
    }

    const reportExit = (code: number, signal: number | null) => {
        if (exit !== null) return
        exit = { code, signal }
        // Nothing more can come for an ended terminal: let go of the connection's listener sets.
        stopListening()
        const listeners = [...exitListeners]
        exitListeners.clear()
        for (const listener of listeners) listener(code, signal)
    }

    offEvent = connection.onEvent((event) => {
        if (detached || event.id !== id) return
        if (event.event === 'output') {
            if (held) held.push([event.seq, event.data])
            else deliver(event.seq, event.data)
        } else if (event.event === 'exit') {
            reportExit(event.code, event.signal)
        }
    })
    // A worker that went away took its PTYs with it (the master side closed: the shell got SIGHUP).
    offClose = connection.onClose(() => {
        if (!detached && exit === null) reportExit(0, 1)
    })

    const pidAlive = () => {
        if (!(pid > 0)) return false
        try {
            process.kill(pid, 0)
            return true
        } catch {
            return false
        }
    }

    return {
        id,
        get userId() { return userId },
        get pid() { return pid },
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
            release()
            return () => dataListeners.delete(cb)
        },
        onOutput(cb) {
            outputListeners.add(cb)
            release()
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
        inject(data) {
            if (exit === null) connection.post('inject', { id, data })
        },
        async setMeta(meta) {
            if (!connection.isOpen()) return
            await connection.request('setMeta', { id, meta })
        },
        detach() {
            detached = true
            stopListening()
        },
        forget() {
            stopListening()
            if (connection.isOpen()) connection.request('forget', { id }).catch(() => {})
        },
        settle(facts) {
            pid = facts.pid
            if (facts.userId !== undefined) userId = facts.userId
            if (facts.cols !== undefined) cols = facts.cols
            if (facts.rows !== undefined) rows = facts.rows
            if (facts.exit) reportExit(facts.exit.code, facts.exit.signal)
        },
    }
}

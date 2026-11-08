/**
 * The daemon's terminal workers (specs/terminal-survive-runner-restart §2.1·2.5·2.6·2.8): the one
 * new terminals open on, the adopted ones that only finish what they hold, what to do with all of
 * them when this daemon goes, and the numbers `daemonState.terminalSurvival` reports.
 */
import { randomUUID } from 'node:crypto'
import { adoptTerminalWorkers, defaultAdoptionDeps, type AdoptionDeps, type AdoptionSummary } from './adoption'
import type { WorkerDumpResult, WorkerListResult, WorkerTerminalMeta } from './protocol'
import { launchTerminalWorker, type LaunchedTerminalWorker, type WorkerConnection } from './workerClient'
import { createWorkerPtySession, type WorkerPtySession } from './workerPtySession'

/** What `daemonState.terminalSurvival` carries (spec HR4·HR10). Counts only — no pid, path or secret. */
export interface TerminalSurvivalState {
    version: 1
    workers: { current: number; draining: number }
    workerVersion?: string
    lastAdoption?: AdoptionSummary
}

export interface AdoptedWorkerTerminal {
    session: WorkerPtySession
    dump: WorkerDumpResult
}

export interface WorkerSessionArgs {
    userId: string
    shell?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
    meta: WorkerTerminalMeta
}

export interface TerminalWorkerHostOptions {
    happyHome: string
    cliVersion: string
    enabled: boolean
    log: (message: string) => void
    launch?: (happyHome: string) => Promise<LaunchedTerminalWorker>
    adoptionDeps?: Partial<AdoptionDeps>
}

interface HeldWorker {
    connection: WorkerConnection
    draining: boolean
    sessions: Set<WorkerPtySession>
}

export class TerminalWorkerHost {
    readonly enabled: boolean
    private readonly options: TerminalWorkerHostOptions
    private readonly workers = new Set<HeldWorker>()
    private current: HeldWorker | null = null
    private launching: Promise<HeldWorker | null> | null = null
    private lastAdoption: AdoptionSummary | null = null
    private readable = true
    private keeping = false
    private stopped = false

    constructor(options: TerminalWorkerHostOptions) {
        this.options = options
        this.enabled = options.enabled
    }

    /**
     * Adopts the workers an earlier daemon left behind and hands back their terminals, or — when
     * workers are off — closes them (spec HR11). Cheap when no worker ever ran: one readdir.
     */
    async start(): Promise<AdoptedWorkerTerminal[]> {
        const result = await adoptTerminalWorkers({
            happyHome: this.options.happyHome,
            cliVersion: this.options.cliVersion,
            workersEnabled: this.enabled,
            log: this.options.log,
            deps: defaultAdoptionDeps(this.options.happyHome, this.options.adoptionDeps),
        })
        this.readable = result.recordsReadable
        if (result.summary.adopted + result.summary.closed + result.summary.reaped + result.summary.failed > 0) {
            this.lastAdoption = result.summary
        }
        const terminals: AdoptedWorkerTerminal[] = []
        for (const adopted of result.adopted) {
            // HR8: one current worker of this CLI version; any other is only drained.
            const held = this.hold(adopted.connection, !(adopted.sameVersion && this.current === null))
            if (!held.draining) this.current = held
            let listed: WorkerListResult
            try {
                listed = await adopted.connection.request<WorkerListResult>('list')
            } catch (error) {
                this.options.log(`[TERMINAL-WORKER] list failed after adoption: ${(error as Error).message}`)
                continue
            }
            for (const entry of listed.terminals) {
                // Listening before the dump: output after the dumped seq is held for the route, not lost.
                const session = createWorkerPtySession({ connection: adopted.connection, id: entry.id, userId: '', pid: entry.pid })
                try {
                    const dump = await adopted.connection.request<WorkerDumpResult>('dump', { id: entry.id })
                    session.settle({ pid: dump.pid, userId: dump.meta.userId, cols: dump.cols, rows: dump.rows, exit: dump.exit })
                    terminals.push({ session: this.track(held, session), dump })
                } catch (error) {
                    session.detach()
                    this.options.log(`[TERMINAL-WORKER] dump ${entry.id} failed: ${(error as Error).message}`)
                }
            }
            this.retireIfDrained(held)
        }
        return terminals
    }

    /** Every record could be read at the last scan (spec HR3 `record-unreadable`). */
    recordsReadable(): boolean {
        return this.readable
    }

    /**
     * The worker new terminals open on, starting one if needed. Null when workers are off or one
     * could not be started — the caller then opens the terminal in the daemon (`worker-unavailable`).
     */
    async ensureWorker(): Promise<WorkerConnection | null> {
        if (!this.enabled || this.stopped) return null
        if (this.current?.connection.isOpen()) return this.current.connection
        this.launching ??= (async () => {
            try {
                const launched = await (this.options.launch ?? ((happyHome) => launchTerminalWorker({ happyHome })))(this.options.happyHome)
                const held = this.hold(launched.connection, false)
                this.current = held
                this.options.log(`[TERMINAL-WORKER] started pid=${launched.pid}`)
                return held
            } catch (error) {
                this.options.log(`[TERMINAL-WORKER] could not start a worker: ${(error as Error).message}`)
                return null
            } finally {
                this.launching = null
            }
        })()
        return (await this.launching)?.connection ?? null
    }

    /**
     * Opens a terminal on `connection` (from `ensureWorker`) under `args.id` (a new id when absent).
     * The create request leaves in this call's synchronous part. A create that failed or went
     * unanswered may still have started a shell; it is ended and forgotten rather than left running.
     */
    async createSession(connection: WorkerConnection, args: WorkerSessionArgs & { id?: string }): Promise<WorkerPtySession> {
        const held = [...this.workers].find((worker) => worker.connection === connection)
        if (!held || held.draining || this.stopped) throw new Error('terminal worker is not available')
        const id = args.id ?? randomUUID()
        // Listening before the create: its first output or exit can share a socket read with the reply.
        const session = createWorkerPtySession({ connection, id, userId: args.userId, cols: args.cols, rows: args.rows })
        try {
            const { pid } = await connection.request<{ pid: number }>('create', {
                id, shell: args.shell, args: args.args, cwd: args.cwd, env: args.env, cols: args.cols, rows: args.rows, meta: args.meta,
            })
            session.settle({ pid })
        } catch (error) {
            session.detach()
            connection.request('terminate', { id, graceMs: 500 }).catch(() => {})
                .finally(() => { connection.request('forget', { id }).catch(() => {}) })
            throw error
        }
        return this.track(held, session)
    }

    /** The decision of a ready drain (spec HR3): worker terminals are left running when this daemon goes. */
    setKeeping(keeping: boolean): void {
        this.keeping = keeping
    }

    isKeeping(): boolean {
        return this.keeping
    }

    /**
     * This daemon is going. Keeping: let go of every worker — their terminals carry on and the next
     * daemon adopts them. Otherwise: close every worker this daemon holds (frozen `shutdown`).
     */
    async stop(): Promise<void> {
        if (this.stopped) return
        this.stopped = true
        // A worker still starting is this daemon's too: it is handled below like the others.
        await this.launching?.catch(() => null)
        const workers = [...this.workers]
        if (this.keeping) {
            for (const worker of workers) worker.connection.close()
            this.options.log(`[TERMINAL-WORKER] left ${workers.length} worker(s) running for the next daemon`)
            return
        }
        await Promise.all(workers.map(async (worker) => {
            try {
                await worker.connection.request('shutdown')
            } catch {/* gone already */}
            worker.connection.close()
        }))
        if (workers.length > 0) this.options.log(`[TERMINAL-WORKER] closed ${workers.length} worker(s)`)
    }

    /** Null when workers are off: then nothing is advertised (spec HR4). */
    state(): TerminalSurvivalState | null {
        if (!this.enabled) return null
        const open = [...this.workers].filter((worker) => worker.connection.isOpen())
        const current = open.filter((worker) => !worker.draining)
        return {
            version: 1,
            workers: { current: current.length, draining: open.length - current.length },
            ...(current[0] ? { workerVersion: current[0].connection.ack.cliVersion } : {}),
            ...(this.lastAdoption ? { lastAdoption: { ...this.lastAdoption } } : {}),
        }
    }

    private hold(connection: WorkerConnection, draining: boolean): HeldWorker {
        const held: HeldWorker = { connection, draining, sessions: new Set() }
        this.workers.add(held)
        connection.onClose(() => {
            this.workers.delete(held)
            if (this.current === held) this.current = null
        })
        return held
    }

    private track(held: HeldWorker, session: WorkerPtySession): WorkerPtySession {
        held.sessions.add(session)
        session.onExit(() => {
            held.sessions.delete(session)
            this.retireIfDrained(held)
        })
        return session
    }

    /** HR8: a draining worker goes once it holds nothing alive. */
    private retireIfDrained(held: HeldWorker): void {
        if (!held.draining || this.stopped) return
        if ([...held.sessions].some((session) => session.isAlive())) return
        this.options.log('[TERMINAL-WORKER] draining worker has no terminal left; shutting it down')
        held.connection.request('shutdown').catch(() => {}).finally(() => held.connection.close())
    }
}

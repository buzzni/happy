/**
 * What a starting daemon does with the worker records it finds (specs/terminal-survive-runner-restart
 * HR2·HR6·HR8·HR11). The only signal it ever sends is a request over a socket the worker
 * authenticated with its secret — never a kill to a pid read from a file.
 *
 *   record unreadable                          → leave it, log the path; recordsReadable = false
 *   another boot                               → retire the record, no signal
 *   pid gone, or alive with another start time → retire the record, no signal (pid reuse)
 *   start time unverifiable (either side)      → leave everything
 *   socket does not answer / hello fails       → leave everything (next start retries)
 *   authenticated, other protocol              → frozen `shutdown`
 *   authenticated, our protocol, workers off   → frozen `shutdown` (off converges to no workers)
 *   authenticated, our protocol, workers on    → adopt (draining: new terminals open on this daemon's own worker)
 */
import { readCurrentBootIdSync } from '@/utils/bootIdentity'
import { getProcessStartedAt } from '@/utils/processStartTime'
import { classifyWorkerProtocol } from './protocol'
import { listTerminalWorkerRecords, retireTerminalWorkerRecord, type TerminalWorkerRecord } from './record'
import { connectTerminalWorker, type WorkerConnection } from './workerClient'

export interface AdoptionSummary {
    at: number
    adopted: number
    closed: number
    reaped: number
    failed: number
}

export interface AdoptedWorker {
    connection: WorkerConnection
}

export interface AdoptionDeps {
    currentBootId: () => string | undefined
    processStartedAt: (pid: number) => number | undefined
    isAlive: (pid: number) => boolean
    connect: (record: TerminalWorkerRecord) => Promise<WorkerConnection>
    retire: (record: TerminalWorkerRecord) => boolean
    now: () => number
}

export interface AdoptionResult {
    adopted: AdoptedWorker[]
    summary: AdoptionSummary
    recordsReadable: boolean
}

export function defaultAdoptionDeps(happyHome: string, overrides: Partial<AdoptionDeps> = {}): AdoptionDeps {
    return {
        currentBootId: () => readCurrentBootIdSync(),
        processStartedAt: (pid) => getProcessStartedAt(pid),
        isAlive: (pid) => {
            try {
                process.kill(pid, 0)
                return true
            } catch (error) {
                // EPERM: it exists, it is just not ours to signal.
                return (error as NodeJS.ErrnoException).code === 'EPERM'
            }
        },
        connect: (record) => connectTerminalWorker(record),
        retire: (record) => retireTerminalWorkerRecord(happyHome, record),
        now: Date.now,
        ...overrides,
    }
}

export async function adoptTerminalWorkers(input: {
    happyHome: string
    cliVersion: string
    workersEnabled: boolean
    log: (message: string) => void
    deps: AdoptionDeps
}): Promise<AdoptionResult> {
    const { deps, log } = input
    const summary: AdoptionSummary = { at: deps.now(), adopted: 0, closed: 0, reaped: 0, failed: 0 }
    const adopted: AdoptedWorker[] = []
    let recordsReadable = true
    const bootId = deps.currentBootId()

    for (const file of listTerminalWorkerRecords(input.happyHome)) {
        if ('error' in file) {
            recordsReadable = false
            summary.failed++
            log(`[TERMINAL-WORKER] unreadable record ${file.path}: ${file.error.message}`)
            continue
        }
        const record = file.record
        const tag = `record=${record.recordId} pid=${record.pid}`
        if (bootId && record.bootId && record.bootId !== bootId) {
            if (deps.retire(record)) summary.reaped++
            log(`[TERMINAL-WORKER] ${tag} from an earlier boot; record retired`)
            continue
        }
        if (!deps.isAlive(record.pid)) {
            if (deps.retire(record)) summary.reaped++
            log(`[TERMINAL-WORKER] ${tag} is gone; record retired`)
            continue
        }
        const observedStart = deps.processStartedAt(record.pid)
        if (record.startedAt === null || observedStart === undefined) {
            // HR6: the process cannot be told apart from another holding its pid — touch nothing.
            summary.failed++
            log(`[TERMINAL-WORKER] ${tag} start time cannot be verified; left alone`)
            continue
        }
        if (observedStart !== record.startedAt) {
            if (deps.retire(record)) summary.reaped++
            log(`[TERMINAL-WORKER] ${tag} now belongs to another process; record retired`)
            continue
        }

        let connection: WorkerConnection
        try {
            connection = await deps.connect(record)
        } catch (error) {
            // Alive (or unverifiable) and not answering: nothing here may signal it. Retried next start.
            summary.failed++
            log(`[TERMINAL-WORKER] ${tag} did not answer: ${error instanceof Error ? error.message : String(error)}`)
            continue
        }

        const fit = classifyWorkerProtocol(connection.ack.protocolVersion)
        if (fit !== 'current' || !input.workersEnabled) {
            const why = fit !== 'current' ? `protocol ${String(connection.ack.protocolVersion)}` : 'workers are off'
            try {
                await connection.request('shutdown')
                summary.closed++
                log(`[TERMINAL-WORKER] ${tag} shut down (${why})`)
            } catch (error) {
                summary.failed++
                log(`[TERMINAL-WORKER] ${tag} shutdown failed (${why}): ${error instanceof Error ? error.message : String(error)}`)
            }
            connection.close()
            continue
        }
        adopted.push({ connection })
        summary.adopted++
        log(`[TERMINAL-WORKER] ${tag} adopted (cli ${connection.ack.cliVersion})`)
    }
    return { adopted, summary, recordsReadable }
}

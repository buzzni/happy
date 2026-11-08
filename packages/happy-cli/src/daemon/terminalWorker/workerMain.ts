/**
 * `happy terminal-worker` (specs/terminal-survive-runner-restart HR1·HR5).
 *
 *   happy terminal-worker --record-id <id>     runs a worker; prints `ready <socket>` once listening
 *
 * Started detached by the daemon (workerLaunch.ts), never by hand.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { configuration } from '@/configuration'
import { TERMINAL_WORKER_RECORD_ID_ENV, workerProtocolVersion } from './protocol'
import { terminalWorkerLogPath } from './record'
import { startTerminalWorker } from './workerProcess'

const args = process.argv.slice(3)

const recordIdIndex = args.indexOf('--record-id')
const recordId = recordIdIndex >= 0 ? args[recordIdIndex + 1] : undefined
if (!recordId || !/^[A-Za-z0-9-]{8,64}$/.test(recordId)) {
    process.stderr.write('terminal-worker: --record-id <id> is required\n')
    process.exit(2)
}

// The marker stays in this process's own environment for `ps eww`; shells must not inherit it.
delete process.env[TERMINAL_WORKER_RECORD_ID_ENV]

const logPath = terminalWorkerLogPath(configuration.happyHomeDir)
const log = (message: string) => {
    try {
        mkdirSync(dirname(logPath), { recursive: true })
        appendFileSync(logPath, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`)
    } catch {/* logging never stops a terminal */}
}

// Detached with no terminal of its own: a hangup is not addressed to it.
process.on('SIGHUP', () => log('[TERMINAL-WORKER] SIGHUP ignored'))
process.on('uncaughtException', (error) => log(`[TERMINAL-WORKER] uncaught: ${error.stack ?? error.message}`))
// The daemon's pipe for the ready line is gone once it exits; nothing is written there again.
process.stdout.on('error', () => {})

startTerminalWorker({
    happyHome: configuration.happyHomeDir,
    recordId,
    cliVersion: configuration.currentCliVersion,
    protocolVersion: workerProtocolVersion(),
    log,
}).then((worker) => {
    // HR3: SIGTERM and SIGINT mean "close".
    process.on('SIGTERM', () => { void worker.shutdown('SIGTERM') })
    process.on('SIGINT', () => { void worker.shutdown('SIGINT') })
    process.stdout.write(`ready ${worker.socketPath}\n`)
}, (error) => {
    log(`[TERMINAL-WORKER] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})

/**
 * Does the installed bundle speak this daemon's worker protocol? (specs/terminal-survive-runner-restart
 * HR5) Asked before a restart keeps terminals: the daemon that starts next runs from the installed
 * files and adopts only workers of its own protocol. Anything but a clear yes is a no.
 */
import type { ChildProcess } from 'node:child_process'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { TERMINAL_WORKER_PROTOCOL_VERSION } from './protocol'

export function queryInstalledWorkerProtocol({
    spawn = spawnHappyCLI,
    timeoutMs = 15_000,
}: { spawn?: typeof spawnHappyCLI; timeoutMs?: number } = {}): Promise<boolean> {
    let child: ChildProcess
    try {
        child = spawn(['terminal-worker', '--protocol-version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
        return Promise.resolve(false)
    }
    return new Promise((resolve) => {
        let output = ''
        let settled = false
        const finish = (matches: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(matches)
        }
        const timer = setTimeout(() => {
            child.kill()
            finish(false)
        }, timeoutMs)
        child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
        child.once('error', () => finish(false))
        child.once('exit', (code) => finish(code === 0 && output.trim() === String(TERMINAL_WORKER_PROTOCOL_VERSION)))
    })
}

/**
 * Real processes (spec HR9): the built `happy terminal-worker`, launched detached the way the
 * daemon launches it. Needs `pnpm build` first (the vitest global setup runs it).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveHappyCliSpawnCommand } from '@/utils/spawnHappyCLI'
import { TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV, type WorkerListResult } from './protocol'
import { listTerminalWorkerRecords } from './record'
import { connectTerminalWorker, launchTerminalWorker, type WorkerConnection } from './workerClient'

const posix = process.platform !== 'win32'
const meta = { userId: 'u1', route: 'direct', machineId: null, openedAt: 1 }

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
}
function pgidOf(pid: number): number {
    return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
}
async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
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

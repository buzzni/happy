import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptTerminalWorkers, type AdoptionDeps } from './adoption'
import { listTerminalWorkerRecords, terminalWorkerDirectory, writeTerminalWorkerRecord, type TerminalWorkerRecord } from './record'
import type { WorkerConnection } from './workerClient'

/** spec HR6: the reaper only ever signals through an authenticated socket — the fake records every way it could. */
describe('adoptTerminalWorkers', () => {
    let home: string
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tw-adopt-')) })
    afterEach(() => { rmSync(home, { recursive: true, force: true }) })

    let counter = 0
    const record = (overrides: Partial<TerminalWorkerRecord> = {}): TerminalWorkerRecord => {
        counter++
        const value: TerminalWorkerRecord = {
            recordId: `0000000${counter}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, pid: 1000 + counter, startedAt: 5_000, bootId: 'boot-now',
            socketPath: join(home, `s${counter}.sock`), secret: 's', protocolVersion: 1, cliVersion: '2.0.0', createdAt: 1, ...overrides,
        }
        writeTerminalWorkerRecord(home, value)
        return value
    }
    const connection = (ack: Partial<WorkerConnection['ack']> = {}) => {
        const request = vi.fn(async () => ({}))
        const close = vi.fn()
        const value = { ack: { type: 'helloAck', pid: 1, protocolVersion: 1, cliVersion: '2.0.0', ...ack }, request, close } as unknown as WorkerConnection
        return { value, request, close }
    }
    const deps = (overrides: Partial<AdoptionDeps> = {}): AdoptionDeps & { connect: ReturnType<typeof vi.fn> } => ({
        currentBootId: () => 'boot-now',
        processStartedAt: () => 5_000,
        isAlive: () => true,
        connect: vi.fn(async () => connection().value),
        retire: (value) => { rmSync(join(terminalWorkerDirectory(home), `${value.recordId}.json`)); return true },
        now: () => 42,
        ...overrides,
    }) as AdoptionDeps & { connect: ReturnType<typeof vi.fn> }
    const run = (d: AdoptionDeps, workersEnabled = true) =>
        adoptTerminalWorkers({ happyHome: home, cliVersion: '2.0.0', workersEnabled, log: () => {}, deps: d })

    it('retires records of an earlier boot, a dead pid or a reused pid without connecting to anything', async () => {
        record({ bootId: 'boot-before' })
        const dead = record()
        const reused = record({ startedAt: 1 })
        const d = deps({ isAlive: (pid) => pid !== dead.pid, processStartedAt: (pid) => pid === reused.pid ? 9_999 : 5_000 })
        const result = await run(d)
        expect(d.connect).not.toHaveBeenCalled()
        expect(result.summary).toEqual({ at: 42, adopted: 0, closed: 0, reaped: 3, failed: 0 })
        expect(listTerminalWorkerRecords(home)).toEqual([])
    })

    it('leaves a live worker that does not answer alone, record and all', async () => {
        record()
        const d = deps({ connect: vi.fn(async () => { throw new Error('ECONNREFUSED') }) })
        const result = await run(d)
        expect(result.summary).toMatchObject({ failed: 1, reaped: 0 })
        expect(listTerminalWorkerRecords(home)).toHaveLength(1)
    })

    it('still asks the socket when the start time cannot be read — the secret proves who it is', async () => {
        record()
        const d = deps({ processStartedAt: () => undefined })
        expect((await run(d)).summary.adopted).toBe(1)
    })

    it('reports an unreadable record and does not touch it', async () => {
        mkdirSync(terminalWorkerDirectory(home), { recursive: true })
        writeFileSync(join(terminalWorkerDirectory(home), 'broken.json'), '{')
        const result = await run(deps())
        expect(result).toMatchObject({ recordsReadable: false, summary: { failed: 1 } })
        expect(listTerminalWorkerRecords(home)).toHaveLength(1)
    })

    it('shuts down a worker of another protocol through the frozen envelope', async () => {
        record()
        const other = connection({ protocolVersion: 2 })
        const result = await run(deps({ connect: vi.fn(async () => other.value) }))
        expect(other.request).toHaveBeenCalledWith('shutdown')
        expect(result.summary).toMatchObject({ closed: 1, adopted: 0 })
        expect(result.adopted).toEqual([])
    })

    it('with workers off, shuts down even a worker it could adopt (HR11)', async () => {
        record()
        const same = connection()
        const result = await run(deps({ connect: vi.fn(async () => same.value) }), false)
        expect(same.request).toHaveBeenCalledWith('shutdown')
        expect(result.summary).toMatchObject({ closed: 1, adopted: 0 })
    })

    it('adopts workers of its protocol, telling a same-version one from an older one (HR8)', async () => {
        record()
        record()
        const same = connection()
        const older = connection({ cliVersion: '1.9.0' })
        const result = await run(deps({ connect: vi.fn().mockResolvedValueOnce(same.value).mockResolvedValueOnce(older.value) }))
        expect(result.adopted.map((entry) => entry.sameVersion)).toEqual([true, false])
        expect(result.summary).toMatchObject({ adopted: 2 })
        expect(same.request).not.toHaveBeenCalled()
    })
})

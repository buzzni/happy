import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeWorkerConnection } from './fakeWorkerConnection.testing'
import { writeTerminalWorkerRecord } from './record'
import { TerminalWorkerHost } from './workerHost'

const meta = { userId: 'u', route: 'direct' as const, machineId: null, openedAt: 1 }

describe('TerminalWorkerHost', () => {
    let home: string
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tw-host-')) })
    afterEach(() => { rmSync(home, { recursive: true, force: true }) })

    const host = (fake: ReturnType<typeof fakeWorkerConnection>, launchDelay?: Promise<void>) => new TerminalWorkerHost({
        happyHome: home, enabled: true, log: () => {},
        launch: async () => { await launchDelay; return { connection: fake.connection, pid: 7 } },
    })

    it('catches output and exit that share a read with the create reply', async () => {
        let fake!: ReturnType<typeof fakeWorkerConnection>
        fake = fakeWorkerConnection((op, args) => {
            if (op !== 'create') return {}
            const id = (args as { id: string }).id
            // The worker answered and the shell already printed and ended before the reply was read.
            fake.emit({ type: 'event', event: 'output', id, seq: 1, data: 'hi' })
            fake.emit({ type: 'event', event: 'exit', id, code: 0, signal: null })
            return { pid: 9 }
        })
        const h = host(fake)
        const connection = (await h.ensureWorker())!
        const session = await h.createSession(connection, { userId: 'u', meta })
        const output: string[] = []
        session.onOutput((_seq, data) => output.push(data))
        const exit = await new Promise((resolve) => session.onExit((code) => resolve(code)))
        expect(output).toEqual(['hi'])
        expect(exit).toBe(0)
        expect(session.pid).toBe(9)
    })

    it('ends and forgets a terminal whose create failed or went unanswered', async () => {
        const fake = fakeWorkerConnection((op) => { if (op === 'create') throw new Error('timed out'); return {} })
        const h = host(fake)
        const connection = (await h.ensureWorker())!
        await expect(h.createSession(connection, { userId: 'u', meta, id: 'gone' })).rejects.toThrow('timed out')
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(fake.connection.request.mock.calls.map(([op, args]) => [op, (args as { id?: string } | undefined)?.id])).toEqual([
            ['create', 'gone'], ['terminate', 'gone'], ['forget', 'gone'],
        ])
    })

    it('a worker still starting when the daemon stops is shut down too', async () => {
        const fake = fakeWorkerConnection()
        let started!: () => void
        const h = host(fake, new Promise<void>((resolve) => { started = resolve }))
        const ensuring = h.ensureWorker()
        const stopping = h.stop()
        started()
        await ensuring
        await stopping
        expect(fake.connection.request).toHaveBeenCalledWith('shutdown')
        expect(await h.ensureWorker()).toBeNull()
    })

    it('a same-version worker adopted from an earlier daemon keeps its terminals but never takes new ones', async () => {
        // Its shells would get the earlier daemon's environment, e.g. across an env-reapply restart.
        writeTerminalWorkerRecord(home, {
            recordId: '00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pid: 1001, startedAt: 5, bootId: 'boot',
            socketPath: join(home, 'w.sock'), secret: 's', protocolVersion: 1, cliVersion: '1', createdAt: 1,
        })
        const adopted = fakeWorkerConnection((op) => {
            if (op === 'list') return { terminals: [{ id: 't1', pid: 5, exited: false }] }
            if (op === 'dump') return { id: 't1', pid: 5, cols: 80, rows: 24, meta, frames: [], lastSeq: 0, exit: null }
            return {}
        })
        const launched = fakeWorkerConnection()
        const h = new TerminalWorkerHost({
            happyHome: home, enabled: true, log: () => {},
            launch: async () => ({ connection: launched.connection, pid: 7 }),
            adoptionDeps: { currentBootId: () => 'boot', processStartedAt: () => 5, isAlive: () => true, connect: async () => adopted.connection },
        })
        expect((await h.start()).map((terminal) => terminal.dump.id)).toEqual(['t1'])
        expect(h.state()?.workers).toEqual({ current: 0, draining: 1 })
        expect(await h.ensureWorker()).toBe(launched.connection)
        await expect(h.createSession(adopted.connection, { userId: 'u', meta })).rejects.toThrow('not available')
    })

    it('a keeping stop lets go of its workers without shutting them down', async () => {
        const fake = fakeWorkerConnection()
        const h = host(fake)
        await h.ensureWorker()
        h.setKeeping(true)
        await h.stop()
        expect(fake.connection.request).not.toHaveBeenCalledWith('shutdown')
        expect(fake.connection.close).toHaveBeenCalled()
    })
})

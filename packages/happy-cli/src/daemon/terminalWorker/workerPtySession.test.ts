import { describe, expect, it } from 'vitest'
import { fakeWorkerConnection } from './fakeWorkerConnection.testing'
import { createWorkerPtySession } from './workerPtySession'

describe('createWorkerPtySession', () => {
    it('holds output that arrives before anyone reads it and hands it over in order', () => {
        const fake = fakeWorkerConnection()
        const session = createWorkerPtySession({ connection: fake.connection, id: 't1', userId: 'u' })
        fake.emit({ type: 'event', event: 'output', id: 't1', seq: 1, data: 'a' })
        fake.emit({ type: 'event', event: 'output', id: 'other', seq: 1, data: 'x' })
        fake.emit({ type: 'event', event: 'output', id: 't1', seq: 2, data: 'b' })
        const seen: Array<[number, string]> = []
        session.onOutput((seq, data) => seen.push([seq, data]))
        fake.emit({ type: 'event', event: 'output', id: 't1', seq: 3, data: 'c' })
        expect(seen).toEqual([[1, 'a'], [2, 'b'], [3, 'c']])
    })

    it('reports an exit that came before its listener, and then lets go of the connection', async () => {
        const fake = fakeWorkerConnection()
        const session = createWorkerPtySession({ connection: fake.connection, id: 't1', userId: 'u' })
        expect(fake.listenerCount()).toBe(2)
        fake.emit({ type: 'event', event: 'exit', id: 't1', code: 3, signal: null })
        expect(fake.listenerCount()).toBe(0)
        const exit = await new Promise((resolve) => session.onExit((code, signal) => resolve([code, signal])))
        expect(exit).toEqual([3, null])
        expect(session.isAlive()).toBe(false)
    })

    it('a worker that went away ends the terminal; a detached one is not reported', () => {
        const ended = fakeWorkerConnection()
        const a = createWorkerPtySession({ connection: ended.connection, id: 't1', userId: 'u' })
        const exits: number[] = []
        a.onExit((code) => exits.push(code))
        ended.connection.close()
        expect(exits).toEqual([0])

        const kept = fakeWorkerConnection()
        const b = createWorkerPtySession({ connection: kept.connection, id: 't1', userId: 'u' })
        b.onExit(() => exits.push(99))
        b.detach()
        kept.connection.close()
        expect(exits).toEqual([0])
    })

    it('settles identity from the worker\'s answer', () => {
        const fake = fakeWorkerConnection()
        const session = createWorkerPtySession({ connection: fake.connection, id: 't1', userId: '' })
        session.settle({ pid: 42, userId: 'u1', cols: 100, rows: 30 })
        expect([session.pid, session.userId, session.cols, session.rows]).toEqual([42, 'u1', 100, 30])
    })
})

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    listTerminalWorkerRecords,
    retireTerminalWorkerRecord,
    terminalWorkerDirectory,
    terminalWorkerRecordPath,
    writeTerminalWorkerRecord,
    type TerminalWorkerRecord,
} from './record'

const posix = process.platform !== 'win32'

describe('terminal worker records', () => {
    let home: string
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tw-record-')) })
    afterEach(() => { rmSync(home, { recursive: true, force: true }) })

    const record = (overrides: Partial<TerminalWorkerRecord> = {}): TerminalWorkerRecord => ({
        recordId: '11111111-2222-3333-4444-555555555555',
        pid: 4242,
        startedAt: 1_700_000_000_000,
        bootId: 'boot-a',
        socketPath: join(home, 'tw.sock'),
        secret: 'secret',
        protocolVersion: 1,
        cliVersion: '1.0.0',
        createdAt: 1,
        ...overrides,
    })

    it.runIf(posix)('writes owner-only, in an owner-only directory, and reads it back', () => {
        const path = writeTerminalWorkerRecord(home, record())
        expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(statSync(terminalWorkerDirectory(home)).mode & 0o777).toBe(0o700)
        expect(listTerminalWorkerRecords(home)).toEqual([{ path, record: record() }])
    })

    it('lists an unreadable record with its error instead of dropping it', () => {
        writeTerminalWorkerRecord(home, record())
        const broken = join(terminalWorkerDirectory(home), 'broken.json')
        writeFileSync(broken, '{')
        const files = listTerminalWorkerRecords(home)
        expect(files).toHaveLength(2)
        expect(files.find((file) => file.path === broken)).toMatchObject({ error: expect.any(Error) })
    })

    it('keeps a newer protocol version readable', () => {
        writeTerminalWorkerRecord(home, record({ protocolVersion: 'v9' }))
        expect(listTerminalWorkerRecords(home)[0]).toMatchObject({ record: { protocolVersion: 'v9' } })
    })

    it('returns nothing when no worker ever ran', () => {
        expect(listTerminalWorkerRecords(home)).toEqual([])
    })

    it('retires the record and its socket, but not a file that now names another worker', () => {
        const mine = record()
        writeTerminalWorkerRecord(home, mine)
        writeFileSync(mine.socketPath, '')
        expect(retireTerminalWorkerRecord(home, mine)).toBe(true)
        expect(listTerminalWorkerRecords(home)).toEqual([])

        writeTerminalWorkerRecord(home, mine)
        const other = { ...mine, pid: 1 }
        // Same file name, rewritten by another worker: the content is the other worker's now.
        writeFileSync(terminalWorkerRecordPath(home, mine.recordId), JSON.stringify({ ...other, recordId: 'aaaaaaaa-0000-0000-0000-000000000000' }))
        expect(retireTerminalWorkerRecord(home, mine)).toBe(false)
    })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import packageJson from '../../../package.json'
import { INSTALLED_PROTOCOL_FIELD, installedWorkerProtocolMatches } from './installedProtocol'
import { TERMINAL_WORKER_PROTOCOL_VERSION } from './protocol'

describe('installedWorkerProtocolMatches (spec HR5)', () => {
    let root: string
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tw-installed-')) })
    afterEach(() => { rmSync(root, { recursive: true, force: true }) })

    it('ships the protocol this build speaks in its own package.json', () => {
        expect((packageJson as Record<string, unknown>)[INSTALLED_PROTOCOL_FIELD]).toBe(TERMINAL_WORKER_PROTOCOL_VERSION)
        expect(installedWorkerProtocolMatches()).toBe(true)
    })

    it('says no for another protocol, a bundle from before workers, or nothing readable', () => {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ [INSTALLED_PROTOCOL_FIELD]: TERMINAL_WORKER_PROTOCOL_VERSION + 1 }))
        expect(installedWorkerProtocolMatches(root)).toBe(false)
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
        expect(installedWorkerProtocolMatches(root)).toBe(false)
        writeFileSync(join(root, 'package.json'), '{')
        expect(installedWorkerProtocolMatches(root)).toBe(false)
        expect(installedWorkerProtocolMatches(join(root, 'missing'))).toBe(false)
    })
})

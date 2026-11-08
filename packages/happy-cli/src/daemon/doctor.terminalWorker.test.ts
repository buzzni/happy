import { describe, expect, it, vi } from 'vitest'

const processes = vi.hoisted(() => [] as Array<{ pid: number; name: string; cmd: string }>)
vi.mock('ps-list', () => ({ default: async () => processes }))

import { findAllHappyProcesses, findRunawayHappyProcesses } from './doctor'

describe('doctor and terminal workers (aplus terminal-survive-runner-restart HR10)', () => {
    it('lists a terminal worker as its own kind and never as a runaway to kill', async () => {
        processes.splice(0, processes.length,
            { pid: 101, name: 'node', cmd: 'node --no-warnings /x/happy-cli/dist/index.mjs terminal-worker --record-id 0123abcd-0000' },
            { pid: 102, name: 'node', cmd: 'node /x/happy-cli/dist/index.mjs daemon start-sync' },
        )
        expect(await findAllHappyProcesses()).toEqual(expect.arrayContaining([
            expect.objectContaining({ pid: 101, type: 'terminal-worker' }),
            expect.objectContaining({ pid: 102, type: 'daemon' }),
        ]))
        expect((await findRunawayHappyProcesses()).map((entry) => entry.pid)).toEqual([102])
    })
})

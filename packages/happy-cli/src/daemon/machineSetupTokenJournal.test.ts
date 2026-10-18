import { mkdtemp, chmod, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMachineSetupTokenJournal } from './machineSetupTokenJournal'
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function setup() { const home = await mkdtemp(join(tmpdir(), 'rotation-journal-')); homes.push(home); await chmod(home, 0o700); return { home, journal: createMachineSetupTokenJournal(home) } }
describe('durable machine-v2 operation intent', () => {
  it('reopens an acknowledged secret-free pending operation after process replacement', async () => {
    const { home, journal } = await setup()
    const record = { version: 1 as const, launchId: 'launch' }
    await journal.write(record)
    expect(await createMachineSetupTokenJournal(home).read('launch')).toEqual(record)
    const names = await readdir(join(home, 'machine-rotation'))
    expect(names).toHaveLength(1); expect(await readFile(join(home, 'machine-rotation', names[0]), 'utf8')).toBe(JSON.stringify(record))
    await expect(journal.write({ ...record, token: 'forbidden' } as never)).rejects.toThrow()
    await expect(journal.write({ ...record, current: '{"version":2,"bearer":"forbidden"}' })).rejects.toThrow()
    expect(await journal.read('launch')).toEqual(record)
  })
  it('rejects a symlink journal directory rather than publishing recovery authority outside its home', async () => {
    const { home, journal } = await setup(), target = await setup()
    await symlink(target.home, join(home, 'machine-rotation'))
    await expect(journal.write({ version: 1, launchId: 'launch' })).rejects.toThrow()
    expect(await readdir(target.home)).toEqual([])
  })
})

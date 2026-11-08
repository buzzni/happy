import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSetupTokenCapacityFence } from './setupTokenCapacityFence'
it('persists a strict admission fence before acknowledging runtime exit and retains it across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capacity-fence-'))
  try {
    let idle = false
    let boot = 'boot-a'
    const create = () => createSetupTokenCapacityFence({ directory, machineId: 'pc', proveIdle: async () => idle, bootIdentity: async () => boot })
    const input = { version: 1, companyId: 'co', scopeKey: 'a'.repeat(64), managedAccountIds: ['account'], epoch: 2, challenge: 'challenge' }
    expect(await create().barrier(input)).toMatchObject({ ready: false })
    expect(await create().fenced('account')).toBe(true)
    idle = true
    expect(await create().barrier(input)).toMatchObject({ ready: false, reason: 'restart_required' })
    boot = 'boot-b'
    expect(await create().barrier(input)).toEqual({ version: 1, companyId: 'co', machineId: 'pc', fencedAccountIds: ['account'], epoch: 2, challenge: 'challenge', ready: true })
    expect(await create().fenced('another')).toBe(false)
    expect(await create().barrier({ ...input, epoch: 3, requiresRestart: true })).toMatchObject({ ready: false, reason: 'restart_required' })
    boot = 'boot-c'
    expect(await create().barrier({ ...input, epoch: 3, requiresRestart: true })).toMatchObject({ ready: true })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

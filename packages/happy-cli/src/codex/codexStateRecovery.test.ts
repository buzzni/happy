import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { resolveCodexStateEnvironment, codexStateRecoveryRoot } from './codexStateRecovery'

describe('Happy Codex recovered state environment', () => {
  it('reuses only a verified generation without changing the authentication home', async () => {
    const read = vi.fn(async () => JSON.stringify({ version: 1, generation: 7 }))
    const env = await resolveCodexStateEnvironment({ CODEX_HOME: '/codex', OTHER: 'keep' }, read)
    expect(env).toEqual({ CODEX_HOME: '/codex', OTHER: 'keep', CODEX_SQLITE_HOME: join(codexStateRecoveryRoot('/codex'), '7') })
    expect(read).toHaveBeenCalledWith(join(codexStateRecoveryRoot('/codex'), 'current.json'))
  })
  it('preserves an explicit SQLite home and never reads a recovery marker', async () => {
    const read = vi.fn()
    expect(await resolveCodexStateEnvironment({ CODEX_SQLITE_HOME: '/managed/state' }, read)).toEqual({ CODEX_SQLITE_HOME: '/managed/state' })
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps the original state when there is no verified recovery', async () => {
    const env = { CODEX_HOME: '/codex' }
    expect(await resolveCodexStateEnvironment(env, async () => { throw Object.assign(new Error(), { code: 'ENOENT' }) })).toEqual(env)
  })
  it.each([{ version: 1, generation: '../escape' }, { version: 1, generation: 0 }, { version: 2, generation: 1 }])('refuses an invalid recovery marker %j', async marker => {
    await expect(resolveCodexStateEnvironment({ CODEX_HOME: '/codex' }, async () => JSON.stringify(marker))).rejects.toThrow('Invalid Codex state recovery marker')
  })
  it('does not silently ignore an unreadable recovery marker', async () => {
    await expect(resolveCodexStateEnvironment({}, async () => { throw Object.assign(new Error(), { code: 'EACCES' }) })).rejects.toMatchObject({ code: 'EACCES' })
  })
})

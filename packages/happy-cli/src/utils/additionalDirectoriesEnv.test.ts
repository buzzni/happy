import { describe, expect, it } from 'vitest'
import {
  mergeAdditionalDirectoriesIntoSandboxEnvironment,
  readAdditionalDirectoriesEnvironment,
  replaceAdditionalDirectoriesInEnvironment,
  replaceApprovedWriteRootsInEnvironment,
  withdrawUnsafeApprovedWriteRoots,
} from './additionalDirectoriesEnv'
import { SandboxConfigSchema } from '@/persistence'
import { buildSandboxRuntimeConfig } from '@/sandbox/config'

describe('additional directories child environment', () => {
  it('reads only a bounded JSON array of absolute canonical roots', () => {
    expect(readAdditionalDirectoriesEnvironment({
      HAPPY_ADDITIONAL_DIRECTORIES: '["/repo/frontend","/repo/backend"]',
    })).toEqual(['/repo/frontend', '/repo/backend'])
    expect(() => readAdditionalDirectoriesEnvironment({
      HAPPY_ADDITIONAL_DIRECTORIES: 'not-json',
    })).toThrow('additional directories environment')
  })

  it('adds canonical roots to the managed sandbox write allowlist', () => {
    const env = {
      HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({
        enabled: true,
        extraWritePaths: ['/tmp'],
      }),
    }

    mergeAdditionalDirectoriesIntoSandboxEnvironment(env, ['/repo/frontend', '/repo/backend'])

    expect(JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG)).toMatchObject({
      enabled: true,
      extraWritePaths: ['/tmp', '/repo/frontend', '/repo/backend'],
    })
  })

  it('replaces the previously granted roots when a session is resumed with a new list', () => {
    const env: Record<string, string> = {
      HAPPY_ADDITIONAL_DIRECTORIES: JSON.stringify(['/repo/old']),
      HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({
        enabled: true,
        extraWritePaths: ['/tmp', '/repo/old'],
      }),
    }

    replaceAdditionalDirectoriesInEnvironment(env, ['/repo/app'])

    expect(readAdditionalDirectoriesEnvironment(env)).toEqual(['/repo/app'])
    expect(JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG).extraWritePaths).toEqual(['/tmp', '/repo/app'])
  })

  it('drops every granted root when the new list is empty', () => {
    const env: Record<string, string> = {
      HAPPY_ADDITIONAL_DIRECTORIES: JSON.stringify(['/repo/old']),
      HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({ enabled: true, extraWritePaths: ['/tmp', '/repo/old'] }),
    }

    replaceAdditionalDirectoriesInEnvironment(env, [])

    expect(env.HAPPY_ADDITIONAL_DIRECTORIES).toBeUndefined()
    expect(JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG).extraWritePaths).toEqual(['/tmp'])
  })

  it('only adds roots for sessions that never recorded which roots were granted', () => {
    // Sessions spawned before the grant was persisted: their merged roots are
    // indistinguishable from project policy, so nothing is removed.
    const env: Record<string, string> = {
      HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({ enabled: true, extraWritePaths: ['/tmp', '/repo/old'] }),
    }

    replaceAdditionalDirectoriesInEnvironment(env, ['/repo/app'])

    expect(JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG).extraWritePaths).toEqual(['/tmp', '/repo/old', '/repo/app'])
  })
})

// aplus-dev-studio specs/approved-folder-roots R11: approved folders are writable without a per-chat approval.
describe('approved folders in the session sandbox', () => {
  const sandbox = (config: object) => ({ HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify(config) } as Record<string, string>)
  const config = (env: Record<string, string>) => JSON.parse(env.HAPPY_PROJECT_SANDBOX_CONFIG)

  it('makes approved folders writable while keeping the credential homes unwritable', () => {
    const env = sandbox({ extraWritePaths: ['/tmp'], denyWritePaths: ['.env'] })

    replaceApprovedWriteRootsInEnvironment(env, ['/Volumes/work', '/'], ['/Users/me/.happy'])

    expect(config(env)).toMatchObject({ extraWritePaths: ['/tmp', '/Volumes/work', '/'], denyWritePaths: ['.env', '/Users/me/.happy'] })
  })

  it('swaps only what it added for the current list on resume, and leaves project policy alone', () => {
    const env = sandbox({ extraWritePaths: ['/tmp', '/shared'], denyWritePaths: ['.env'] })
    replaceApprovedWriteRootsInEnvironment(env, ['/shared', '/Volumes/old'], ['/Users/me/.happy'])

    replaceApprovedWriteRootsInEnvironment(env, ['/Volumes/new'], ['/Users/me/.happy'])
    expect(config(env)).toMatchObject({ extraWritePaths: ['/tmp', '/shared', '/Volumes/new'], denyWritePaths: ['.env', '/Users/me/.happy'] })

    replaceApprovedWriteRootsInEnvironment(env, [], ['/Users/me/.happy'])
    expect(config(env)).toMatchObject({ extraWritePaths: ['/tmp', '/shared'], denyWritePaths: ['.env'] })
  })

  it('changes nothing for a session without a sandbox', () => {
    const env: Record<string, string> = {}
    replaceApprovedWriteRootsInEnvironment(env, ['/Volumes/work'], ['/Users/me/.happy'])
    expect(env).toEqual({})
  })

  it('leaves an approved drive out of a mandatory sandbox, which refuses a filesystem root as write scope', () => {
    const env = { ...sandbox({ enabled: true, extraWritePaths: ['/tmp'] }), HAPPY_SANDBOX_POLICY_MODE: 'mandatory' }

    replaceApprovedWriteRootsInEnvironment(env, ['/Volumes/work', '/'], ['/Users/me/.happy'])

    expect(config(env).extraWritePaths).toEqual(['/tmp', '/Volumes/work'])
    expect(() => buildSandboxRuntimeConfig(SandboxConfigSchema.parse(config(env)), '/home/me/proj', 'mandatory')).not.toThrow()
    replaceApprovedWriteRootsInEnvironment(env, [], ['/Users/me/.happy'])
    expect(config(env)).toMatchObject({ extraWritePaths: ['/tmp'], denyWritePaths: [] })
  })

  it('withdraws the approved drive once a spawn turns out to be a mandatory write-scope session', () => {
    const env = sandbox({ enabled: true, extraWritePaths: ['/tmp'] })
    replaceApprovedWriteRootsInEnvironment(env, ['/Volumes/work', '/'], ['/Users/me/.happy'])

    withdrawUnsafeApprovedWriteRoots(env, '/home/me')

    expect(config(env)).toMatchObject({ extraWritePaths: ['/tmp', '/Volumes/work'], denyWritePaths: ['/Users/me/.happy'] })
    replaceApprovedWriteRootsInEnvironment(env, ['/'], ['/Users/me/.happy'])
    expect(config(env)).toMatchObject({ extraWritePaths: ['/tmp', '/'], denyWritePaths: ['/Users/me/.happy'] })
  })
})

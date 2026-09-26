import { describe, expect, it } from 'vitest'
import {
  mergeAdditionalDirectoriesIntoSandboxEnvironment,
  readAdditionalDirectoriesEnvironment,
  replaceAdditionalDirectoriesInEnvironment,
} from './additionalDirectoriesEnv'

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

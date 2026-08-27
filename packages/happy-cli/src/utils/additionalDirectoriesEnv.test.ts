import { describe, expect, it } from 'vitest'
import {
  mergeAdditionalDirectoriesIntoSandboxEnvironment,
  readAdditionalDirectoriesEnvironment,
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
})

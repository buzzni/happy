import { describe, expect, it } from 'vitest'

import { handleAgentCommand } from './agentCommand'

describe('handleAgentCommand', () => {
  it('delegates the agent subcommand to the bundled Saycode CLI', () => {
    const calls: unknown[][] = []
    const run = (...args: unknown[]) => {
      calls.push(args)
      return { status: 0 }
    }
    const env = { APLUS_SESSION_ID: 'parent-session' }

    const status = handleAgentCommand(['whoami'], {
      execPath: '/usr/bin/node',
      env,
      resolveSaycodeManifest: () => '/opt/happy/node_modules/@buzzni/saycode-cli/package.json',
      readManifest: () => JSON.stringify({ bin: { saycode: './index.mjs' } }),
      run,
    })

    expect(status).toBe(0)
    expect(calls).toEqual([[
      '/usr/bin/node',
      [
        '--no-warnings',
        '--no-deprecation',
        '/opt/happy/node_modules/@buzzni/saycode-cli/index.mjs',
        'agent',
        'whoami',
      ],
      { stdio: 'inherit', env },
    ]])
  })

  it('returns a failure when the embedded command exits without a status', () => {
    const status = handleAgentCommand(['whoami'], {
      execPath: '/usr/bin/node',
      env: {},
      resolveSaycodeManifest: () => '/opt/happy/node_modules/@buzzni/saycode-cli/package.json',
      readManifest: () => JSON.stringify({ bin: { saycode: './index.mjs' } }),
      run: () => ({ status: null }),
    })

    expect(status).toBe(1)
  })

  it('surfaces a failure to start the embedded command', () => {
    expect(() => handleAgentCommand(['whoami'], {
      execPath: '/usr/bin/node',
      env: {},
      resolveSaycodeManifest: () => '/opt/happy/node_modules/@buzzni/saycode-cli/package.json',
      readManifest: () => JSON.stringify({ bin: { saycode: './index.mjs' } }),
      run: () => ({ status: null, error: new Error('spawn EACCES') }),
    })).toThrow('spawn EACCES')
  })
})

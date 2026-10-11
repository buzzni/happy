import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Desktop specs/headless-standalone-server R28 (T31): `happy auth login` says it succeeded exactly
// once — the new-login flow prints it itself, the machine-id recovery path does not.
const mocks = vi.hoisted(() => ({
  credentials: null as null | { token: string },
  authAndSetupMachineIfNeeded: vi.fn(),
}))

vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readCredentials: async () => mocks.credentials,
  readSettings: async () => ({}),
}))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: mocks.authAndSetupMachineIfNeeded }))

import { handleAuthCommand } from './auth'

let printed: string[]
beforeEach(() => {
  printed = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { printed.push(args.join(' ')) })
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)
})
afterEach(() => { vi.restoreAllMocks() })

const successLines = () => printed.filter((line) => line.includes('Authentication successful')).length

describe('happy auth login success message', () => {
  it('is printed once for a new login, which the auth flow announces itself', async () => {
    mocks.credentials = null
    mocks.authAndSetupMachineIfNeeded.mockImplementation(async () => {
      console.log('\n\n✓ Authentication successful\n')
      return { machineId: 'machine-1' }
    })
    await handleAuthCommand(['login'])
    expect(successLines()).toBe(1)
    expect(printed.join('\n')).toContain('machine-1')
  })

  it('is printed once when stored credentials only needed a machine id', async () => {
    mocks.credentials = { token: 'token' }
    mocks.authAndSetupMachineIfNeeded.mockResolvedValue({ machineId: 'machine-2' })
    await handleAuthCommand(['login'])
    expect(successLines()).toBe(1)
  })

  it('is not printed when sign-in fails', async () => {
    mocks.credentials = null
    mocks.authAndSetupMachineIfNeeded.mockRejectedValue(new Error('Authentication failed or was cancelled'))
    await expect(handleAuthCommand(['login'])).rejects.toThrow('exit 1')
    expect(successLines()).toBe(0)
  })
})

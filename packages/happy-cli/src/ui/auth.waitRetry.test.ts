import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tweetnacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// aplus-dev-studio-desktop specs/headless-standalone-server R29–R31: a machine waiting for the
// owner's approval keeps waiting through a 429 and a dropped request, then signs in.
const server = vi.hoisted(() => ({ calls: 0, waits: [] as number[] }))
vi.mock('./qrcode', () => ({ displayQRCode: () => {} }))
vi.mock('@/utils/time', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/time')>()),
  delay: vi.fn(async (ms: number) => { server.waits.push(ms) }),
}))
vi.mock('axios', () => ({
  default: {
    post: vi.fn(async (_url: string, body: { publicKey: string }) => {
      server.calls++
      if (server.calls === 1) return { data: { state: 'requested' } }
      if (server.calls === 2) throw Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '3' } } })
      if (server.calls === 3) throw new Error('socket hang up')
      const recipient = new Uint8Array(Buffer.from(body.publicKey, 'base64'))
      const ephemeral = tweetnacl.box.keyPair()
      const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength)
      const boxed = tweetnacl.box(new Uint8Array(32).fill(5), nonce, recipient, ephemeral.secretKey)
      const bundle = new Uint8Array([...ephemeral.publicKey, ...nonce, ...boxed])
      return { data: { state: 'authorized', token: 'approved-token', response: Buffer.from(bundle).toString('base64') } }
    }),
  },
}))

import { configuration } from '@/configuration'
import { readCredentials } from '@/persistence'
import { authAndSetupMachineIfNeeded } from './auth'

describe('waiting for approval without a terminal', () => {
  let home: string
  const original: Record<string, unknown> = {}
  const override = (key: string, value: string) => {
    original[key] = (configuration as unknown as Record<string, unknown>)[key]
    Object.defineProperty(configuration, key, { value, configurable: true })
  }
  let output: string[]
  const stdinTTY = process.stdin.isTTY
  const stdoutTTY = process.stdout.isTTY

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'happy-wait-retry-'))
    override('happyHomeDir', home)
    override('privateKeyFile', join(home, 'access.key'))
    override('settingsFile', join(home, 'settings.json'))
    server.calls = 0
    server.waits = []
    output = []
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    vi.spyOn(console, 'clear').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')) })
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { output.push(String(chunk)); return true }) as never)
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) Object.defineProperty(configuration, key, { value, configurable: true })
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true })
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('rides out a 429 and a dropped request, signs in, and prints the wait line once', async () => {
    await authAndSetupMachineIfNeeded()

    expect((await readCredentials())?.token).toBe('approved-token')
    expect(server.waits).toEqual([3_000, 1_000])
    const text = output.join('')
    expect(text.match(/Waiting for authentication/g)).toHaveLength(1)
    expect(text).not.toContain('\r')
    expect(text.match(/Authentication successful/g)).toHaveLength(1)
  })
})

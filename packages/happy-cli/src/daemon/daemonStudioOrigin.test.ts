import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fsPromises from 'node:fs/promises'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fsPromises>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

describe('daemon trusted Studio origin', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'happy-studio-origin-'))
    vi.stubEnv('HAPPY_HOME_DIR', home)
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.resetModules()
    rmSync(home, { recursive: true, force: true })
  })

  function save(settings: Record<string, unknown>) {
    writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  }
  function saved() {
    return JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
  }
  async function resolve(env: NodeJS.ProcessEnv, serverUrl = 'https://saycode.ai') {
    const { resolveDaemonStudioOriginEnvironment } = await import('./daemonStudioOrigin')
    return resolveDaemonStudioOriginEnvironment(env, serverUrl)
  }

  function changeAfterInitialRead(content: string) {
    vi.mocked(fsPromises.readFile).mockImplementationOnce(async (file, options) => {
      const { readFile: read } = await vi.importActual<typeof fsPromises>('node:fs/promises')
      const snapshot = await read(file, options)
      writeFileSync(join(home, 'settings.json'), content)
      return snapshot
    })
  }

  it('keeps an origin saved between the initial read and the locked update', async () => {
    save({ machineId: 'machine' })
    changeAfterInitialRead(JSON.stringify({ machineId: 'machine', aplusStudioOrigin: 'https://registered.example' }))
    expect((await resolve({})).HAPPY_APLUS_STUDIO_ORIGIN).toBe('https://registered.example')
    expect(saved()).toMatchObject({ machineId: 'machine', aplusStudioOrigin: 'https://registered.example' })
  })

  it('preserves settings corrupted between the initial read and the locked update', async () => {
    save({ machineId: 'machine' })
    changeAfterInitialRead('{concurrent-corruption')
    await expect(resolve({})).rejects.toThrow(/^Failed to read settings$/)
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{concurrent-corruption')
  })

  it.each(['https://saycode.ai', 'https://saycode.ai/'])(
    'fills and persists the official origin for a legacy cloud machine (%s)', async serverUrl => {
      save({ schemaVersion: 1, onboardingCompleted: true, machineId: 'legacy', machineControl: 'strict' })
      expect(await resolve({ OTHER: 'kept' }, serverUrl)).toEqual({
        OTHER: 'kept', HAPPY_APLUS_STUDIO_ORIGIN: 'https://saycode.ai',
      })
      expect(saved()).toMatchObject({
        machineId: 'legacy', machineControl: 'strict', aplusStudioOrigin: 'https://saycode.ai',
      })
    },
  )

  it('uses and persists the official origin for a pristine cloud home', async () => {
    expect((await resolve({})).HAPPY_APLUS_STUDIO_ORIGIN).toBe('https://saycode.ai')
    expect(saved()).toMatchObject({ aplusStudioOrigin: 'https://saycode.ai' })
  })

  it.each(['https://self-hosted.example', 'http://127.0.0.1:5174', 'http://[::1]:5174'])(
    'persists an explicit origin over settings and restores it without the environment: %s', async origin => {
      save({ schemaVersion: 2, onboardingCompleted: true, machineId: 'machine', aplusStudioOrigin: 'https://old.example' })
      const environment = { HAPPY_APLUS_STUDIO_ORIGIN: `${origin}/`, SESSION_TOKEN: 'not-settings' }
      expect((await resolve(environment)).HAPPY_APLUS_STUDIO_ORIGIN).toBe(origin)
      expect(environment.HAPPY_APLUS_STUDIO_ORIGIN).toBe(`${origin}/`)
      expect(saved()).toEqual({ schemaVersion: 2, onboardingCompleted: true, machineId: 'machine', aplusStudioOrigin: origin })
      vi.resetModules()
      expect((await resolve({})).HAPPY_APLUS_STUDIO_ORIGIN).toBe(origin)
    },
  )

  it('keeps a registered custom Studio even when the relay is the official cloud', async () => {
    save({ aplusStudioOrigin: 'https://registered.example' })
    expect((await resolve({})).HAPPY_APLUS_STUDIO_ORIGIN).toBe('https://registered.example')
  })

  it.each([
    'https://unknown.example', 'http://localhost:5174', 'https://dev.saycode.ai',
    'http://saycode.ai', 'https://saycode.ai.evil.test', 'https://saycode.ai@evil.test',
    'https://user@saycode.ai', 'https://saycode.ai/path', 'https://saycode.ai?host=evil.test',
    'https://saycode.ai#fragment', 'not-a-url',
  ])('never infers trust from an unrecognized relay or the MCP endpoint: %s', async serverUrl => {
    const environment = { HAPPY_APLUS_MCP_CONFIG_URL: 'https://saycode.ai/api/me/mcp-config' }
    expect(await resolve(environment, serverUrl)).toEqual(environment)
    expect(existsSync(join(home, 'settings.json'))).toBe(false)
  })

  it.each(['', 'http://unknown.example', 'https://user:private@studio.test', 'https://studio.test/api', 'https://studio.test?q=1', 'ftp://host'])(
    'rejects invalid explicit origins without replacing a stored origin or falling back: %s', async origin => {
      save({ aplusStudioOrigin: 'https://registered.example' })
      await expect(resolve({ HAPPY_APLUS_STUDIO_ORIGIN: origin }))
        .rejects.toThrow(/^Invalid HAPPY_APLUS_STUDIO_ORIGIN$/)
      expect(saved()).toEqual({ aplusStudioOrigin: 'https://registered.example' })
    },
  )

  it.each(['', null, 123, {}, 'https://studio.test/path'])(
    'rejects invalid stored origins instead of falling back to cloud: %j', async origin => {
      save({ aplusStudioOrigin: origin })
      await expect(resolve({})).rejects.toThrow(/^Invalid persisted Studio origin$/)
      expect(saved()).toEqual({ aplusStudioOrigin: origin })
    },
  )

  it.each(['{broken-json', 'null', '[]', '42', '"private-setting"'])(
    'refuses to replace malformed settings with a cloud default: %s', async content => {
      writeFileSync(join(home, 'settings.json'), content)
      await expect(resolve({})).rejects.toThrow(/^Failed to read settings$/)
      expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe(content)
    },
  )
})

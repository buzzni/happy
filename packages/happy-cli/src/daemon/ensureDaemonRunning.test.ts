import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const mocks = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockIsDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
  mockCheckIfDaemonRunningAndCleanupStaleState: vi.fn(),
  mockSpawnHappyCLI: vi.fn(),
  mockReadSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
  mockReadDaemonState: vi.fn(),
  mockReadDaemonLockHolderPid: vi.fn(),
  mockIsPidAlive: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion,
  checkIfDaemonRunningAndCleanupStaleState: mocks.mockCheckIfDaemonRunningAndCleanupStaleState,
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mocks.mockSpawnHappyCLI,
  // Keep in sync with the module's exports: this factory replaces the whole
  // module, so any export ensureDaemonRunning starts using must be listed here
  // or the call throws at runtime instead of failing a meaningful assertion.
  captureSpawnOutputStdio: () => 'ignore',
}))

vi.mock('@/persistence', () => ({
  readSettings: mocks.mockReadSettings,
  updateSettings: mocks.mockUpdateSettings,
  readDaemonState: mocks.mockReadDaemonState,
  readDaemonLockHolderPid: mocks.mockReadDaemonLockHolderPid,
  isPidAlive: mocks.mockIsPidAlive,
}))

import { ensureDaemonRunning } from './ensureDaemonRunning'
import { configuration } from '@/configuration'

const onlineParent = () => ({
  pid: process.ppid,
  httpPort: 43210,
  state: 'running',
  socketConnected: true,
  startedWithCliVersion: configuration.currentCliVersion,
  controlSecret: 'parent-control-secret',
})

describe('ensureDaemonRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', undefined)
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: vi.fn(),
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValue(true)
    mocks.mockReadDaemonState.mockResolvedValue(null)
    mocks.mockReadDaemonLockHolderPid.mockReturnValue(null)
    mocks.mockIsPidAlive.mockReturnValue(false)
    mocks.mockReadSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
    })
  })

  afterEach(() => vi.unstubAllEnvs())

  it('returns without spawning when the daemon is already running', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).not.toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      'Ensuring Happy background service is running & matches our version...',
    )
  })

  it('does not spawn a replacement when a live owner has unconfirmed health', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockRejectedValue(new Error('DAEMON_HEALTH_UNCONFIRMED'))
    await expect(ensureDaemonRunning()).rejects.toThrow('DAEMON_HEALTH_UNCONFIRMED')
    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
  })

  it('continues a child of the online owning daemon without a second HTTP health check', async () => {
    mocks.mockReadDaemonState.mockResolvedValue(onlineParent())
    mocks.mockReadDaemonLockHolderPid.mockReturnValue(process.ppid)
    mocks.mockIsPidAlive.mockReturnValue(true)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockRejectedValue(new Error('DAEMON_HEALTH_UNCONFIRMED'))

    await expect(ensureDaemonRunning()).resolves.toBeUndefined()

    expect(mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion).not.toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).not.toHaveBeenCalled()
    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockUpdateSettings).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.mockLoggerDebug.mock.calls)).not.toContain('parent-control-secret')
  })

  it.each([
    ['a different OS parent', { pid: process.ppid + 1 }],
    ['a different CLI version', { startedWithCliVersion: 'older-cli' }],
    ['a stopped parent', { state: 'stopped' }],
    ['a crashed parent', { state: 'crashed' }],
    ['an offline parent', { socketConnected: false }],
    ['an unknown connection', { socketConnected: undefined }],
    ['an unbound control port', { httpPort: 0 }],
    ['missing control credentials', { controlSecret: undefined }],
  ])('retains normal health verification for %s', async (_name, changes) => {
    mocks.mockReadDaemonState.mockResolvedValue({ ...onlineParent(), ...changes })
    mocks.mockReadDaemonLockHolderPid.mockReturnValue(process.ppid)
    mocks.mockIsPidAlive.mockReturnValue(true)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockRejectedValue(new Error('DAEMON_HEALTH_UNCONFIRMED'))

    await expect(ensureDaemonRunning()).rejects.toThrow('DAEMON_HEALTH_UNCONFIRMED')
    expect(mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion).toHaveBeenCalledOnce()
    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
  })

  it.each([null, process.ppid + 1])('retains verification when the daemon lock owner is %s', async lockPid => {
    mocks.mockReadDaemonState.mockResolvedValue(onlineParent())
    mocks.mockReadDaemonLockHolderPid.mockReturnValue(lockPid)
    mocks.mockIsPidAlive.mockReturnValue(true)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockRejectedValue(new Error('DAEMON_HEALTH_UNCONFIRMED'))

    await expect(ensureDaemonRunning()).rejects.toThrow('DAEMON_HEALTH_UNCONFIRMED')
    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
  })

  it('keeps automatic startup when the recorded daemon parent has exited', async () => {
    mocks.mockReadDaemonState.mockResolvedValue(onlineParent())
    mocks.mockReadDaemonLockHolderPid.mockReturnValue(process.ppid)
    mocks.mockIsPidAlive.mockReturnValue(false)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledOnce()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).toHaveBeenCalledOnce()
  })

  it('starts the daemon and waits for readiness when the installed version is not running', async () => {
    const mockUnref = vi.fn()
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: mockUnref,
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    expect(mockUnref).toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).toHaveBeenCalledTimes(2)
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Starting Happy background service...')
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Happy background service is ready')
  })

  it('restores the persisted Aplus MCP config URL when the caller environment omits it', async () => {
    const originalConfigUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL
    delete process.env.HAPPY_APLUS_MCP_CONFIG_URL
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockReadSettings.mockResolvedValue({
      schemaVersion: 2,
      onboardingCompleted: true,
      aplusMcpConfigUrl: 'https://saycode.example/api/me/mcp-config',
    })

    try {
      await ensureDaemonRunning()

      expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledTimes(1)
      expect(mocks.mockSpawnHappyCLI.mock.calls[0]?.[1]?.env?.HAPPY_APLUS_MCP_CONFIG_URL).toBe(
        'https://saycode.example/api/me/mcp-config',
      )
    } finally {
      if (originalConfigUrl === undefined) delete process.env.HAPPY_APLUS_MCP_CONFIG_URL
      else process.env.HAPPY_APLUS_MCP_CONFIG_URL = originalConfigUrl
    }
  })

  it('forwards the explicit endpoint without changing the invoking session URL', async () => {
    const sessionUrl = 'https://explicit.example/api/me/mcp-config?project_id=session&token=private#secret'
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', sessionUrl)
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockReadSettings.mockResolvedValue({ aplusMcpConfigUrl: 'https://old.example/api/me/mcp-config' })

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledTimes(1)
    expect(mocks.mockSpawnHappyCLI.mock.calls[0][1].env.HAPPY_APLUS_MCP_CONFIG_URL)
      .toBe('https://explicit.example/api/me/mcp-config')
    expect(process.env.HAPPY_APLUS_MCP_CONFIG_URL).toBe(sessionUrl)
    expect(mocks.mockReadSettings).not.toHaveBeenCalled()
    expect(mocks.mockUpdateSettings).not.toHaveBeenCalled()
  })

  it('does not start a replacement daemon when its persisted endpoint is invalid', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockReadSettings.mockResolvedValue({
      aplusMcpConfigUrl: 'https://user:secret@studio.example/api/me/mcp-config',
    })

    await expect(ensureDaemonRunning()).rejects.toThrow(/^Invalid persisted Aplus MCP config URL$/)
    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.mockLoggerDebug.mock.calls)).not.toContain('secret')
  })
})

describe('daemon parent handoff across real processes', () => {
  it.each([true, false])('preserves authenticated reports with matching lock ownership=%s', async ownsLock => {
    const home = await mkdtemp(join(tmpdir(), 'happy-parent-handoff-'))
    let healthRequests = 0
    const reports: Array<{ authenticated: boolean; sessionId: string; hostPid: number }> = []
    const server = createServer(async (request, response) => {
      if (request.url === '/list') {
        healthRequests += 1
        // Deliberately never answer: only the verified daemon's own child may
        // proceed without waiting for the existing 2s health timeout.
        return
      }
      if (request.url !== '/session-started') {
        response.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const authenticated = request.headers.authorization === 'Bearer fixture-parent-secret'
      reports.push({ authenticated, sessionId: body.sessionId, hostPid: body.metadata.hostPid })
      response.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: authenticated }))
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
      const stateFile = join(home, 'daemon.state.json')
      const lockFile = `${stateFile}.lock`
      const state = JSON.stringify({
        ...onlineParent(), pid: process.pid, httpPort: address.port, controlSecret: 'fixture-parent-secret',
      })
      const lock = String(ownsLock ? process.pid : process.ppid)
      await writeFile(stateFile, state, { mode: 0o600 })
      await writeFile(lockFile, lock, { mode: 0o600 })
      const script = `
        const { ensureDaemonRunning } = await import(${JSON.stringify(new URL('./ensureDaemonRunning.ts', import.meta.url).href)});
        const { notifyDaemonSessionStarted } = await import(${JSON.stringify(new URL('./controlClient.ts', import.meta.url).href)});
        let phase = 'ready';
        try { await ensureDaemonRunning(); }
        catch (error) {
          if (!error.message.includes('DAEMON_HEALTH_UNCONFIRMED')) throw error;
          phase = 'blocked';
        }
        if (phase === 'ready') {
          const result = await notifyDaemonSessionStarted('parent-fixture-session', { hostPid: process.pid, flavor: 'claude' });
          if (result.error || !result.ok) throw new Error('fixture session report failed');
        }
        console.log(JSON.stringify({ phase, parentPid: process.ppid, childPid: process.pid }));
      `
      // The subprocess imports real production modules; Vitest's module mocks
      // stay in this process. Isolated state and no inherited launch capability
      // keep it separate from the user's daemon and account.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HAPPY_')))
      const { stdout } = await promisify(execFile)(process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { timeout: 20_000, env: { ...env, HAPPY_HOME_DIR: home, TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') } })
      const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
      expect(result.parentPid).toBe(process.pid)
      expect(result.phase).toBe(ownsLock ? 'ready' : 'blocked')
      expect(healthRequests).toBe(ownsLock ? 0 : 1)
      expect(reports).toEqual(ownsLock ? [{ authenticated: true, sessionId: 'parent-fixture-session', hostPid: result.childPid }] : [])
      expect(await readFile(stateFile, 'utf8')).toBe(state)
      expect(await readFile(lockFile, 'utf8')).toBe(lock)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await rm(home, { recursive: true, force: true })
    }
  }, 25_000)
})

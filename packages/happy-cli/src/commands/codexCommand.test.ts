import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuthAndSetupMachineIfNeeded: vi.fn(),
  mockRunCodex: vi.fn(),
  mockExtractCodexResumeFlag: vi.fn(),
  mockExtractNoSandboxFlag: vi.fn(),
  mockEnsureDaemonRunning: vi.fn(),
}))

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.mockAuthAndSetupMachineIfNeeded,
}))

vi.mock('@/codex/runCodex', () => ({
  runCodex: mocks.mockRunCodex,
}))

vi.mock('@/codex/cliArgs', () => ({
  extractCodexResumeFlag: mocks.mockExtractCodexResumeFlag,
}))

vi.mock('@/utils/sandboxFlags', () => ({
  extractNoSandboxFlag: mocks.mockExtractNoSandboxFlag,
}))

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}))

import { handleCodexCommand } from './codexCommand'

describe('handleCodexCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockAuthAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token' },
    })
    mocks.mockExtractNoSandboxFlag.mockImplementation((args: string[]) => ({
      noSandbox: false,
      args,
    }))
    mocks.mockExtractCodexResumeFlag.mockImplementation((args: string[]) => ({
      resumeThreadId: null,
      args,
    }))
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined)
    mocks.mockRunCodex.mockResolvedValue(undefined)
  })

  it('loads the Codex runner while the account daemon is becoming ready', async () => {
    vi.resetModules()
    let runnerLoaded = false
    vi.doMock('@/codex/runCodex', () => {
      runnerLoaded = true
      return { runCodex: mocks.mockRunCodex }
    })
    let releaseDaemon: (() => void) | undefined
    mocks.mockEnsureDaemonRunning.mockImplementationOnce(() => new Promise<void>(resolve => { releaseDaemon = resolve }))
    const { handleCodexCommand: command } = await import('./codexCommand')
    try {
      expect(runnerLoaded).toBe(false)
      const pending = command(['--started-by', 'terminal'])
      try {
        await vi.waitFor(() => expect(runnerLoaded).toBe(true))
        expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledOnce()
        expect(mocks.mockRunCodex).not.toHaveBeenCalled()
      } finally {
        releaseDaemon?.()
        await pending
      }
      expect(mocks.mockRunCodex).toHaveBeenCalledOnce()
    } finally {
      vi.doMock('@/codex/runCodex', () => ({ runCodex: mocks.mockRunCodex }))
    }
  })

  it('ensures the daemon is running before starting a codex session', async () => {
    await handleCodexCommand(['--started-by', 'terminal'])

    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1)
    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      principal: { kind: 'account', credentials: { token: 'token' } },
      startedBy: 'terminal',
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: undefined,
    })
    expect(
      mocks.mockEnsureDaemonRunning.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.mockRunCodex.mock.invocationCallOrder[0])
  })

  it('hands a prepared app-server to the authenticated daemon session and releases any remaining preparation', async () => {
    const prepared = { claim: vi.fn(), dispose: vi.fn(async () => {}) }
    mocks.mockRunCodex.mockImplementationOnce(async options => {
      expect(options.preparedAppServer).toBe(prepared)
      expect(prepared.dispose).not.toHaveBeenCalled()
    })

    await handleCodexCommand(['--started-by', 'daemon'], prepared)

    expect(mocks.mockRunCodex).toHaveBeenCalledOnce()
    expect(mocks.mockEnsureDaemonRunning.mock.invocationCallOrder[0]).toBeLessThan(mocks.mockRunCodex.mock.invocationCallOrder[0])
    expect(prepared.dispose).toHaveBeenCalledOnce()
  })

  it('disposes an unclaimed app-server when daemon authentication fails', async () => {
    const prepared = { claim: vi.fn(), dispose: vi.fn(async () => {}) }
    mocks.mockAuthAndSetupMachineIfNeeded.mockRejectedValueOnce(new Error('Authentication failed'))

    await expect(handleCodexCommand(['--started-by', 'daemon'], prepared)).rejects.toThrow('Authentication failed')

    expect(mocks.mockRunCodex).not.toHaveBeenCalled()
    expect(prepared.dispose).toHaveBeenCalledOnce()
  })

  it.each(['terminal', 'resume'] as const)('disposes early and uses the ordinary startup for %s', async path => {
    const prepared = { claim: vi.fn(), dispose: vi.fn(async () => {}) }
    if (path === 'resume') {
      mocks.mockExtractCodexResumeFlag.mockReturnValueOnce({ resumeThreadId: 'thread-123', args: ['--started-by', 'daemon'] })
    }
    mocks.mockRunCodex.mockImplementationOnce(async options => {
      expect(options.preparedAppServer).toBeUndefined()
      expect(prepared.dispose).toHaveBeenCalledOnce()
    })

    await handleCodexCommand(['--started-by', path === 'terminal' ? 'terminal' : 'daemon'], prepared)

    expect(mocks.mockRunCodex).toHaveBeenCalledOnce()
  })

  it('passes parsed no-sandbox and resume flags through to runCodex', async () => {
    mocks.mockExtractNoSandboxFlag.mockReturnValue({
      noSandbox: true,
      args: ['--resume', 'thread-123', '--started-by', 'daemon'],
    })
    mocks.mockExtractCodexResumeFlag.mockReturnValue({
      resumeThreadId: 'thread-123',
      args: ['--started-by', 'daemon'],
    })

    await handleCodexCommand(['--no-sandbox', '--resume', 'thread-123', '--started-by', 'daemon'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      principal: { kind: 'account', credentials: { token: 'token' } },
      startedBy: 'daemon',
      noSandbox: true,
      resumeThreadId: 'thread-123',
      permissionMode: undefined,
    })
  })

  it('passes permission-mode through to runCodex', async () => {
    await handleCodexCommand(['--permission-mode', 'yolo'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      principal: { kind: 'account', credentials: { token: 'token' } },
      startedBy: undefined,
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: 'yolo',
    })
  })

  it.each([['--model'], ['--model', '--started-by', 'daemon'], ['--model', '  ']])('rejects a missing model before starting a session: %j', async (...args) => {
    await expect(handleCodexCommand(args)).rejects.toThrow('Codex model requires a model ID')
    expect(mocks.mockAuthAndSetupMachineIfNeeded).not.toHaveBeenCalled()
    expect(mocks.mockEnsureDaemonRunning).not.toHaveBeenCalled()
    expect(mocks.mockRunCodex).not.toHaveBeenCalled()
  })

  it('maps --yolo to codex yolo permission mode', async () => {
    await handleCodexCommand(['--yolo'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      principal: { kind: 'account', credentials: { token: 'token' } },
      startedBy: undefined,
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: 'yolo',
    })
  })

it('strips standalone launch credentials before authentication or any subprocess work', async () => {
  const bootstrap = { version: 1, instanceId: 'instance-1', launchId: 'launch-1', port: 12345, secret: 'a'.repeat(64) };
  process.env.HAPPY_STANDALONE_LAUNCH_V1 = JSON.stringify(bootstrap);
  mocks.mockAuthAndSetupMachineIfNeeded.mockImplementationOnce(async () => {
    expect(process.env.HAPPY_STANDALONE_LAUNCH_V1).toBeUndefined();
    return { credentials: { token: 'token' } };
  });
  try {
    await handleCodexCommand(['--started-by', 'daemon']);
    expect(mocks.mockRunCodex).toHaveBeenLastCalledWith(expect.objectContaining({ standaloneLaunch: bootstrap }));
  } finally { delete process.env.HAPPY_STANDALONE_LAUNCH_V1; }
});

})

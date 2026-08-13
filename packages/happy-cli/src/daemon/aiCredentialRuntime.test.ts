import { describe, expect, it, vi } from 'vitest'
import {
  createAiCredentialRuntime,
  runAiCredentialCommand,
  type AiCredentialCommandResult,
  type AiCredentialRuntimeDependencies,
} from './aiCredentialRuntime'

const configuredClaudeList = JSON.stringify({
  schemaVersion: 1,
  activeAccountNumber: 1,
  accounts: [{ number: 1, email: 'owner@example.com', active: true }],
})

function setup(overrides: Partial<AiCredentialRuntimeDependencies> = {}) {
  const calls: Array<{ command: string; args: string[]; input?: string }> = []
  const files = new Map<string, string>()
  const execFile = vi.fn(async (
    command: string,
    args: string[],
    options?: { input?: string },
  ): Promise<AiCredentialCommandResult> => {
    calls.push({ command, args, input: options?.input })
    if (command === 'cswap' && args[0] === 'export') {
      return { stdout: '{"version":1,"encrypted":false,"accounts":[{}]}', stderr: '' }
    }
    if (command === 'cswap' && args[0] === '--version') {
      return { stdout: 'claude-swap 0.25.0', stderr: '' }
    }
    if (command === 'cswap' && args[0] === 'list') {
      return {
        stdout: configuredClaudeList,
        stderr: '',
      }
    }
    return { stdout: '', stderr: '' }
  })
  const supervisor = {
    enable: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    status: vi.fn(() => ({ state: 'running' as const, lastErrorKind: null })),
  }
  const runtime = createAiCredentialRuntime({
    homeDir: '/home/operator',
    env: {},
    execFile,
    readFile: vi.fn(async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))),
    writeFile: vi.fn(async (path: string, content: string) => { files.set(path, content) }),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from)
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      files.set(to, value)
      files.delete(from)
    }),
    chmod: vi.fn(async () => undefined),
    rm: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
      for (const filePath of files.keys()) {
        if (filePath === path || (options?.recursive && filePath.startsWith(`${path}/`))) {
          files.delete(filePath)
        }
      }
    }),
    makeTempDir: vi.fn(async () => '/tmp/happy-ai-credential-fixed'),
    supervisor,
    ...overrides,
  })
  return { runtime, calls, files, supervisor }
}

describe('AI credential machine runtime', () => {
  it('exports Claude credentials with fixed argv and a payload size cap', async () => {
    const { runtime, calls } = setup()

    await expect(runtime.capture({ provider: 'claude' })).resolves.toEqual({
      provider: 'claude',
      payload: '{"version":1,"encrypted":false,"accounts":[{}]}',
    })
    expect(calls).toEqual([{ command: 'cswap', args: ['export', '-'], input: undefined }])

    const oversized = 'x'.repeat(1024 * 1024 + 1)
    const { runtime: capped } = setup({
      execFile: vi.fn(async () => ({ stdout: oversized, stderr: '' })),
    })
    await expect(capped.capture({ provider: 'claude' })).rejects.toMatchObject({
      kind: 'PAYLOAD_TOO_LARGE',
    })
  })

  it('reads Codex credentials from CODEX_HOME only and rejects unsupported providers', async () => {
    const { runtime, files } = setup({ env: { CODEX_HOME: '/fixed/codex' } })
    files.set('/fixed/codex/auth.json', '{"OPENAI_API_KEY":"secret"}')

    await expect(runtime.capture({ provider: 'codex' })).resolves.toEqual({
      provider: 'codex',
      payload: '{"OPENAI_API_KEY":"secret"}',
    })
    await expect(runtime.capture({ provider: '../etc/passwd' as never })).rejects.toThrow(/provider/i)
  })

  it('installs, configures, and imports Claude credentials without putting the secret in argv', async () => {
    const { runtime, calls, files, supervisor } = setup()
    const payload = '{"token":"never-in-argv"}'

    await expect(runtime.apply({ provider: 'claude', payload })).resolves.toMatchObject({
      provider: 'claude',
      configured: true,
      rotation: { state: 'running' },
    })

    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ['uv', ['--version']],
      ['uv', ['python', 'find', '>=3.12']],
      ['cswap', ['--version']],
      ['cswap', ['config', 'set', 'autoswitch.threshold', '95']],
      ['cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first']],
      ['cswap', ['import', '/tmp/happy-ai-credential-fixed/claude-swap.json', '--force']],
      ['cswap', ['list', '--json']],
    ])
    expect(JSON.stringify(calls.map(({ command, args }) => ({ command, args })))).not.toContain('never-in-argv')
    expect(files.has('/tmp/happy-ai-credential-fixed/claude-swap.json')).toBe(false)
    expect(supervisor.enable).toHaveBeenCalledOnce()
  })

  it('installs the managed claude-swap version when the current version differs', async () => {
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'claude-swap 0.24.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return { stdout: configuredClaudeList, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime } = setup({ execFile })

    await runtime.apply({ provider: 'claude', payload: '{}' })

    expect(execFile).toHaveBeenCalledWith('uv', [
      'tool', 'install', 'claude-swap==0.25.0', '--python', '>=3.12', '--force',
    ], expect.anything())
  })

  it('does not accept a version string that merely contains the managed version', async () => {
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'claude-swap 0.25.0-beta.1', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return { stdout: configuredClaudeList, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime } = setup({ execFile })

    await runtime.apply({ provider: 'claude', payload: '{}' })

    expect(execFile).toHaveBeenCalledWith('uv', [
      'tool', 'install', 'claude-swap==0.25.0', '--python', '>=3.12', '--force',
    ], expect.anything())
  })

  it('atomically applies Codex auth with mode 0600 and reports only login status', async () => {
    const chmod = vi.fn(async () => undefined)
    const { runtime, files, calls } = setup({ chmod })
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).resolves.toEqual({ provider: 'codex', configured: true, status: 'authenticated' })

    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"new-secret"}')
    expect(files.get('/home/operator/.codex/auth.json.happy-backup')).toBe('{"OPENAI_API_KEY":"old"}')
    expect(chmod).toHaveBeenCalledWith('/home/operator/.codex/auth.json', 0o600)
    expect(calls.at(-1)).toEqual({ command: 'codex', args: ['login', 'status'], input: undefined })
    expect(JSON.stringify(calls)).not.toContain('new-secret')
  })

  it('preserves the existing Codex auth when the backup cannot be created', async () => {
    const rename = vi.fn(async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const { runtime, files } = setup({ rename })
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).rejects.toMatchObject({ kind: 'CODEX_BACKUP_FAILED' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"old"}')
  })

  it('restores the existing Codex auth when backup permission tightening fails', async () => {
    const chmod = vi.fn(async (path: string) => {
      if (path.endsWith('auth.json.happy-backup')) throw new Error('permission denied')
    })
    const { runtime, files } = setup({ chmod })
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).rejects.toMatchObject({ kind: 'CODEX_BACKUP_FAILED' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"old"}')
    expect(files.has('/home/operator/.codex/auth.json.happy-backup')).toBe(false)
  })

  it('serializes concurrent applies so credential file replacements cannot overlap', async () => {
    let releaseFirst!: () => void
    const firstStatusBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let statusCalls = 0
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'codex' && args[0] === 'login') {
        statusCalls += 1
        if (statusCalls === 1) await firstStatusBlocked
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime, files } = setup({ execFile })
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    const first = runtime.apply({ provider: 'codex', payload: '{"OPENAI_API_KEY":"one"}' })
    await vi.waitFor(() => expect(statusCalls).toBe(1))
    const second = runtime.apply({ provider: 'codex', payload: '{"OPENAI_API_KEY":"two"}' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(statusCalls).toBe(1)

    releaseFirst()
    await Promise.all([first, second])
    expect(statusCalls).toBe(2)
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"two"}')
  })

  it('serializes capture behind an in-progress credential replacement', async () => {
    let releaseWrite!: () => void
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve })
    let tempWriteStarted = false
    let files!: Map<string, string>
    const configured = setup({
      writeFile: vi.fn(async (path: string, content: string) => {
        if (path.endsWith('.auth.json.happy-tmp')) {
          tempWriteStarted = true
          await writeBlocked
        }
        files.set(path, content)
      }),
    })
    files = configured.files
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    const apply = configured.runtime.apply({ provider: 'codex', payload: '{"OPENAI_API_KEY":"new"}' })
    await vi.waitFor(() => expect(tempWriteStarted).toBe(true))
    let captureSettled = false
    const capture = configured.runtime.capture({ provider: 'codex' })
      .finally(() => { captureSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(captureSettled).toBe(false)

    releaseWrite()
    await apply
    await expect(capture).resolves.toEqual({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new"}',
    })
  })

  it('orders rotation changes after an in-progress Claude apply', async () => {
    let releaseList!: () => void
    const listBlocked = new Promise<void>((resolve) => { releaseList = resolve })
    const events: string[] = []
    const supervisor = {
      enable: vi.fn(async () => { events.push('enable') }),
      stop: vi.fn(async () => { events.push('stop') }),
      status: vi.fn(() => ({ state: 'running' as const, lastErrorKind: null })),
    }
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'claude-swap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        events.push('verify')
        await listBlocked
        return { stdout: configuredClaudeList, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime } = setup({ execFile, supervisor })

    const apply = runtime.apply({ provider: 'claude', payload: '{}' })
    await vi.waitFor(() => expect(events).toEqual(['verify']))
    const stop = runtime.rotation({ action: 'stop' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(['verify'])

    releaseList()
    await Promise.all([apply, stop])
    expect(events).toEqual(['verify', 'enable', 'stop'])
  })

  it('restores Codex auth even when temporary-file cleanup fails', async () => {
    let files!: Map<string, string>
    const configured = setup({
      execFile: vi.fn(async (command: string) => {
        if (command === 'codex') throw new Error('not authenticated')
        return { stdout: '', stderr: '' }
      }),
      rm: vi.fn(async (path: string) => {
        if (path.endsWith('.auth.json.happy-tmp')) throw new Error('cleanup failed')
        files.delete(path)
      }),
    })
    files = configured.files
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(configured.runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new"}',
    })).rejects.toMatchObject({ kind: 'CODEX_APPLY_FAILED' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"old"}')
  })

  it('redacts Claude account status instead of returning command output', async () => {
    const { runtime } = setup()

    await expect(runtime.status({ provider: 'claude' })).resolves.toEqual({
      provider: 'claude',
      configured: true,
      activeAccount: 'o***@example.com',
      rotation: { state: 'running', lastErrorKind: null },
    })
  })

  it('reports an empty Claude account list as not configured', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: '{"schemaVersion":1,"activeAccountNumber":null,"accounts":[]}',
        stderr: '',
      })),
    })

    await expect(runtime.status({ provider: 'claude' })).resolves.toMatchObject({
      provider: 'claude',
      configured: false,
      activeAccount: null,
    })
  })

  it('bootstraps claude-swap before starting rotation directly', async () => {
    const { runtime, calls, supervisor } = setup()

    await runtime.rotation({ action: 'start' })

    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ['uv', ['--version']],
      ['uv', ['python', 'find', '>=3.12']],
      ['cswap', ['--version']],
      ['cswap', ['config', 'set', 'autoswitch.threshold', '95']],
      ['cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first']],
    ])
    expect(supervisor.enable).toHaveBeenCalledOnce()
  })

  it('redacts unexpected dependency errors at the RPC boundary', async () => {
    const { runtime } = setup({
      makeTempDir: vi.fn(async () => { throw new Error('token=secret-value') }),
    })

    const error = await runtime.apply({ provider: 'claude', payload: '{}' }).catch((caught) => caught)
    expect(error).toMatchObject({ kind: 'CLAUDE_APPLY_FAILED' })
    expect(String(error)).not.toContain('secret-value')
  })

  it('rejects malformed Claude list output instead of reporting configured', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({ stdout: '{"schemaVersion":1,"error":{"message":"secret"}}', stderr: '' })),
    })

    await expect(runtime.status({ provider: 'claude' })).rejects.toMatchObject({
      kind: 'CLAUDE_STATUS_INVALID',
    })
  })

  it('terminates commands that exceed their timeout without returning process output', async () => {
    await expect(runAiCredentialCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 20 },
    )).rejects.toMatchObject({ kind: 'COMMAND_TIMED_OUT' })
  })
})

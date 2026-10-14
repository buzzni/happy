import { describe, expect, it, vi } from 'vitest'
import { claudeSwapLaunch, createClaudeSwapPythonResolver, findClaudeSwapPython, routeClaudeSwapThroughPython } from './claudeSwapPython'

const appData = 'C:\\Users\\u\\AppData\\Roaming'
const environment = `${appData}\\uv\\tools\\saycode-claude-swap`
const home = `${appData}\\uv\\python\\cpython-3.14-windows-x86_64-none`
const target = { python: `${home}\\python.exe`, sitePackages: `${environment}\\Lib\\site-packages` }

function files(root = environment, present = [target.python, `${target.sitePackages}\\claude_swap`]) {
  return {
    readFile: async (file: string) => { if (file === `${root}\\pyvenv.cfg`) return `home = ${home}\r\nversion_info = 3.14.0\r\n`; throw new Error('ENOENT') },
    exists: (file: string) => present.includes(file),
  }
}

// 2026-10-15 customer PC (AhnLab): cswap.exe took 7–9 s a run, claude-swap's base python.exe 0.5–0.9 s.
describe('claude-swap through its base Python on Windows', () => {
  it("finds the uv environment's base python, honouring UV_TOOL_DIR", async () => {
    expect(await findClaudeSwapPython('saycode-claude-swap', { APPDATA: appData }, files())).toEqual(target)
    const custom = 'D:\\uv-tools\\saycode-claude-swap'
    expect(await findClaudeSwapPython('saycode-claude-swap', { APPDATA: appData, UV_TOOL_DIR: 'D:\\uv-tools' }, files(custom, [target.python, `${custom}\\Lib\\site-packages\\claude_swap`])))
      .toEqual({ python: target.python, sitePackages: `${custom}\\Lib\\site-packages` })
    expect(await findClaudeSwapPython('saycode-claude-swap', {}, files())).toBeNull()
    expect(await findClaudeSwapPython('saycode-claude-swap', { APPDATA: appData }, files(environment, [target.python]))).toBeNull()
  })

  it('verifies once per daemon, keeps the answer for synchronous spawns, and looks again after a reinstall', async () => {
    const find = vi.fn(async () => target), verify = vi.fn(async () => true)
    const resolver = createClaudeSwapPythonResolver({ platform: 'win32', find, verify })
    expect(resolver.peek()).toBeNull()
    expect(await resolver.get()).toEqual(target)
    expect(await resolver.get()).toEqual(target)
    expect(resolver.peek()).toEqual(target)
    expect(find).toHaveBeenCalledTimes(1)
    resolver.forget()
    expect(resolver.peek()).toBeNull()
    await resolver.get()
    expect(find).toHaveBeenCalledTimes(2)
    expect(await createClaudeSwapPythonResolver({ platform: 'win32', find, verify: async () => false }).get()).toBeNull()
    const elsewhere = vi.fn(async () => target)
    expect(await createClaudeSwapPythonResolver({ platform: 'darwin', find: elsewhere, verify }).get()).toBeNull()
    expect(elsewhere).not.toHaveBeenCalled()
  })

  it('runs cswap commands through that Python, and only cswap', async () => {
    const run = vi.fn(async (_command: string, _args: string[], _options?: { timeoutMs?: number; environment?: Record<string, string | undefined> }) => ({ stdout: 'ok', stderr: '' }))
    const resolver = { get: vi.fn(async () => target), peek: () => target, forget: vi.fn() }
    const routed = routeClaudeSwapThroughPython(run, resolver)
    await routed('cswap', ['list', '--json'], { timeoutMs: 5, environment: { KEEP: '1' } })
    expect(run).toHaveBeenLastCalledWith(target.python, ['-m', 'claude_swap', 'list', '--json'], { timeoutMs: 5, environment: { KEEP: '1', PYTHONPATH: target.sitePackages } })
    await routed('uv', ['--version'])
    expect(run).toHaveBeenLastCalledWith('uv', ['--version'], undefined)
    await routed('uv', ['tool', 'install', 'saycode-claude-swap==0.27.0b2', '--force'])
    expect(resolver.forget).toHaveBeenCalledTimes(1)
    resolver.get.mockResolvedValueOnce(null as never)
    await routed('cswap', ['--version'])
    expect(run).toHaveBeenLastCalledWith('cswap', ['--version'], undefined)
  })

  it('launches the long-running cswap auto through that Python when it is known', () => {
    expect(claudeSwapLaunch('cswap', ['auto', '--json'], target, { KEEP: '1' })).toEqual({ command: target.python, args: ['-m', 'claude_swap', 'auto', '--json'], env: { KEEP: '1', PYTHONPATH: target.sitePackages } })
    expect(claudeSwapLaunch('cswap', ['auto'], null, { KEEP: '1' })).toEqual({ command: 'cswap', args: ['auto'], env: { KEEP: '1' } })
  })
})

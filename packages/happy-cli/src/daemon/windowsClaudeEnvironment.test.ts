import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyWindowsClaudeDefaults, createWindowsClaudeResolver } from './windowsClaudeEnvironment'

const path = 'C:\\Tools\\Claude\\claude.exe'
const flags = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' }

describe('the installed Windows executable', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'happy-windows-claude-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('checks a native install once and rechecks a replacement after local tool update', async () => {
    const native = join(directory, 'claude.exe')
    await writeFile(native, 'old')
    const verify = vi.fn(async (file: string) => (await readFile(file, 'utf8')) === 'new release')
    const find = createWindowsClaudeResolver(verify)
    const env = { Path: directory }
    expect(await find(env)).toBeUndefined()
    expect(await find(env)).toBeUndefined()
    expect(verify).toHaveBeenCalledTimes(1)
    await writeFile(native, 'new release')
    expect(await Promise.all([find(env), find(env)])).toEqual([await realpath(native), await realpath(native)])
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('resolves the official npm package binary without evaluating the shim or a .js entry', async () => {
    const pkg = join(directory, 'node_modules', '@anthropic-ai', 'claude-code')
    await mkdir(join(pkg, 'bin'), { recursive: true })
    await writeFile(join(directory, 'claude.cmd'), 'this must never execute')
    const entry = join(pkg, 'bin', 'claude.exe')
    await writeFile(entry, '')
    const verify = vi.fn(async () => true)
    const find = createWindowsClaudeResolver(verify)
    const setBin = (bin: string) => writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: bin } }))
    for (const bad of ['../outside.exe', 'bin/cli.js', entry]) {
      await setBin(bad)
      expect(await find({ PATH: directory })).toBeUndefined()
    }
    expect(verify).not.toHaveBeenCalled()
    await setBin('bin/claude.exe')
    expect(await find({ PATH: directory })).toBe(await realpath(entry))
    expect(await find({ PATH: directory, HAPPY_CLAUDE_PATH: 'invalid' })).toBeUndefined()
    expect(verify).toHaveBeenCalledOnce()
  })

  it('prefers the native user installation over a stale shim, even before PATH refresh', async () => {
    const native = join(directory, '.local', 'bin', 'claude.exe')
    await mkdir(join(directory, '.local', 'bin'), { recursive: true })
    await writeFile(native, 'fixture')
    await writeFile(join(directory, 'claude.cmd'), 'stale')
    const find = createWindowsClaudeResolver(async () => true)
    expect(await find({ PATH: directory, USERPROFILE: directory })).toBe(await realpath(native))
  })

  it('falls back if the binary is replaced while Windows checks its signature', async () => {
    const native = join(directory, 'claude.exe')
    await writeFile(native, 'original')
    const find = createWindowsClaudeResolver(async () => { await writeFile(native, 'replacement'); return true })
    expect(await find({ PATH: directory })).toBeUndefined()
  })
})


describe('Windows Claude session environment', () => {
  it('selects a verified Claude for new and resumed children and preserves explicit flag values', async () => {
    const env = { CLAUDE_CODE_USE_POWERSHELL_TOOL: '0', ANTHROPIC_API_KEY: 'fixture' }
    expect(await applyWindowsClaudeDefaults('claude', env, 'win32', async () => path)).toEqual({
      ...flags, ...env, HAPPY_CLAUDE_PATH: path,
    })
    expect(env).not.toHaveProperty('HAPPY_CLAUDE_PATH')
    expect(await applyWindowsClaudeDefaults(undefined, {}, 'win32', async () => path)).toEqual({
      ...flags, HAPPY_CLAUDE_PATH: path,
    })
  })

  it('preserves explicit paths and the bundled fallback when verification fails', async () => {
    const probe = vi.fn(async () => undefined)
    const cases: Record<string, string>[] = [{}, { HAPPY_CLAUDE_PATH: '' }, { HAPPY_CLAUDE_PATH: 'C:\\old\\cli.js' }]
    for (const env of cases) {
      expect(await applyWindowsClaudeDefaults('claude', env, 'win32', probe)).toEqual(env)
    }
  })

  it('skips other agents and platforms without inspecting the filesystem', async () => {
    const probe = vi.fn(async () => path)
    for (const platform of ['darwin', 'linux'] as const) {
      expect(await applyWindowsClaudeDefaults('claude', {}, platform, probe)).toEqual({})
    }
    expect(await applyWindowsClaudeDefaults('codex', {}, 'win32', probe)).toEqual({})
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps the existing SDK on a cold launch when signature verification takes too long', async () => {
    vi.useFakeTimers()
    try {
      const pending = applyWindowsClaudeDefaults('claude', {}, 'win32', () => new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(1000)
      expect(await pending).toEqual({})
    } finally { vi.useRealTimers() }
  })
})

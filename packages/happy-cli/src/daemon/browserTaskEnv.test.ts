import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBrowserTaskEnv } from './browserTaskEnv'

describe('loadBrowserTaskEnv', () => {
  it('loads installer values while explicit environment values win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-browser-env-'))
    const file = join(dir, 'browser-only.env')
    writeFileSync(file, "# managed\nHAPPY_BROWSER_TASK_RUNTIME_URL=http://127.0.0.1:38700\nHAPPY_BROWSER_TASK_HOST_MODE=browser-only\n")
    const env: NodeJS.ProcessEnv = { HAPPY_BROWSER_TASK_HOST_MODE: 'dedicated-host' }
    loadBrowserTaskEnv(env, file)
    expect(env.HAPPY_BROWSER_TASK_RUNTIME_URL).toBe('http://127.0.0.1:38700')
    expect(env.HAPPY_BROWSER_TASK_HOST_MODE).toBe('dedicated-host')
  })

  it('warns on an unreadable file and leaves the environment unchanged', () => {
    const warnings: string[] = []
    const env: NodeJS.ProcessEnv = {}
    loadBrowserTaskEnv(env, '/path/that/does/not/exist', warnings.push.bind(warnings))
    expect(env).toEqual({})
    expect(warnings).toEqual([])
  })

  it('warns when the managed path exists but cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-browser-env-'))
    const file = join(dir, 'unreadable')
    mkdirSync(file)
    const warnings: string[] = []
    const env: NodeJS.ProcessEnv = {}
    loadBrowserTaskEnv(env, file, warnings.push.bind(warnings))
    expect(env).toEqual({})
    expect(warnings).toHaveLength(1)
  })

  it('does not inspect the managed file when a supervisor already provided the runtime URL', () => {
    const warnings: string[] = []
    const env: NodeJS.ProcessEnv = { HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:38700' }
    loadBrowserTaskEnv(env, '/path/that/does/not/exist', warnings.push.bind(warnings))
    expect(warnings).toEqual([])
  })
})

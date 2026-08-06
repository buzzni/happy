import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

import { afterAll, describe, expect, it } from 'vitest'

import { runAutomationScript } from './runAutomationScript'

// macOS의 /var → /private/var symlink 때문에 realpath로 고정해야
// validatePath의 prefix 비교가 안정적이다.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'automation-script-')))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('runAutomationScript', () => {
  it('shouldReturnFullStdoutOnExitZero', async () => {
    const result = await runAutomationScript({
      command: 'printf "line1\\n{\\"wakeAgent\\": false}"',
      cwd: root,
      timeout: 5_000,
      allowedRoot: root,
    })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('line1\n{"wakeAgent": false}')
  })

  it('shouldFailOnNonZeroExitCode', async () => {
    const result = await runAutomationScript({
      command: 'echo partial && exit 3',
      cwd: root,
      timeout: 5_000,
      allowedRoot: root,
    })
    expect(result.ok).toBe(false)
    expect(result.stdout).toContain('partial')
    expect(result.error).toBeTruthy()
  })

  it('shouldRejectCwdOutsideAllowedRoot', async () => {
    const result = await runAutomationScript({
      command: 'echo should-not-run',
      cwd: '/',
      timeout: 5_000,
      allowedRoot: root,
    })
    expect(result.ok).toBe(false)
    expect(result.stdout).toBe('')
    expect(result.error).toContain('outside the working directory')
  })

  it('shouldFailWithTimeoutError', async () => {
    const result = await runAutomationScript({
      command: 'sleep 5',
      cwd: root,
      timeout: 100,
      allowedRoot: root,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Command timed out')
  })
})

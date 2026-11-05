import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServerProcess, StartServerError } from './startServer'

// Tiny Node script used by most tests. Writes $OUT (if set) and sleeps.
// Kept on disk as a file (no -e) so tokenizeCommand does not have to
// handle quoted inline JavaScript.
function writeSleepScript(dir: string, ms: number): string {
  const script = `
const fs = require('fs')
const out = process.env.OUT
if (out) fs.writeFileSync(out, process.env.TEST_VAR || '')
setTimeout(() => process.exit(0), ${ms})
`
  const p = path.join(dir, 'sleep.js')
  writeFileSync(p, script)
  return p
}

// Kill a spawned pid. Used to clean up after the `process stays alive`
// checks so we don't leak 2-second sleepers into parallel test runs.
function kill(pid: number) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

async function waitForFile(filePath: string, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) return false
    await sleep(25)
  }
  return true
}

describe('startServerProcess', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  function mkdir(): string {
    const d = mkdtempSync(path.join(tmpdir(), 'start-server-'))
    dirs.push(d)
    return d
  }

  it('refuses detached spawn before onSpawn when host workspace admission fails', async () => {
    const dir = mkdir()
    const script = writeSleepScript(dir, 0)
    const admitSubprocess = vi.fn(async () => { throw new Error('WORKSPACE_BUSY') })
    const onSpawn = vi.fn()
    const options = { fastFailDelayMs: 50, onSpawn, admitSubprocess }
    await expect(startServerProcess({ command: `node ${script}`, cwd: dir }, options))
      .rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE', message: 'WORKSPACE_BUSY' })
    expect(admitSubprocess).toHaveBeenCalledWith([dir])
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('validates command syntax before asking for host workspace admission', async () => {
    const dir = mkdir()
    const admitSubprocess = vi.fn(async () => undefined)
    const options = { fastFailDelayMs: 50, admitSubprocess }
    await expect(startServerProcess({ command: 'node server.js && echo no', cwd: dir }, options))
      .rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    expect(admitSubprocess).not.toHaveBeenCalled()
  })

  it('awaits host workspace admission before spawning a detached server', async () => {
    const dir = mkdir()
    const script = writeSleepScript(dir, 0)
    let admitted = false
    const admitSubprocess = vi.fn(async () => { await Promise.resolve(); admitted = true })
    const onSpawn = vi.fn(() => { expect(admitted).toBe(true) })
    const options = { fastFailDelayMs: 50, onSpawn, admitSubprocess }
    const { pid } = await startServerProcess({ command: `node ${script}`, cwd: dir }, options)
    expect(onSpawn).toHaveBeenCalledOnce()
    expect(admitSubprocess).toHaveBeenCalledWith([dir])
    kill(pid)
  })

  it('spawns a node process and returns its pid', async () => {
    const dir = mkdir()
    const script = writeSleepScript(dir, 2000)
    const { pid } = await startServerProcess({
      command: `node ${script}`,
      cwd: dir,
    })
    expect(Number.isInteger(pid)).toBe(true)
    // pid must be a live process at the moment we claim success. Sending
    // signal 0 performs the liveness check without delivering a signal.
    expect(() => process.kill(pid, 0)).not.toThrow()
    kill(pid)
  })

  it('injects req.env into the child process environment', async () => {
    const dir = mkdir()
    const script = writeSleepScript(dir, 2000)
    const outPath = path.join(dir, 'out.txt')
    const { pid } = await startServerProcess({
      command: `node ${script}`,
      cwd: dir,
      env: { OUT: outPath, TEST_VAR: 'elastic_id=seen' },
    })
    expect(await waitForFile(outPath)).toBe(true)
    expect(readFileSync(outPath, 'utf-8')).toBe('elastic_id=seen')
    kill(pid)
  })

  it('does not let req.env hand another session to the server', async () => {
    const dir = mkdir()
    const script = path.join(dir, 'probe.js')
    writeFileSync(script, `require('fs').writeFileSync(process.env.OUT, process.env.HAPPY_RECONNECT_SESSION_ID || 'none')`)
    const outPath = path.join(dir, 'out.txt')
    const { pid } = await startServerProcess({
      command: `node ${script}`,
      cwd: dir,
      env: { OUT: outPath, HAPPY_RECONNECT_SESSION_ID: 'other-session' },
    })
    expect(await waitForFile(outPath)).toBe(true)
    expect(readFileSync(outPath, 'utf-8')).toBe('none')
    kill(pid)
  })

  it('rejects with CWD_NOT_FOUND when the working directory is missing', async () => {
    await expect(
      startServerProcess({
        command: 'node server.js',
        cwd: '/definitely/not/a/real/path/xyz-123',
      }),
    ).rejects.toBeInstanceOf(StartServerError)

    await expect(
      startServerProcess({
        command: 'node server.js',
        cwd: '/definitely/not/a/real/path/xyz-123',
      }),
    ).rejects.toMatchObject({ code: 'CWD_NOT_FOUND' })
  })

  it('rejects with INVALID_COMMAND on shell metacharacters', async () => {
    const dir = mkdir()
    await expect(
      startServerProcess({
        command: 'node server.js && echo hi',
        cwd: dir,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
  })

  it('rejects with EXEC_NOT_FOUND when the executable is not on PATH', async () => {
    const dir = mkdir()
    await expect(
      startServerProcess(
        {
          command: 'nonexistent-binary-xyz-123 arg',
          cwd: dir,
        },
        // A small delay gives Node's ChildProcess 'error' event time to fire
        // for ENOENT, which otherwise races with the immediate resolve path.
        { fastFailDelayMs: 50 },
      ),
    ).rejects.toMatchObject({ code: 'EXEC_NOT_FOUND' })
  })

  it('calls onSpawn with the live ChildProcess for tracking', async () => {
    const dir = mkdir()
    const script = writeSleepScript(dir, 2000)
    let tracked: number | null = null
    const { pid } = await startServerProcess(
      {
        command: `node ${script}`,
        cwd: dir,
      },
      {
        onSpawn: (child) => { tracked = child.pid ?? null },
      },
    )
    expect(tracked).toBe(pid)
    kill(pid)
  })
})

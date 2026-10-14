import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { win32 } from 'node:path'

/** claude-swap's own interpreter and the folder that holds its packages. */
export type ClaudeSwapPython = { python: string; sitePackages: string }

export type ClaudeSwapPythonResolver = { get(): Promise<ClaudeSwapPython | null>; peek(): ClaudeSwapPython | null; forget(): void }

/**
 * Windows: claude-swap runs through its uv environment's base python.exe rather than uv's cswap.exe.
 * Each launcher in between (cswap.exe, then the environment's python.exe) cost about 3.5 s a run under
 * security software on a customer PC, while the base interpreter gave the same output in 0.5–0.9 s
 * (2026-10-15, aplus-dev-studio-desktop specs/windows-build-support RE8). It also leaves the tool
 * folder unheld, so a reinstall does not meet a running cswap.exe (os error 5).
 */
export async function findClaudeSwapPython(
  packageName: string,
  env: Record<string, string | undefined>,
  deps: { readFile: (file: string) => Promise<string>; exists: (file: string) => boolean } = { readFile: (file) => readFile(file, 'utf8'), exists: existsSync },
): Promise<ClaudeSwapPython | null> {
  const toolDir = env.UV_TOOL_DIR || (env.APPDATA ? win32.join(env.APPDATA, 'uv', 'tools') : '')
  if (!toolDir) return null
  const environment = win32.join(toolDir, packageName)
  const home = /^home\s*=\s*(.+?)\s*$/m.exec(await deps.readFile(win32.join(environment, 'pyvenv.cfg')).catch(() => ''))?.[1]
  if (!home) return null
  const python = win32.join(home, 'python.exe'), sitePackages = win32.join(environment, 'Lib', 'site-packages')
  return deps.exists(python) && deps.exists(win32.join(sitePackages, 'claude_swap')) ? { python, sitePackages } : null
}

/** Runs `python -m claude_swap --version` once; only an interpreter that answers is used. */
export function verifyClaudeSwapPython(target: ClaudeSwapPython): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(target.python, ['-m', 'claude_swap', '--version'], { env: { ...process.env, PYTHONPATH: target.sitePackages }, timeout: 30_000, windowsHide: true },
      (error, stdout) => resolve(!error && /\d+\.\d+/.test(String(stdout))))
  })
}

/** One verified answer per daemon; synchronous spawns read the settled one, and a reinstall clears it. */
export function createClaudeSwapPythonResolver(deps: {
  platform: NodeJS.Platform
  find: () => Promise<ClaudeSwapPython | null>
  verify: (target: ClaudeSwapPython) => Promise<boolean>
}): ClaudeSwapPythonResolver {
  let pending: Promise<ClaudeSwapPython | null> | null = null
  let settled: ClaudeSwapPython | null = null
  return {
    get() {
      if (deps.platform !== 'win32') return Promise.resolve(null)
      const current = pending ??= deps.find().then(async (target) => target && await deps.verify(target).catch(() => false) ? target : null, () => null)
      return current.then((target) => { if (pending === current) settled = target; return target })
    },
    peek: () => settled,
    forget() { pending = null; settled = null },
  }
}

export function claudeSwapLaunch(command: string, args: string[], target: ClaudeSwapPython | null, env: Record<string, string | undefined>) {
  return command === 'cswap' && target
    ? { command: target.python, args: ['-m', 'claude_swap', ...args], env: { ...env, PYTHONPATH: target.sitePackages } }
    : { command, args, env }
}

/** Routes `cswap` through the resolved Python; an `uv tool install` may replace the environment, so it is looked up again. */
export function routeClaudeSwapThroughPython<O extends { environment?: Record<string, string | undefined> }, R>(
  run: (command: string, args: string[], options?: O) => Promise<R>,
  resolver: ClaudeSwapPythonResolver,
) {
  return async (command: string, args: string[], options?: O): Promise<R> => {
    if (command === 'uv' && args[0] === 'tool' && args[1] === 'install') {
      try { return await run(command, args, options) } finally { resolver.forget() }
    }
    const target = command === 'cswap' ? await resolver.get() : null
    if (!target) return run(command, args, options)
    const base = (options ?? {}) as O
    return run(target.python, ['-m', 'claude_swap', ...args], { ...base, environment: { ...(base.environment ?? process.env), PYTHONPATH: target.sitePackages } })
  }
}

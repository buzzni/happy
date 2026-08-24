/**
 * Routes `happy agent` to the exact Saycode CLI bundled with Happy without
 * entering any provider runtime.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

type AgentCommandDependencies = {
  execPath: string
  env: NodeJS.ProcessEnv
  resolveSaycodeManifest: () => string
  readManifest: (path: string) => string
  run: (
    command: string,
    args: string[],
    options: { stdio: 'inherit'; env: NodeJS.ProcessEnv },
  ) => { status: number | null }
}

const defaultDependencies: AgentCommandDependencies = {
  execPath: process.execPath,
  env: process.env,
  resolveSaycodeManifest: () => createRequire(import.meta.url).resolve('@buzzni/saycode-cli/package.json'),
  readManifest: (path) => readFileSync(path, 'utf8'),
  run: spawnSync,
}

export function handleAgentCommand(
  args: string[],
  dependencies: AgentCommandDependencies = defaultDependencies,
): number {
  const manifestPath = dependencies.resolveSaycodeManifest()
  const manifest = JSON.parse(dependencies.readManifest(manifestPath)) as {
    bin?: { saycode?: unknown }
  }
  const saycodeBin = manifest.bin?.saycode

  if (typeof saycodeBin !== 'string') {
    throw new Error('Bundled @buzzni/saycode-cli does not declare the saycode binary.')
  }

  const entrypoint = resolve(dirname(manifestPath), saycodeBin)
  const result = dependencies.run(
    dependencies.execPath,
    ['--no-warnings', '--no-deprecation', entrypoint, 'agent', ...args],
    { stdio: 'inherit', env: dependencies.env },
  )

  return result.status ?? 1
}

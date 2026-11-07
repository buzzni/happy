import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** uv's tool bin first on PATH: where `uv tool install` puts `cswap` (and its installer puts `uv`). */
export function withUvToolBinOnPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  command: 'uv' | 'cswap' = 'cswap',
): NodeJS.ProcessEnv {
  const toolBin = (command === 'uv' ? environment.UV_INSTALL_DIR : environment.UV_TOOL_BIN_DIR)
    || environment.XDG_BIN_HOME
    || (environment.XDG_DATA_HOME
      ? join(environment.XDG_DATA_HOME, '..', 'bin')
      : join(homeDir, '.local', 'bin'))
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const currentPath = environment[pathKey] ?? ''
  const remainingPath = currentPath
    .split(delimiter)
    .filter((entry) => entry && entry !== toolBin)
  return {
    ...environment,
    [pathKey]: [toolBin, ...remainingPath].join(delimiter),
  }
}

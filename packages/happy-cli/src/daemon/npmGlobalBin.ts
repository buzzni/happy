import { delimiter, dirname, join } from 'node:path'

/** npm's global bin first on PATH: `<prefix>/bin` beside `<prefix>/lib/node_modules`, or the prefix itself on Windows. */
export function withNpmGlobalBinOnPath(
  environment: NodeJS.ProcessEnv,
  globalRoot: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const globalBin = platform === 'win32' ? dirname(globalRoot) : join(dirname(dirname(globalRoot)), 'bin')
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const remainingPath = (environment[pathKey] ?? '').split(delimiter).filter((entry) => entry && entry !== globalBin)
  return { ...environment, [pathKey]: [globalBin, ...remainingPath].join(delimiter) }
}

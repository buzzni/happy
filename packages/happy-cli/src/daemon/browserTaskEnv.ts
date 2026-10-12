import { readFileSync } from 'node:fs'

const DEFAULT_ENV_FILE = '/etc/abp/browser-only.env'
const ALLOWED = new Set([
  'HAPPY_BROWSER_TASK_RUNTIME_URL', 'HAPPY_BROWSER_TASK_BROKER_SOCKET',
  'HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE', 'HAPPY_BROWSER_TASK_TENANCY',
  'HAPPY_BROWSER_TASK_PROFILE_ID', 'HAPPY_BROWSER_TASK_HOST_MODE',
])

/** Load installer-managed browser task variables without overriding explicit process environment. */
export function loadBrowserTaskEnv(
  env: NodeJS.ProcessEnv = process.env,
  file = DEFAULT_ENV_FILE,
  warn: (message: string) => void = (message) => console.warn(message),
): NodeJS.ProcessEnv {
  // A supervisor-provided runtime URL is authoritative. This also avoids a
  // harmless EACCES warning on dedicated hosts where /etc/abp is private.
  if (env.HAPPY_BROWSER_TASK_RUNTIME_URL !== undefined) return env
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`[DAEMON RUN] Browser task environment ${file} is unreadable; browser grants disabled until it is repaired`)
    return env
  }
  for (const [lineNumber, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed)
    if (!match || !ALLOWED.has(match[1])) {
      warn(`[DAEMON RUN] Ignoring invalid browser task environment line ${lineNumber + 1}`)
      continue
    }
    const value = match[2].startsWith("'") && match[2].endsWith("'")
      ? match[2].slice(1, -1).replace(/'\\''/g, "'")
      : match[2].startsWith('"') && match[2].endsWith('"') ? match[2].slice(1, -1) : match[2]
    if (env[match[1]] === undefined) env[match[1]] = value
  }
  return env
}

import { execFile } from 'node:child_process'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const verifyScript = [
  '$p = $env:HAPPY_VERIFY_CLAUDE',
  '$v = (Get-Item -LiteralPath $p -ErrorAction Stop).VersionInfo',
  "if ($v.ProductName -ne 'Claude Code' -or $v.FileVersionRaw -lt [version]'2.1.310.0') { exit 3 }",
  '$sig = Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop',
  "if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.GetNameInfo('SimpleName', $false) -ne 'Anthropic, PBC') { exit 3 }",
].join('; ')

async function verifyClaude(executable: string): Promise<boolean> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  try {
    // Read signed PE metadata. Never execute the candidate, a package script, or an npm shim.
    await exec(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', verifyScript],
      { windowsHide: true, timeout: 60000, maxBuffer: 4096, env: { SystemRoot: systemRoot, HAPPY_VERIFY_CLAUDE: executable } })
    return true
  } catch (error) {
    if ((error as { code?: number }).code === 3) return false
    throw error
  }
}

async function installedClaude(env: Record<string, string>): Promise<string | undefined> {
  if (env.HAPPY_CLAUDE_PATH !== undefined) return env.HAPPY_CLAUDE_PATH
  const path = env.PATH ?? env.Path ?? ''
  const dirs = [...new Set([
    ...path.split(';').map(p => p.trim().replace(/^"(.*)"$/, '$1')),
    env.USERPROFILE && join(env.USERPROFILE, '.local', 'bin'),
    env.ProgramFiles && join(env.ProgramFiles, 'nodejs'),
    env.APPDATA && join(env.APPDATA, 'npm'),
  ].filter(dir => dir && (process.platform === 'win32' ? /^[a-z]:[\\/]/i.test(dir) : isAbsolute(dir))))]
  // As in onboarding, a stale npm shim must not hide the native installation.
  for (const name of ['claude.exe', 'claude.cmd']) {
    const files = await Promise.all(dirs.map(async dir => {
      const file = join(dir, name)
      return await access(file).then(() => true, () => false) ? file : undefined
    }))
    const found = files.find(file => file !== undefined)
    if (!found) continue
    if (name === 'claude.exe') return found
    const root = join(dirname(found), 'node_modules', '@anthropic-ai', 'claude-code')
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude
    if (pkg.name !== '@anthropic-ai/claude-code' || typeof bin !== 'string' || isAbsolute(bin)) return undefined
    // Avoid a PowerShell/signature probe for a known older npm install. PE verification remains authoritative.
    const version = /^2\.1\.(\d+)$/.exec(pkg.version)
    if (version && Number(version[1]) < 310) return undefined
    const entry = resolve(root, bin)
    const rel = relative(root, entry)
    if (!rel || rel === '..' || /^\.\.[\\/]/.test(rel) || isAbsolute(rel)) return undefined
    return entry
  }
  return undefined
}

async function fileIdentity(executable: string): Promise<string | undefined> {
  const info = await stat(executable, { bigint: true })
  return info.isFile() ? [executable, info.dev, info.ino, info.ctimeNs, info.mtimeNs, info.size].join('|') : undefined
}

export function createWindowsClaudeResolver(verify = verifyClaude) {
  let cache: { key: string; result: Promise<boolean> } | undefined
  return async (env: Record<string, string>): Promise<string | undefined> => {
    try {
      const candidate = await installedClaude(env)
      if (!candidate || !isAbsolute(candidate) || !/\.exe$/i.test(candidate) || /^[/\\]{2}/.test(candidate)) return undefined
      const executable = await realpath(candidate)
      if (/^[/\\]{2}/.test(executable)) return undefined
      // Share the signature check across concurrent launches and recheck after a local tool update.
      const key = await fileIdentity(executable)
      if (!key) return undefined
      if (cache?.key !== key) {
        const result = verify(executable).then(async valid => valid && await fileIdentity(executable) === key).catch(error => {
          if (cache?.key === key) cache = undefined
          throw error
        })
        cache = { key, result }
      }
      return await cache.result ? executable : undefined
    } catch {
      return undefined
    }
  }
}

const resolveInstalledClaude = createWindowsClaudeResolver()

export function prewarmWindowsClaude(env: NodeJS.ProcessEnv): void {
  if (process.platform === 'win32') void resolveInstalledClaude(env as Record<string, string>)
}

export async function resolveWindowsClaudeWithinBudget(env: Record<string, string>, find = resolveInstalledClaude): Promise<string | undefined> {
  // Windows may take seconds to verify revocation or scan the PE. Continue with the SDK
  // during a cold check, then use the cached result on the next launch.
  let timeout: NodeJS.Timeout | undefined
  return Promise.race([find(env), new Promise<undefined>(done => {
    timeout = setTimeout(() => done(undefined), 1000)
  })]).finally(() => clearTimeout(timeout))
}

export async function applyWindowsClaudeDefaults(agent: string | undefined, env: Record<string, string>,
  platform = process.platform, find = resolveInstalledClaude): Promise<Record<string, string>> {
  if (platform !== 'win32' || agent !== undefined && agent !== 'claude') return env
  const executable = await resolveWindowsClaudeWithinBudget(env, find)
  if (!executable) return env
  return { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
    ...env, HAPPY_CLAUDE_PATH: env.HAPPY_CLAUDE_PATH ?? executable }
}

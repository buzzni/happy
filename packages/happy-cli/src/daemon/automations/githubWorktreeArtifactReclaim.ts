import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const DAY = 86_400_000
const TARGETS = new Set(['node_modules', '.next', '.vite', '.turbo', 'coverage', 'playwright-report', 'test-results'])
const commandOptions = { timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } }
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep)

export interface ArtifactReclaimReport {
  status: 'reclaimed' | 'preserved' | 'deferred' | 'failed'
  deletedPaths: string[]
  removedDirectoryBytes: number
  availableBytesBefore: number | null
  availableBytesAfter: number | null
  skips: Record<string, number>
  errors: string[]
}

interface Input { repositoryRoot: string; worktreePath: string }
interface Options {
  managedRoot: string
  isDirectoryInUse: (directory: string) => boolean
  readLivePaths?: () => Promise<string[]>
  directoryBytes?: (directory: string) => Promise<number>
  now?: () => number
}

async function git(root: string, ...args: string[]) {
  return (await exec('git', ['-C', root, '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=', ...args], commandOptions)).stdout
}

async function livePaths(): Promise<string[]> {
  if (process.platform === 'win32' || !process.getuid) throw new Error('process inventory unavailable')
  // Full user-owned handles include detached build processes whose cwd moved elsewhere.
  // Failed or incomplete inventories must never be interpreted as an idle machine.
  const { stdout } = await exec('lsof', ['-nP', '-a', '-u', String(process.getuid()), '-Fpn'], commandOptions)
    .catch(() => { throw new Error('process inventory unavailable') })
  const lines = stdout.split('\n')
  if (!lines.some(line => /^p\d+$/.test(line)) || lines.includes('nunknown')
    || /\((?:readlink|stat|read):/.test(stdout)) {
    throw new Error('incomplete process inventory')
  }
  return lines.filter(line => line.startsWith('n/')).map(line => line.slice(1).replace(/ \(deleted\)$/, ''))
}

async function available(path: string) {
  const fs = await statfs(path)
  return fs.bavail * fs.bsize
}

async function registered(input: Input): Promise<string | null> {
  const pointer = await lstat(join(input.worktreePath, '.git'))
  if (!pointer.isFile() || pointer.isSymbolicLink() || input.repositoryRoot === input.worktreePath) {
    throw new Error('automation path is not a linked worktree')
  }
  const entries = (await git(input.repositoryRoot, 'worktree', 'list', '--porcelain')).split('\n\n')
  const entry = entries.find(row => row.split('\n')[0] === `worktree ${input.worktreePath}`)
  if (!entry) throw new Error('automation worktree is not registered in its repository')
  if (entry.split('\n').some(field => field === 'locked' || field.startsWith('locked '))) return 'locked'
  // Older Git does not include the lock in porcelain output.
  const admin = (await git(input.worktreePath, 'rev-parse', '--absolute-git-dir')).trim()
  try { await lstat(join(admin, 'locked')); return 'locked' }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (await realpath((await git(input.worktreePath, 'rev-parse', '--show-toplevel')).trim()) !== input.worktreePath) {
    throw new Error('automation worktree root mismatch')
  }
  const [owner, expected] = await Promise.all([input.worktreePath, input.repositoryRoot].map(async root => (
    realpath(resolve(root, (await git(root, 'rev-parse', '--git-common-dir')).trim()))
  )))
  if (owner !== expected) throw new Error('automation worktree repository mismatch')
  return null
}

async function discover(root: string): Promise<string[]> {
  const targets: string[] = []
  let visited = 0
  async function walk(path: string, depth: number) {
    if (++visited > 4000) throw new Error('artifact discovery budget exceeded')
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.aplus') continue
      const child = join(path, entry.name)
      if (TARGETS.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) targets.push(child)
      else if (depth < 6 && entry.isDirectory() && !entry.isSymbolicLink()) await walk(child, depth + 1)
    }
  }
  await walk(root, 1)
  return targets
}

async function recentRepositoryActivity(root: string, cutoff: number, ownedRootMtime?: number) {
  const admin = (await git(root, 'rev-parse', '--absolute-git-dir')).trim()
  for (const path of [root, ...['HEAD', 'index', 'ORIG_HEAD'].map(name => join(admin, name))]) {
    try {
      const modified = (await stat(path)).mtimeMs
      if (modified > cutoff && !(path === root && modified === ownedRootMtime)) return true
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return false
}

async function protectTarget(root: string, target: string, cutoff: number): Promise<string | null> {
  if (!inside(root, target) || target === root || !TARGETS.has(target.split(sep).at(-1)!)) return 'outside-scope'
  for (let path = target; path !== root; path = dirname(path)) {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) return 'symlink'
  }
  if (await realpath(target) !== target) return 'symlink'
  const owner = await realpath((await git(dirname(target), 'rev-parse', '--show-toplevel')).trim())
  if (!inside(root, owner)) return 'outside-scope'
  const rel = relative(owner, target)
  try { await git(owner, 'check-ignore', '-q', '--', rel) }
  catch (error) {
    if ((error as { code?: unknown }).code === 1) return 'not-ignored'
    throw error
  }
  if ((await git(owner, 'ls-files', '-z', '--', `:(literal)${rel}`)).length) return 'tracked-files'
  const registrations = await git(root, 'worktree', 'list', '--porcelain')
  if (registrations.split('\n').some(field => field.startsWith('worktree ') && inside(target, field.slice(9)))) {
    return 'nested-worktree'
  }
  let visited = 0
  async function inspect(path: string): Promise<string | null> {
    if (++visited > 500_000) throw new Error('artifact inspection budget exceeded')
    const info = await lstat(path)
    if (info.mtimeMs > cutoff) return 'recently-active'
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.git') return 'nested-repository'
      const reason = await inspect(join(path, entry.name))
      if (reason) return reason
    }
    return null
  }
  return inspect(target)
}

async function directoryBytes(path: string) {
  const { stdout } = await exec('du', ['-sk', path], commandOptions)
  const bytes = Number(stdout.trim().split(/\s+/)[0]) * 1024
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid artifact measurement')
  return bytes
}

/** Only the daemon's journal-driven dirty-worktree path calls this; no public path-based delete API. */
export function createGithubArtifactReclaimer(options: Options) {
  const pending = new Map<string, Promise<ArtifactReclaimReport>>()
  const now = options.now ?? Date.now
  const readLivePaths = options.readLivePaths ?? livePaths
  async function reclaim(input: Input): Promise<ArtifactReclaimReport> {
    const report: ArtifactReclaimReport = { status: 'preserved', deletedPaths: [], removedDirectoryBytes: 0,
      availableBytesBefore: null, availableBytesAfter: null, skips: {}, errors: [] }
    const skip = (reason: string) => { report.skips[reason] = (report.skips[reason] ?? 0) + 1 }
    let saveReceipt: (() => Promise<void>) | undefined
    try {
      const root = await realpath(options.managedRoot)
      const path = input.worktreePath
      if (resolve(options.managedRoot) !== root || dirname(path) !== root || !/^[a-f0-9]{24}$/.test(path.split(sep).at(-1)!)
        || await realpath(path) !== path || (await lstat(path)).isSymbolicLink()) {
        throw new Error('unowned automation worktree path')
      }
      const info = await stat(path, { bigint: true })
      const identity = `${info.dev}:${info.ino}`
      const receiptRoot = join(root, '.artifact-reclaim')
      await mkdir(receiptRoot, { recursive: true, mode: 0o700 })
      if ((await lstat(receiptRoot)).isSymbolicLink() || await realpath(receiptRoot) !== receiptRoot) {
        throw new Error('unsafe artifact receipt root')
      }
      const receipt = join(receiptRoot, `${path.split(sep).at(-1)}.json`)
      try {
        const saved = await lstat(receipt)
        if (!saved.isFile() || saved.isSymbolicLink() || saved.size > 64 * 1024) throw new Error('invalid artifact receipt')
        const last = JSON.parse(await readFile(receipt, 'utf8'))
        if (last.version !== 1 || typeof last.identity !== 'string' || !Number.isSafeInteger(last.checkedAt)) {
          throw new Error('invalid artifact receipt')
        }
        if (last.identity === identity && now() - last.checkedAt < DAY) return { ...report, status: 'deferred' }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const record = async () => {
        const temp = `${receipt}.${randomUUID()}.tmp`
        try {
          const { deletedPaths, ...summary } = report
          await writeFile(temp, JSON.stringify({ version: 1, identity, checkedAt: now(),
            report: { ...summary, deletedPathCount: deletedPaths.length } }), { flag: 'wx', mode: 0o600 })
          await rename(temp, receipt)
        } finally { await rm(temp, { force: true }) }
        return report
      }
      const leased = () => options.isDirectoryInUse(path)
      const readPaths = async () => {
        const paths = await readLivePaths()
        if (!paths.length || paths.some(value => typeof value !== 'string' || !isAbsolute(value)
          || /\((?:readlink|stat|read):/.test(value))) {
          throw new Error('invalid process inventory')
        }
        return paths
      }
      const initialProtection = await registered(input)
      saveReceipt = async () => { await record() }
      if (initialProtection) { skip(initialProtection); return await record() }
      if (leased()) { skip('live-session'); return await record() }
      let paths = await readPaths()
      if (paths.some(value => inside(path, value))) { skip('live-process'); return await record() }
      const cutoff = now() - DAY
      if (await recentRepositoryActivity(path, cutoff)) { skip('recently-active'); return await record() }
      let ownedRootMtime = (await stat(path)).mtimeMs
      report.availableBytesBefore = await available(path)
      for (const target of await discover(path)) {
        let reason = await protectTarget(path, target, cutoff)
        if (reason) { skip(reason); continue }
        const bytes = await (options.directoryBytes ?? directoryBytes)(target)
        paths = await readPaths()
        reason = await registered(input)
          ?? (leased() ? 'live-session' : null)
          ?? (paths.some(value => inside(path, value)) ? 'live-process' : null)
          ?? (await recentRepositoryActivity(path, cutoff, ownedRootMtime) ? 'recently-active' : null)
          ?? await protectTarget(path, target, cutoff)
        if (reason) { skip(reason); continue }
        const current = await stat(path, { bigint: true })
        if (`${current.dev}:${current.ino}` !== identity) throw new Error('worktree identity changed')
        await rm(target, { recursive: true })
        report.deletedPaths.push(target)
        report.removedDirectoryBytes += bytes
        // Our own removal changes the root mtime; it is not new user activity.
        ownedRootMtime = (await stat(path)).mtimeMs
      }
      report.availableBytesAfter = await available(path)
      report.status = report.deletedPaths.length ? 'reclaimed' : 'preserved'
      await record()
    } catch (error) {
      report.status = 'failed'
      report.errors.push((error instanceof Error ? error.message : String(error)).slice(0, 2000))
      if (report.availableBytesBefore !== null) report.availableBytesAfter = await available(input.worktreePath).catch(() => null)
      await saveReceipt?.().catch(error => report.errors.push(`receipt failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    return report
  }
  return (input: Input): Promise<ArtifactReclaimReport> => {
    const key = resolve(input.worktreePath)
    const active = pending.get(key)
    if (active) return active
    const job = reclaim(input).finally(() => { if (pending.get(key) === job) pending.delete(key) })
    pending.set(key, job)
    return job
  }
}

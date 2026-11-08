import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import psList from 'ps-list'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readCurrentBootIdSync } from '../utils/bootIdentity'
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const barrierSchema = z.object({ version: z.literal(1), companyId: id, scopeKey: z.string().regex(/^[a-f0-9]{64}$/), managedAccountIds: z.array(id).min(1).max(100), epoch: z.number().int().positive(), challenge: id, requiresRestart: z.boolean().default(false) }).strict()
const stateSchema = z.object({ accounts: z.array(id), scopes: z.record(z.string(), z.object({ epoch: z.number().int().positive(), bootIdentity: z.string() })) })
async function bootIdentity() {
  if (process.platform !== 'win32') return readCurrentBootIdSync()
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks'], { timeout: 10000, windowsHide: true })
  const ticks = result.stdout.trim()
  return /^\d{16,20}$/.test(ticks) ? `win:${ticks}` : undefined
}
/** A missing process inventory is never an empty one. Include orphan CLI/provider processes. */
export async function proveCapacityProcessesStopped() {
  let processes: Array<{ pid: number; name: string; cmd?: string }>
  if (process.platform === 'win32') {
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    const rows = z.array(z.object({ ProcessId: z.number(), Name: z.string(), CommandLine: z.string().nullable() })).parse(JSON.parse(result.stdout))
    processes = rows.map(row => ({ pid: row.ProcessId, name: row.Name, cmd: row.CommandLine ?? undefined }))
  } else processes = await psList()
  if (!processes.some(process => process.pid === globalThis.process.pid)) return false
  return processes.every(row => row.pid === process.pid || !(/node|happy|claude|anthropic/i.test(row.name) && !row.cmd)
    && (!/happy[-_/ .]|claude|anthropic/i.test(`${row.name} ${row.cmd ?? ''}`) || /daemon (start|start-sync)/.test(row.cmd ?? '')))
}
/** Persisted fences force a positive server decision even after daemon restart or policy rollback. */
export function createSetupTokenCapacityFence(deps: { directory: string; machineId: string; proveIdle(): Promise<boolean>; bootIdentity?: () => Promise<string | undefined> }) {
  const path = join(deps.directory, 'capacity-fences.json')
  let tail: Promise<unknown> = Promise.resolve()
  async function read(): Promise<ReturnType<typeof stateSchema.parse>> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      return Array.isArray(value) ? { accounts: z.array(id).parse(value), scopes: {} } : stateSchema.parse(value)
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { accounts: [], scopes: {} }; throw new Error('CAPACITY_FENCE_UNREADABLE') }
  }
  return {
    async fenced(managedAccountId: string) { return (await read()).accounts.includes(managedAccountId) },
    barrier(raw: unknown) {
      const pending = tail.then(async () => {
        const input = barrierSchema.parse(raw)
        const state = await read(), boot = await (deps.bootIdentity ?? bootIdentity)()
        if (!boot) throw new Error('CAPACITY_BOOT_IDENTITY_UNAVAILABLE')
        const previous = state.scopes[input.scopeKey]
        if (previous && previous.epoch > input.epoch) throw new Error('CAPACITY_STALE_POLICY')
        state.accounts = [...new Set([...state.accounts, ...input.managedAccountIds])].sort()
        state.scopes[input.scopeKey] = { epoch: input.epoch, bootIdentity: !previous || input.requiresRestart && previous.epoch < input.epoch ? boot : previous.bootIdentity }
        await mkdir(deps.directory, { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(state)); await file.sync() } finally { await file.close() }
        await rename(temporary, path)
        if (process.platform !== 'win32') {
          const directory = await open(deps.directory, 'r')
          try { await directory.sync() } finally { await directory.close() }
        }
        const rebooted = boot !== state.scopes[input.scopeKey].bootIdentity
        const ready = rebooted && await deps.proveIdle()
        return { version: 1 as const, companyId: input.companyId, machineId: deps.machineId, epoch: input.epoch,
          challenge: input.challenge, fencedAccountIds: input.managedAccountIds, ready,
          ...(!ready ? { reason: rebooted ? 'runtime_exit_required' : 'restart_required' } : {}) }
      })
      tail = pending.catch(() => {}) // a rejected RPC is reported to its caller; a later request may repair the environment
      return pending
    },
  }
}

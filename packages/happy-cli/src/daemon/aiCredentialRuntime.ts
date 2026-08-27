import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  getCodexMultiAuthProxyStatus,
  isManagedCodexRotationSettings,
} from '../codex/codexMultiAuthProxy'

const MAX_PAYLOAD_BYTES = 1024 * 1024
const CLAUDE_SWAP_VERSION = '0.25.0'
const CLAUDE_STATUS_TIMEOUT_MS = 120_000
const CODEX_MULTI_AUTH_VERSION = '2.8.5'
const CODEX_MULTI_AUTH_THRESHOLD = 5

export type AiCredentialProvider = 'claude' | 'codex'

export type TrialAiCredentialLeaseMarker = {
  leaseId: string
  contentHash: string
  bundleVersion: number
}

type TrialAiCredentialMarkerFile = {
  version: 1
  leases: Partial<Record<AiCredentialProvider, TrialAiCredentialLeaseMarker>>
}

export type AiCredentialCommandResult = {
  stdout: string
  stderr: string
}

export type AiCredentialRotationStatus = {
  state: 'stopped' | 'starting' | 'running' | 'needs-reauth' | 'blocked' | 'quota-unknown' | 'not-routed'
  lastErrorKind: string | null
  lastSwitchAt?: string
  activeAccount?: string
  strategy?: 'sequential'
  threshold5h?: number
  threshold7d?: number
}

type CommandOptions = {
  maxOutputBytes?: number
  timeoutMs?: number
}

type Supervisor = {
  enable(): Promise<void>
  stop(): Promise<void>
  status(): AiCredentialRotationStatus
}

export type AiCredentialRuntimeDependencies = {
  homeDir: string
  env: Record<string, string | undefined>
  execFile(command: string, args: string[], options?: CommandOptions): Promise<AiCredentialCommandResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  makeTempDir(): Promise<string>
  supervisor: Supervisor
  codexProxyStatus?: () => { activeRoutes: number }
}

export class AiCredentialRuntimeError extends Error {
  constructor(public readonly kind: string) {
    super(`AI credential operation failed (${kind})`)
  }
}

type CodexQuotaWindow = { usedPercent?: unknown }
type CodexQuotaEntry = { primary?: CodexQuotaWindow; secondary?: CodexQuotaWindow }
type CodexQuotaCache = {
  byAccountId?: Record<string, CodexQuotaEntry>
  byEmail?: Record<string, CodexQuotaEntry>
}
type CodexAccountIdentity = { accountId?: unknown; email?: unknown; enabled?: unknown }

export function selectLeastRemainingCodexAccounts(
  accounts: CodexAccountIdentity[],
  quotaCache: CodexQuotaCache,
  threshold: number,
): { orderedIndexes: number[]; activeIndex: number; quotaKnown: boolean; hasReadyAccount: boolean } {
  const identities = accounts.map((account) => {
    const accountId = typeof account.accountId === 'string' ? nonEmptyTrimmed(account.accountId) : null
    const email = typeof account.email === 'string'
      ? nonEmptyTrimmed(account.email)?.toLowerCase() ?? null
      : null
    return { accountId, email }
  })
  const accountIdCounts = countNonNull(identities.map(({ accountId }) => accountId))
  const emailCounts = countNonNull(identities.map(({ email }) => email))
  const candidates = accounts.map((account, index) => {
    const { accountId, email } = identities[index]!
    const quota = (accountId && accountIdCounts.get(accountId) === 1
      ? quotaCache.byAccountId?.[accountId]
      : undefined)
      ?? (email && emailCounts.get(email) === 1 ? quotaCache.byEmail?.[email] : undefined)
    const remaining = quota ? restrictiveRemainingPercent(quota) : null
    return { index, enabled: account.enabled !== false, remaining }
  })
  const ready = candidates
    .filter((candidate) => candidate.enabled
      && candidate.remaining !== null
      && candidate.remaining > threshold)
    .sort((left, right) => left.remaining! - right.remaining! || left.index - right.index)
  const unknown = candidates.filter((candidate) => candidate.enabled && candidate.remaining === null)
  const unavailable = candidates.filter((candidate) => !candidate.enabled
    || (candidate.remaining !== null && candidate.remaining <= threshold))
  const orderedIndexes = [...ready, ...unknown, ...unavailable].map(({ index }) => index)
  return {
    orderedIndexes,
    activeIndex: 0,
    quotaKnown: unknown.length === 0,
    hasReadyAccount: ready.length > 0,
  }
}

function restrictiveRemainingPercent(entry: CodexQuotaEntry): number | null {
  const used = [entry.primary?.usedPercent, entry.secondary?.usedPercent]
  if (!used.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) {
    return null
  }
  return Math.min(...used.map((value) => Math.max(0, Math.min(100, 100 - value))))
}

export function createAiCredentialRuntime(deps: AiCredentialRuntimeDependencies) {
  let operationTail: Promise<void> = Promise.resolve()

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation)
    operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  function provider(value: unknown): AiCredentialProvider {
    if (value !== 'claude' && value !== 'codex') {
      throw new AiCredentialRuntimeError('UNSUPPORTED_PROVIDER')
    }
    return value
  }

  function assertPayloadSize(payload: string): void {
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new AiCredentialRuntimeError('PAYLOAD_TOO_LARGE')
    }
  }

  function codexHome(): string {
    const configured = deps.env.CODEX_HOME
    return configured && configured.length > 0 ? configured : join(deps.homeDir, '.codex')
  }

  function codexMultiAuthDir(): string {
    const configured = deps.env.CODEX_MULTI_AUTH_DIR
    return configured && configured.length > 0 ? configured : join(codexHome(), 'multi-auth')
  }

  function trialMarkerPath(): string {
    return join(deps.homeDir, '.happy', 'trial-ai-credential-leases.json')
  }

  function trialLease(value: unknown): TrialAiCredentialLeaseMarker {
    if (!isObject(value)
      || typeof value.leaseId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(value.leaseId)
      || typeof value.contentHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.contentHash)
      || !Number.isInteger(value.bundleVersion)
      || Number(value.bundleVersion) < 1) {
      throw new AiCredentialRuntimeError('TRIAL_MARKER_INVALID')
    }
    return {
      leaseId: value.leaseId,
      contentHash: value.contentHash,
      bundleVersion: Number(value.bundleVersion),
    }
  }

  async function readTrialMarker(): Promise<TrialAiCredentialMarkerFile> {
    let raw: string
    try {
      raw = await deps.readFile(trialMarkerPath())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, leases: {} }
      }
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.leases)) {
        throw new Error('invalid marker')
      }
      const leases: TrialAiCredentialMarkerFile['leases'] = {}
      for (const selected of ['claude', 'codex'] as const) {
        if (parsed.leases[selected] !== undefined) {
          leases[selected] = trialLease(parsed.leases[selected])
        }
      }
      if (Object.keys(parsed.leases).some((key) => key !== 'claude' && key !== 'codex')) {
        throw new Error('invalid provider')
      }
      return { version: 1, leases }
    } catch (error) {
      if (error instanceof AiCredentialRuntimeError) throw error
      throw new AiCredentialRuntimeError('TRIAL_MARKER_INVALID')
    }
  }

  async function writeTrialMarker(marker: TrialAiCredentialMarkerFile): Promise<void> {
    await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 })
    await writeAtomicFile(deps, trialMarkerPath(), JSON.stringify(marker))
  }

  async function capture(input: { provider: AiCredentialProvider }) {
    const selected = provider(input?.provider)
    return serialize(() => withSafeErrors(`${selected.toUpperCase()}_CAPTURE_FAILED`, async () => {
      let payload: string
      if (selected === 'claude') {
        const result = await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })
        payload = result.stdout
      } else {
        await assertPinnedCodexMultiAuthInstalled()
        try {
          const accounts = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'openai-codex-accounts.json')))
          const settings = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'settings.json')))
          payload = JSON.stringify({
            version: 1,
            kind: 'codex-multi-auth',
            packageVersion: CODEX_MULTI_AUTH_VERSION,
            accounts,
            settings,
          })
        } catch {
          throw new AiCredentialRuntimeError('CODEX_FILE_STORE_REQUIRED')
        }
      }
      assertPayloadSize(payload)
      return { provider: selected, payload }
    }))
  }

  async function ensureClaudeSwap(): Promise<void> {
    await deps.execFile('uv', ['--version'])
    await deps.execFile('uv', ['python', 'find', '>=3.12'])
    let installed = false
    try {
      const version = await deps.execFile('cswap', ['--version'])
      installed = /^(?:cswap|claude-swap) 0\.25\.0\s*$/.test(version.stdout)
    } catch {
      installed = false
    }
    if (!installed) {
      await deps.execFile('uv', [
        'tool', 'install', `claude-swap==${CLAUDE_SWAP_VERSION}`,
        '--python', '>=3.12', '--force',
      ], { timeoutMs: 300_000 })
    }
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.threshold', '95'])
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first'])
  }

  async function applyClaude(payload: string) {
    await ensureClaudeSwap()
    const tempDir = await deps.makeTempDir()
    const tempFile = join(tempDir, 'claude-swap.json')
    try {
      await deps.writeFile(tempFile, payload, { mode: 0o600 })
      await deps.chmod(tempFile, 0o600)
      await deps.execFile('cswap', ['import', tempFile, '--force'])
    } finally {
      await deps.rm(tempDir, { recursive: true, force: true })
    }
    let status = await deps.execFile('cswap', ['list', '--json'], {
      maxOutputBytes: MAX_PAYLOAD_BYTES,
      timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
    })
    let details = parseClaudeListDetails(status.stdout)
    if (!details.configured) {
      throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
    }
    if (!details.activeUsable) {
      if (details.usableAccountNumber === null) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
      await deps.execFile('cswap', [
        'switch', String(details.usableAccountNumber), '--force', '--json',
      ], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
      status = await deps.execFile('cswap', ['list', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      details = parseClaudeListDetails(status.stdout)
      if (!details.activeUsable) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
    }
    await deps.supervisor.enable()
    return {
      provider: 'claude' as const,
      configured: true,
      rotation: deps.supervisor.status(),
    }
  }

  async function applyCodex(payload: string) {
    const bundle = parseCodexMultiAuthBundle(payload)
    if (bundle) return applyCodexMultiAuth(bundle)
    const home = codexHome()
    const authPath = join(home, 'auth.json')
    const backupPath = join(home, 'auth.json.happy-backup')
    const tempPath = join(home, '.auth.json.happy-tmp')
    await deps.mkdir(home, { recursive: true, mode: 0o700 })
    let hadExisting = false
    try {
      await deps.rename(authPath, backupPath)
      hadExisting = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AiCredentialRuntimeError('CODEX_BACKUP_FAILED')
      }
    }
    if (hadExisting) {
      try {
        await deps.chmod(backupPath, 0o600)
      } catch {
        try {
          await deps.rename(backupPath, authPath)
        } catch {
          throw new AiCredentialRuntimeError('CODEX_BACKUP_RESTORE_FAILED')
        }
        throw new AiCredentialRuntimeError('CODEX_BACKUP_FAILED')
      }
    }
    try {
      await deps.writeFile(tempPath, payload, { mode: 0o600 })
      await deps.chmod(tempPath, 0o600)
      await deps.rename(tempPath, authPath)
      await deps.chmod(authPath, 0o600)
      await deps.execFile('codex', ['login', 'status'])
      try {
        await deps.rm(backupPath, { force: true })
      } catch {
        throw new AiCredentialRuntimeError('CODEX_BACKUP_CLEANUP_FAILED')
      }
    } catch (error) {
      let tempCleanupFailed = false
      try {
        await deps.rm(tempPath, { force: true })
      } catch {
        tempCleanupFailed = true
      }
      let authRemovalFailed = false
      try {
        await deps.rm(authPath, { force: true })
      } catch {
        authRemovalFailed = true
      }
      if (hadExisting) {
        try {
          await deps.rename(backupPath, authPath)
        } catch {
          throw new AiCredentialRuntimeError('CODEX_BACKUP_RESTORE_FAILED')
        }
      } else if (authRemovalFailed) {
        throw new AiCredentialRuntimeError('CODEX_APPLY_ROLLBACK_FAILED')
      } else {
        try {
          await deps.rename(backupPath, authPath)
          await deps.chmod(authPath, 0o600)
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new AiCredentialRuntimeError('CODEX_BACKUP_RESTORE_FAILED')
          }
        }
      }
      if (tempCleanupFailed) {
        throw new AiCredentialRuntimeError('CODEX_APPLY_ROLLBACK_FAILED')
      }
      if (error instanceof AiCredentialRuntimeError) throw error
      throw new AiCredentialRuntimeError('CODEX_APPLY_FAILED')
    }
    return { provider: 'codex' as const, configured: true, status: 'authenticated' as const }
  }

  async function ensureCodexMultiAuth(): Promise<void> {
    const installed = await hasPinnedCodexMultiAuthInstalled()
    if (!installed) {
      await deps.execFile('npm', [
        'install', '--global', `codex-multi-auth@${CODEX_MULTI_AUTH_VERSION}`,
      ], { timeoutMs: 300_000 })
      if (!await hasPinnedCodexMultiAuthInstalled()) {
        throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_VERSION_MISMATCH')
      }
    }
    await deps.execFile('codex', ['--version'])
  }

  async function assertPinnedCodexMultiAuthInstalled(): Promise<void> {
    if (!await hasPinnedCodexMultiAuthInstalled()) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_VERSION_MISMATCH')
    }
  }

  async function hasPinnedCodexMultiAuthInstalled(): Promise<boolean> {
    try {
      const version = await deps.execFile('codex-multi-auth', ['--version'])
      return version.stdout.trim() === CODEX_MULTI_AUTH_VERSION
        && await hasPinnedGlobalCodexMultiAuthPackage()
    } catch {
      return false
    }
  }

  async function hasPinnedGlobalCodexMultiAuthPackage(): Promise<boolean> {
    try {
      const root = nonEmptyTrimmed((await deps.execFile('npm', ['root', '--global'])).stdout)
      if (!root) return false
      const packageJson = JSON.parse(await deps.readFile(join(
        root,
        'codex-multi-auth',
        'package.json',
      ))) as unknown
      return isObject(packageJson) && packageJson.version === CODEX_MULTI_AUTH_VERSION
    } catch {
      return false
    }
  }

  async function applyCodexMultiAuth(bundle: CodexMultiAuthBundle) {
    await ensureCodexMultiAuth()
    const root = codexMultiAuthDir()
    await deps.mkdir(root, { recursive: true, mode: 0o700 })
    await deps.chmod(root, 0o700)
    const settings = enforceCodexRotationSettings(bundle.settings)
    const accountsPath = join(root, 'openai-codex-accounts.json')
    const settingsPath = join(root, 'settings.json')
    const applied = await replaceCodexMultiAuthFiles(deps, [
      { path: accountsPath, content: JSON.stringify(bundle.accounts) },
      { path: settingsPath, content: JSON.stringify(settings) },
    ], async () => {
      await deps.execFile('codex-multi-auth', ['forecast', '--live', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      const currentBundle = parseCodexMultiAuthBundle(JSON.stringify({
        ...bundle,
        accounts: JSON.parse(await deps.readFile(accountsPath)),
      }))
      if (!currentBundle
        || currentBundle.accounts.accounts.length !== bundle.accounts.accounts.length) {
        throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
      }
      const quotaCache = await readCodexQuotaCache(deps, root)
      const selection = selectLeastRemainingCodexAccounts(
        currentBundle.accounts.accounts,
        quotaCache,
        CODEX_MULTI_AUTH_THRESHOLD,
      )
      const orderedAccounts = selection.orderedIndexes
        .map((index) => currentBundle.accounts.accounts[index]!)
      const sorted = {
        ...currentBundle.accounts,
        accounts: orderedAccounts,
        activeIndex: selection.activeIndex,
        activeIndexByFamily: resetActiveIndexes(currentBundle.accounts.activeIndexByFamily),
        pinnedAccountIndex: undefined,
      }
      await writeAtomicFile(deps, accountsPath, JSON.stringify(sorted))
      await deps.execFile('codex-multi-auth', ['check'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      return { selection, accountCount: currentBundle.accounts.accounts.length }
    })
    return {
      provider: 'codex' as const,
      configured: true,
      accountCount: applied.accountCount,
      rotation: codexRotationStatus(
        applied.selection.quotaKnown,
        applied.selection.hasReadyAccount,
      ),
    }
  }

  async function apply(input: {
    provider: AiCredentialProvider
    payload: string
    trialLease?: TrialAiCredentialLeaseMarker
  }) {
    const selected = provider(input?.provider)
    if (typeof input?.payload !== 'string') {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    assertPayloadSize(input.payload)
    return serialize(() => withSafeErrors(
      `${selected.toUpperCase()}_APPLY_FAILED`,
      async () => {
        if (input.trialLease !== undefined) {
          const requestedLease = trialLease(input.trialLease)
          const marker = await readTrialMarker()
          const currentLease = marker.leases[selected]
          if (currentLease && currentLease.leaseId !== requestedLease.leaseId) {
            throw new AiCredentialRuntimeError('TRIAL_LEASE_CONFLICT')
          }
          marker.leases[selected] = requestedLease
          await writeTrialMarker(marker)
        }
        if (selected === 'claude') return applyClaude(input.payload)
        return applyCodex(input.payload)
      },
    ))
  }

  async function purgeManagedProvider(selected: AiCredentialProvider): Promise<void> {
    if (selected === 'claude') {
      await deps.supervisor.stop()
      const claudeConfig = deps.env.CLAUDE_CONFIG_DIR || join(deps.homeDir, '.claude')
      await deps.rm(join(claudeConfig, '.credentials.json'), { force: true })
      await deps.rm(join(deps.homeDir, '.claude-swap'), { recursive: true, force: true })
      await deps.rm(join(deps.homeDir, '.config', 'claude-swap'), { recursive: true, force: true })
      return
    }
    const home = codexHome()
    await deps.rm(join(home, 'auth.json'), { force: true })
    await deps.rm(join(home, 'auth.json.happy-backup'), { force: true })
    await deps.rm(join(home, '.auth.json.happy-tmp'), { force: true })
    await deps.rm(codexMultiAuthDir(), { recursive: true, force: true })
  }

  async function purge(input: { provider: AiCredentialProvider; leaseId: string }) {
    const selected = provider(input?.provider)
    if (typeof input?.leaseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.leaseId)) {
      throw new AiCredentialRuntimeError('TRIAL_MARKER_INVALID')
    }
    return serialize(() => withSafeErrors('TRIAL_PURGE_FAILED', async () => {
      const marker = await readTrialMarker()
      const currentLease = marker.leases[selected]
      if (!currentLease) {
        return { provider: selected, purged: true, alreadyPurged: true }
      }
      if (currentLease.leaseId !== input.leaseId) {
        throw new AiCredentialRuntimeError('TRIAL_LEASE_MISMATCH')
      }
      await purgeManagedProvider(selected)
      delete marker.leases[selected]
      if (Object.keys(marker.leases).length === 0) {
        await deps.rm(trialMarkerPath(), { force: true })
      } else {
        await writeTrialMarker(marker)
      }
      return { provider: selected, purged: true, alreadyPurged: false }
    }))
  }

  async function status(input: { provider: AiCredentialProvider }) {
    const selected = provider(input?.provider)
    return serialize(() => withSafeErrors(`${selected.toUpperCase()}_STATUS_FAILED`, async () => {
      if (selected === 'codex') {
        const root = codexMultiAuthDir()
        const bundle = parseCodexMultiAuthBundle(JSON.stringify({
          version: 1,
          kind: 'codex-multi-auth',
          packageVersion: CODEX_MULTI_AUTH_VERSION,
          accounts: JSON.parse(await deps.readFile(join(root, 'openai-codex-accounts.json'))),
          settings: JSON.parse(await deps.readFile(join(root, 'settings.json'))),
        }))
        if (!bundle) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        await assertPinnedCodexMultiAuthInstalled()
        await deps.execFile('codex-multi-auth', ['check'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        const quotaCache = await readCodexQuotaCache(deps, root)
        const selection = selectLeastRemainingCodexAccounts(
          bundle.accounts.accounts,
          quotaCache,
          CODEX_MULTI_AUTH_THRESHOLD,
        )
        const activeAccount = bundle.accounts.accounts[bundle.accounts.activeIndex]
        const activeRoutes = (deps.codexProxyStatus ?? getCodexMultiAuthProxyStatus)().activeRoutes
        const settingsValid = isManagedCodexRotationSettings(bundle.settings)
        const state = !settingsValid
          ? 'blocked' as const
          : !selection.quotaKnown
            ? 'quota-unknown' as const
            : !selection.hasReadyAccount
              ? 'blocked' as const
              : activeRoutes > 0
                ? 'running' as const
                : 'not-routed' as const
        return {
          provider: selected,
          configured: true,
          accountCount: bundle.accounts.accounts.length,
          ...(typeof activeAccount?.email === 'string'
            ? { activeAccount: maskEmail(activeAccount.email) }
            : {}),
          rotation: {
            ...codexRotationStatus(selection.quotaKnown, selection.hasReadyAccount),
            state,
          },
        }
      }
      const result = await deps.execFile('cswap', ['list', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      const claudeStatus = parseClaudeList(result.stdout)
      return {
        provider: selected,
        ...claudeStatus,
        rotation: deps.supervisor.status(),
      }
    }))
  }

  async function rotation(input: { action: 'start' | 'stop' }) {
    if (input?.action !== 'start' && input?.action !== 'stop') {
      throw new AiCredentialRuntimeError('UNSUPPORTED_ROTATION_ACTION')
    }
    return serialize(() => withSafeErrors('ROTATION_UPDATE_FAILED', async () => {
      if (input.action === 'start') {
        await ensureClaudeSwap()
        await deps.supervisor.enable()
      } else {
        await deps.supervisor.stop()
      }
      return { provider: 'claude' as const, rotation: deps.supervisor.status() }
    }))
  }

  return { capture, apply, purge, status, rotation }
}

type ClaudeListDetails = {
  configured: boolean
  activeAccount: string | null
  activeUsable: boolean
  usableAccountNumber: number | null
}

function parseClaudeListDetails(stdout: string): ClaudeListDetails {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!isObject(parsed)
      || parsed.schemaVersion !== 1
      || !Array.isArray(parsed.accounts)
      || (parsed.activeAccountNumber !== null
        && !Number.isInteger(parsed.activeAccountNumber))) {
      throw new Error('invalid status')
    }
    const accounts: Array<Record<string, unknown>> = []
    for (const account of parsed.accounts) {
      if (!isObject(account)
        || !Number.isInteger(account.number)
        || typeof account.email !== 'string') {
        throw new Error('invalid account')
      }
      accounts.push(account)
    }
    const hasUsageStatus = accounts.some(({ usageStatus }) => typeof usageStatus === 'string')
    const usable = (account: Record<string, unknown>) => account.disabled !== true
      && (!hasUsageStatus || account.usageStatus === 'ok')
    const usableAccount = accounts.find(usable)
    if (parsed.activeAccountNumber === null) {
      return {
        configured: accounts.length > 0,
        activeAccount: null,
        activeUsable: false,
        usableAccountNumber: typeof usableAccount?.number === 'number'
          ? usableAccount.number
          : null,
      }
    }
    const active = accounts.find((account) => account.number === parsed.activeAccountNumber)
    if (!active || typeof active.email !== 'string') {
      throw new Error('active account missing')
    }
    return {
      configured: true,
      activeAccount: maskEmail(active.email),
      activeUsable: usable(active),
      usableAccountNumber: typeof usableAccount?.number === 'number'
        ? usableAccount.number
        : null,
    }
  } catch {
    throw new AiCredentialRuntimeError('CLAUDE_STATUS_INVALID')
  }
}

function parseClaudeList(stdout: string): { configured: boolean; activeAccount: string | null } {
  const { configured, activeAccount } = parseClaudeListDetails(stdout)
  return { configured, activeAccount }
}

type CodexMultiAuthAccount = CodexAccountIdentity & {
  refreshToken: string
  addedAt: number
  lastUsed: number
  [key: string]: unknown
}

type CodexMultiAuthBundle = {
  version: 1
  kind: 'codex-multi-auth'
  packageVersion: typeof CODEX_MULTI_AUTH_VERSION
  accounts: {
    version: 3
    accounts: CodexMultiAuthAccount[]
    activeIndex: number
    activeIndexByFamily?: Record<string, number | undefined>
    pinnedAccountIndex?: number
    [key: string]: unknown
  }
  settings: {
    version: 1
    pluginConfig: Record<string, unknown>
    [key: string]: unknown
  }
}

function parseCodexMultiAuthBundle(payload: string): CodexMultiAuthBundle | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isObject(parsed) || parsed.kind !== 'codex-multi-auth') return null
  if (parsed.version !== 1
    || parsed.packageVersion !== CODEX_MULTI_AUTH_VERSION
    || !isObject(parsed.accounts)
    || parsed.accounts.version !== 3
    || !Array.isArray(parsed.accounts.accounts)
    || parsed.accounts.accounts.length === 0
    || !Number.isInteger(parsed.accounts.activeIndex)
    || Number(parsed.accounts.activeIndex) < 0
    || Number(parsed.accounts.activeIndex) >= parsed.accounts.accounts.length
    || !isObject(parsed.settings)
    || parsed.settings.version !== 1
    || !isObject(parsed.settings.pluginConfig)) {
    throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
  }
  const identities = new Set<string>()
  for (const account of parsed.accounts.accounts) {
    if (!isObject(account)
      || typeof account.refreshToken !== 'string'
      || !nonEmptyTrimmed(account.refreshToken)
      || typeof account.addedAt !== 'number'
      || !Number.isFinite(account.addedAt)
      || typeof account.lastUsed !== 'number'
      || !Number.isFinite(account.lastUsed)) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
    }
    const accountId = typeof account.accountId === 'string'
      ? nonEmptyTrimmed(account.accountId)
      : null
    const email = typeof account.email === 'string'
      ? nonEmptyTrimmed(account.email)?.toLowerCase() ?? null
      : null
    const identity = accountId
      ? `id:${accountId}`
      : email
        ? `email:${email}`
        : `refresh:${account.refreshToken.trim()}`
    if (identities.has(identity)) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
    }
    identities.add(identity)
  }
  return parsed as CodexMultiAuthBundle
}

function enforceCodexRotationSettings(
  settings: CodexMultiAuthBundle['settings'],
): CodexMultiAuthBundle['settings'] {
  return {
    ...settings,
    pluginConfig: {
      ...settings.pluginConfig,
      codexRuntimeRotationProxy: true,
      schedulingStrategy: 'sequential',
      preemptiveQuotaEnabled: true,
      preemptiveQuotaRemainingPercent5h: CODEX_MULTI_AUTH_THRESHOLD,
      preemptiveQuotaRemainingPercent7d: CODEX_MULTI_AUTH_THRESHOLD,
      routingMutex: 'enabled',
      sessionAffinity: false,
      pidOffsetEnabled: false,
    },
  }
}

function resetActiveIndexes(
  indexes: Record<string, number | undefined> | undefined,
): Record<string, number> | undefined {
  if (!indexes) return undefined
  return Object.fromEntries(Object.keys(indexes).map((family) => [family, 0]))
}

function codexRotationStatus(quotaKnown: boolean, hasReadyAccount: boolean) {
  return {
    state: !quotaKnown
      ? 'quota-unknown' as const
      : hasReadyAccount
        ? 'running' as const
        : 'blocked' as const,
    lastErrorKind: null,
    strategy: 'sequential' as const,
    threshold5h: CODEX_MULTI_AUTH_THRESHOLD,
    threshold7d: CODEX_MULTI_AUTH_THRESHOLD,
  }
}

async function readCodexQuotaCache(
  deps: AiCredentialRuntimeDependencies,
  root: string,
): Promise<CodexQuotaCache> {
  try {
    const parsed = JSON.parse(await deps.readFile(join(root, 'quota-cache.json'))) as unknown
    return isObject(parsed) && parsed.version === 1 ? parsed as CodexQuotaCache : {}
  } catch {
    return {}
  }
}

type ManagedCodexFile = { path: string; content: string }

async function replaceCodexMultiAuthFiles<T>(
  deps: AiCredentialRuntimeDependencies,
  files: ManagedCodexFile[],
  verify: () => Promise<T>,
): Promise<T> {
  const backups = new Set<string>()
  const installed = new Set<string>()
  let verified = false
  try {
    for (const file of files) {
      const backup = `${file.path}.happy-backup`
      try {
        await deps.rename(file.path, backup)
        backups.add(file.path)
        await deps.chmod(backup, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    for (const file of files) {
      installed.add(file.path)
      await writeAtomicFile(deps, file.path, file.content)
    }
    const result = await verify()
    verified = true
    for (const path of backups) await deps.rm(`${path}.happy-backup`, { force: true })
    return result
  } catch (error) {
    if (verified) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_BACKUP_CLEANUP_FAILED')
    }
    for (const file of files) {
      await deps.rm(`${file.path}.happy-tmp`, { force: true }).catch(() => undefined)
      await deps.rm(`${file.path}.happy-sort-tmp`, { force: true }).catch(() => undefined)
      if (installed.has(file.path)) {
        await deps.rm(file.path, { force: true }).catch(() => undefined)
      }
    }
    for (const path of backups) {
      try {
        await deps.rename(`${path}.happy-backup`, path)
        await deps.chmod(path, 0o600)
      } catch {
        throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_ROLLBACK_FAILED')
      }
    }
    if (error instanceof AiCredentialRuntimeError) throw error
    throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_APPLY_FAILED')
  }
}

async function writeAtomicFile(
  deps: AiCredentialRuntimeDependencies,
  path: string,
  content: string,
): Promise<void> {
  const tempPath = `${path}.happy-tmp`
  await deps.writeFile(tempPath, content, { mode: 0o600 })
  await deps.chmod(tempPath, 0o600)
  await deps.rename(tempPath, path)
  await deps.chmod(path, 0o600)
}

async function withSafeErrors<T>(kind: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AiCredentialRuntimeError) throw error
    throw new AiCredentialRuntimeError(kind)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyTrimmed(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function countNonNull(values: Array<string | null>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***${email.slice(at)}`
}

export function createNodeAiCredentialRuntime(
  supervisor: Supervisor,
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
) {
  return createAiCredentialRuntime({
    homeDir,
    env,
    execFile: runAiCredentialCommand,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, content, options) => { await writeFile(path, content, options) },
    mkdir,
    rename,
    chmod,
    rm,
    makeTempDir: () => mkdtemp(join(tmpdir(), 'happy-ai-credential-')),
    supervisor,
  })
}

export function runAiCredentialCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
  spawnCommand: typeof spawn = spawn,
): Promise<AiCredentialCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {
      env: command === 'cswap' ? withUvToolBinOnPath() : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const fail = (kind: string) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      child.kill('SIGKILL')
      reject(new AiCredentialRuntimeError(kind))
    }
    const collect = (target: Buffer[]) => {
      let outputBytes = 0
      return (chunk: Buffer) => {
        if (settled) return
        outputBytes += chunk.length
        if (outputBytes > (options.maxOutputBytes ?? MAX_PAYLOAD_BYTES)) {
          fail('COMMAND_OUTPUT_TOO_LARGE')
          return
        }
        target.push(chunk)
      }
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.on('error', () => fail('COMMAND_NOT_AVAILABLE'))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (code !== 0) {
        reject(new AiCredentialRuntimeError('COMMAND_FAILED'))
        return
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    timeout = setTimeout(() => fail('COMMAND_TIMED_OUT'), options.timeoutMs ?? 30_000)
  })
}

export function withUvToolBinOnPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): NodeJS.ProcessEnv {
  const toolBin = environment.UV_TOOL_BIN_DIR
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

export type AiCredentialRuntime = ReturnType<typeof createAiCredentialRuntime>

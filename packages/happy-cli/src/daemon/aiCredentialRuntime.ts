import { createHash } from 'node:crypto'
import { createPersonalProbeScheduler } from './personalProbeScheduler'
import { createTokenProbe, personalProbeSupported, readTokenRuntime } from './tokenProbe'
import { createClaudeCollector, createPermitMeasure, consumeCollectorPermit, collectorVerificationReady, authorizeCollectorRequest } from './claudeCollector'
import { createCredentialGroupSync, type CredentialGroupRequest } from './aiCredentialGroups'
import { createGroupProviderAdapters, groupAccountIdentity, groupPayloadIdentities } from './aiCredentialGroupAdapters'
import { spawn as crossSpawn } from 'cross-spawn'
import { verifyLocalAiAccounts, type VerificationIdentity } from './aiCredentialVerification'
import { mergeCodexAccounts } from './aiCredentialAdditive'
import { probeHappyCodex, type CodexRecoveryProbeResult } from './codexRecoveryProbe'
import { codexStateRecoveryRoot } from '../codex/codexStateRecovery'
import { CODEX_MULTI_AUTH_VERSION, isSupportedCodexMultiAuthVersion, SUPPORTED_CODEX_MULTI_AUTH_VERSION_RANGE } from '../utils/codexMultiAuthVersions'
import { stagingParent } from './stagedCredentialRoot'
import { createClaudeSwapPythonResolver, findClaudeSwapPython, routeClaudeSwapThroughPython, verifyClaudeSwapPython } from './claudeSwapPython'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { logger } from '@/ui/logger'
import { credentialFileLockPath, withCredentialLock } from '@/utils/credentialLock'
import {
  getCodexMultiAuthProxyStatus,
  isManagedCodexRotationSettings,
} from '../codex/codexMultiAuthProxy'
import {
  buildZaiClaudeEnvironment,
  ZAI_CLAUDE_DEFAULT_MODEL,
  ZAI_CLAUDE_MODELS,
  ZAI_CLAUDE_TIMEOUT_MS,
} from '../managed/zaiClaudeEnvironment'
import {
  AI_CREDENTIAL_PROVENANCE_PATH,
  readActiveClaudeProvenance,
  parseClaudeProvenanceInput,
  serializeAppliedClaudeProvenance,
  serializeInvalidatedClaudeProvenance,
} from './aiCredentialProvenance'
import { SETUP_TOKEN_BINDING_ENV, SETUP_TOKEN_SHARED_ACCOUNT_ENV, formatSetupTokenBinding, overlayManagedCredentialEnvironment, type AiAuthSelection, type SetupTokenBinding, type MachineSetupTokenBindingRecord, isMachineSetupTokenBinding } from './sessionEnv'
import { readTrustedStudioOrigin, setupTokenCredentialMatches, type SetupTokenBindingVerifier } from './setupTokenBindingProof'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import { openSetupTokenAssignment, type SetupTokenAssignmentRecipient } from './setupTokenAssignmentWire'
import { HAPPY_AI_AUTH_SOURCE_ENV } from '@/usage/aiAuthSource'
import type { SetupTokenUsageObservation } from './setupTokenAccountSwitch'
import {
  cswapAtLeastPinned, isManagedSetupTokenAccount, managedSetupTokenEmail, managedSetupTokenId, parseCswapVersion, sameManagedSetupToken,
  setupTokenGroupIdentity, setupTokenRuntimeStatus, supportsManagedSetupTokens,
} from './claudeSetupToken'

const MAX_PAYLOAD_BYTES = 1024 * 1024
const CLAUDE_SWAP_PACKAGE = 'saycode-claude-swap'
const CLAUDE_SWAP_VERSION = '0.27.0b3'
/** Windows: the daemon's claude-swap calls and `cswap auto` run through this verified base Python (RE8). */
export const claudeSwapPython = createClaudeSwapPythonResolver({ platform: process.platform, find: () => findClaudeSwapPython(CLAUDE_SWAP_PACKAGE, process.env), verify: verifyClaudeSwapPython })
const CLAUDE_STATUS_TIMEOUT_MS = 120_000
/** Either window at this share means the account is used up; the session tracker's and Studio's rule. */
const SHARED_ACCOUNT_USED_UP_PCT = 95
/** A used-up shared account without a known reset is skipped for one 5-hour window. */
const SHARED_ACCOUNT_UNKNOWN_RESET_MS = 5 * 60 * 60_000
// Keep readable historical bundles separate from supported installed runtimes.
// Bundles from supported runtimes are readable; parseCodexMultiAuthBundle still
// requires the OAuth account v3 / settings v1 contract.
const READABLE_HISTORICAL_CODEX_MULTI_AUTH_BUNDLE_VERSIONS: ReadonlySet<string> = new Set(['2.15.0'])
function isReadableCodexMultiAuthBundleVersion(version: string): boolean {
  return READABLE_HISTORICAL_CODEX_MULTI_AUTH_BUNDLE_VERSIONS.has(version) || isSupportedCodexMultiAuthVersion(version)
}
const CODEX_MULTI_AUTH_THRESHOLD = 5

export type AiCredentialProvider = 'claude' | 'codex' | 'zai'

export type TrialAiCredentialLeaseMarker = {
  leaseId: string
  contentHash: string
  bundleVersion: number
}

type TrialAiCredentialMarkerFile = {
  version: 1
  leases: Partial<Record<AiCredentialProvider, TrialAiCredentialLeaseMarker>>
}

type AiCredentialApplyGenerationFile = {
  version: 1
  generations: Partial<Record<AiCredentialProvider, number>>
}

export type AiCredentialCommandResult = {
  stdout: string
  stderr: string
  exitCode?: number
}

export type AiCredentialRotationStatus = {
  state: 'stopped' | 'starting' | 'running' | 'needs-reauth' | 'blocked' | 'quota-unknown' | 'not-routed' | 'not-applicable'
  lastErrorKind: string | null
  warningKinds?: Array<'ACCOUNT_NEEDS_REAUTH' | 'NO_COMPARISON'>
  lastSwitchAt?: string
  activeAccount?: string
  strategy?: 'sequential'
  threshold5h?: number
  threshold7d?: number
}

type CommandOptions = {
  cwd?: string
  terminateProcessTree?: boolean
  maxOutputBytes?: number
  timeoutMs?: number
  acceptNonZeroExit?: boolean
  environment?: NodeJS.ProcessEnv
  input?: string
  signal?: AbortSignal
}

type Supervisor = {
  enable(): Promise<void>
  stop(): Promise<void>
  status(): AiCredentialRotationStatus
}

export type AiCredentialRuntimeDependencies = {
  probeCodex?: typeof probeHappyCodex
  homeDir: string
  platform?: NodeJS.Platform
  /** Happy machine identity used to bind server-side machine principal mutations. */
  machineId?: string
  now(): number
  env: Record<string, string | undefined>
  execFile(command: string, args: string[], options?: CommandOptions): Promise<AiCredentialCommandResult>
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  makeTempDir(): Promise<string>
  /**
   * Holds the cross-process lock of one third-party credential file (Codex `auth.json`, the
   * codex-multi-auth pool) around a local read-compare-write. The same lock path is taken by
   * Desktop's remote scripts. Never held across a network call (aplus D4 Q-C3).
   */
  lockCredentialFile<T>(path: string, work: () => Promise<T>): Promise<T>
  /** Required only for one-use setup-token binding nonce persistence; missing support fails closed. */
  syncFile?(path: string): Promise<void>
  syncDirectory?(path: string): Promise<void>
  /** Unexpected but non-fatal conditions, e.g. a provenance record that could not be written. */
  warn?(message: string): void
  supervisor: Supervisor
  codexProxyStatus?: () => { activeRoutes: number }
  /** Present only when the daemon has a trusted Studio origin configured. */
  setupTokenBinding?: Pick<SetupTokenBindingVerifier, 'verify' | 'available'>
  /**
   * Saycode specs/setup-token-switch-usage-check — Studio's pick among the accounts this shared PC holds; a move checks a
   * candidate first. The account, null when none is usable, undefined when Studio could not answer.
   */
  sharedChoose?(input: { companyId: string; candidates: Array<{ managedAccountId: string; credentialGeneration: number }>; exclude: string[]; measure: boolean }): Promise<string | null | undefined>
  machineSetupTokenStart?(binding: MachineSetupTokenBindingRecord): Promise<void>
  machineSetupTokenAuthority?(binding: MachineSetupTokenBindingRecord): Promise<void>
  /** Managed account IDs the daemon's running sessions are bound to; a group sync leaves their slots for a later sync. */
  setupTokenAccountsInUse?(): string[]
}

export class AiCredentialRuntimeError extends Error {
  /** 프로브 실패 진단(종료 코드, stderr 마지막 줄). 데몬 로그의 오류 객체에 함께 찍힌다. */
  readonly probe?: { exitCode: number | undefined; stderrTail: string }
  /** 예상하지 못한 실패의 종류만(오류 이름·errno). 메시지는 경로·비밀이 섞일 수 있어 남기지 않는다. */
  failureCause?: string

  constructor(
    public readonly kind: string,
    applyGeneration?: number,
    probe?: { exitCode: number | undefined; stderrTail: string },
  ) {
    super(
      `AI credential operation failed (${kind})`
      + (applyGeneration === undefined ? '' : ` [applyGeneration=${applyGeneration}]`),
    )
    if (probe) this.probe = probe
  }
}

/** An additive Claude apply that imported shared slots but could not activate one: the slots stay, so they keep their provenance. */
class ClaudeActivationError extends AiCredentialRuntimeError {
  constructor(kind: string, readonly importedAccounts: ClaudeListDetails['accounts']) {
    super(kind)
  }
}

const PROBE_STDERR_TAIL_MAX = 200

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return (lines[lines.length - 1] ?? '').slice(0, PROBE_STDERR_TAIL_MAX)
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

/**
 * Outer process bounds for personal/org cswap calls. Collection keeps the provider's own
 * 10 s signed HTTP deadline inside, then persists and returns; 30 s lets a valid completion
 * reach Core before the signed publication grace, and a hung run is killed as a tree.
 * Metadata reads stay at 10 s.
 */
export function cswapCollectorCommandOptions(args: string[]): { timeoutMs: number; maxOutputBytes: number; terminateProcessTree?: true } {
  return args[0] === 'token-runtime' && ['collect', 'collect-org'].includes(args[1] ?? '')
    ? { timeoutMs: 30_000, maxOutputBytes: 65536, terminateProcessTree: true }
    : { timeoutMs: 10_000, maxOutputBytes: 65536 }
}

export function createAiCredentialRuntime(deps: AiCredentialRuntimeDependencies) {
  let operationTail: Promise<void> = Promise.resolve()

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation)
    operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  // Launch steps share this queue with background probes and group sync; log how long a launch waited behind them.
  function serializeLaunch<T>(step: string, operation: () => Promise<T>): Promise<T> {
    const queuedAt = deps.now()
    return serialize(() => {
      logger.debug(`[timing] ai-credential-queue ${step} waited ${deps.now() - queuedAt}ms`)
      return operation()
    })
  }

  function provider(value: unknown): AiCredentialProvider {
    if (value !== 'claude' && value !== 'codex' && value !== 'zai') {
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

  function applyGenerationPath(): string {
    return join(deps.homeDir, '.happy', 'ai-credential-apply-generations.json')
  }

  async function reserveApplyGeneration(
    selected: AiCredentialProvider,
  ): Promise<number> {
    let generations: AiCredentialApplyGenerationFile['generations'] = {}
    try {
      const parsed = JSON.parse(await deps.readFile(applyGenerationPath())) as unknown
      if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.generations)) {
        throw new Error('invalid apply generation file')
      }
      generations = {}
      for (const candidate of ['claude', 'codex', 'zai'] as const) {
        const value = parsed.generations[candidate]
        if (value !== undefined) {
          if (!Number.isSafeInteger(value) || Number(value) < 1) {
            throw new Error('invalid apply generation')
          }
          generations[candidate] = Number(value)
        }
      }
      if (Object.keys(parsed.generations).some((key) => (
        key !== 'claude' && key !== 'codex' && key !== 'zai'
      ))) {
        throw new Error('invalid provider')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AiCredentialRuntimeError('APPLY_GENERATION_INVALID')
      }
    }
    const current = generations[selected] ?? 0
    const now = deps.now()
    const clockGeneration = now * 1000
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(clockGeneration)) {
      throw new AiCredentialRuntimeError('APPLY_GENERATION_INVALID')
    }
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new AiCredentialRuntimeError('APPLY_GENERATION_INVALID')
    }
    const next = Math.max(current + 1, clockGeneration)
    generations[selected] = next
    await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 })
    await writeAtomicFile(deps, applyGenerationPath(), JSON.stringify({
      version: 1,
      generations,
    } satisfies AiCredentialApplyGenerationFile))
    return next
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
      for (const selected of ['claude', 'codex', 'zai'] as const) {
        if (parsed.leases[selected] !== undefined) {
          leases[selected] = trialLease(parsed.leases[selected])
        }
      }
      if (Object.keys(parsed.leases).some((key) => (
        key !== 'claude' && key !== 'codex' && key !== 'zai'
      ))) {
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

  function warnCodexCaptureReadFailure(
    fileName: 'openai-codex-accounts.json' | 'settings.json' | 'auth.json',
    error: unknown,
  ): void {
    const errorCode = (error as NodeJS.ErrnoException | undefined)?.code
    const reason = error instanceof SyntaxError
      ? 'INVALID_JSON'
      : ['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EBUSY', 'EAGAIN'].includes(errorCode ?? '')
        ? errorCode
        : 'READ_FAILED'
    try {
      deps.warn?.(`Codex credential capture could not read ${fileName} (${reason})`)
    } catch {}
  }

  async function capture(input: { provider: AiCredentialProvider; codexRecovery?: boolean }) {
    const selected = provider(input?.provider)
    return serialize(() => withSafeErrors(`${selected.toUpperCase()}_CAPTURE_FAILED`, async () => {
      if (selected === 'zai') {
        throw new AiCredentialRuntimeError('ZAI_CAPTURE_UNSUPPORTED')
      }
      let payload: string
      if (selected === 'claude') {
        const result = await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })
        payload = result.stdout
      } else {
        const packageVersion = await assertSupportedCodexMultiAuthInstalled()
        let accounts: unknown
        const accountsPath = join(codexMultiAuthDir(), 'openai-codex-accounts.json')
        let accountsRaw: string
        try {
          accountsRaw = await deps.readFile(accountsPath)
          accounts = JSON.parse(accountsRaw)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            warnCodexCaptureReadFailure('openai-codex-accounts.json', error)
            throw error
          }
          throw new AiCredentialRuntimeError('CODEX_FILE_STORE_REQUIRED')
        }
        let settings: unknown = { version: 1, pluginConfig: {} }
        try {
          settings = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'settings.json')))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            warnCodexCaptureReadFailure('settings.json', error)
            throw error
          }
        }
        payload = JSON.stringify({
          version: 1,
          kind: 'codex-multi-auth',
          packageVersion,
          accounts,
          settings,
        })
        if (input.codexRecovery !== true) {
          const bundle = parseCodexMultiAuthBundle(payload)
          if (!bundle) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
          const livePath = deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json')
          // The live login only refreshes a pool entry; an unusable auth.json (e.g. mid-rewrite) means none.
          let liveRaw: string | null = null
          let live: Record<string, unknown> | null = null
          try {
            liveRaw = await readOptionalText(deps, livePath)
            live = parseOptionalCredentialJson(liveRaw)
          } catch (error) {
            warnCodexCaptureReadFailure('auth.json', error)
          }
          const tokens = isObject(live?.tokens) ? live.tokens : null
          if (tokens && typeof tokens.account_id === 'string'
            && typeof tokens.access_token === 'string' && typeof tokens.refresh_token === 'string' && tokens.refresh_token) {
            const subject = tokenSubject(tokens.access_token)
            const claims = tokenClaims(tokens.access_token)
            const expiresAt = typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : 0
            const matches = bundle.accounts.accounts.filter(account => account.accountId === tokens.account_id)
            const account = matches.length === 1 ? matches[0] : undefined
            const storedClaims = tokenClaims(account?.accessToken)
            const storedExpiresAt = typeof storedClaims.exp === 'number' && Number.isFinite(storedClaims.exp) ? storedClaims.exp * 1000 : 0
            // A re-login can leave the exported pool behind. Refresh only an existing, exact
            // workspace AND user; never import a different live login or regress a newer pool.
            if (account && subject !== null && subject === tokenSubject(account.accessToken)
              && expiresAt > deps.now() && expiresAt > storedExpiresAt) {
              account.accessToken = tokens.access_token
              account.refreshToken = tokens.refresh_token
              account.expiresAt = expiresAt
              await assertCredentialsUnchanged(deps, [{ path: livePath, expected: liveRaw }, { path: accountsPath, expected: accountsRaw }])
              payload = JSON.stringify(bundle)
            }
          }
        }
      }
      if (selected === 'codex' && input.codexRecovery === true) {
        const bundle = parseCodexMultiAuthBundle(payload)
        if (!bundle) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        const livePath = deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json')
        const raw = await deps.readFile(livePath)
        const live = JSON.parse(raw)
        const tokens = live?.tokens
        if (!isObject(tokens) || ['account_id', 'access_token', 'refresh_token', 'id_token'].some(key => typeof tokens[key] !== 'string' || !tokens[key])) {
          throw new AiCredentialRuntimeError('CODEX_REAUTH_REQUIRED')
        }
        const indexes = bundle.accounts.accounts.map((account, index) => ({ account, index }))
          .filter(({ account }) => account.accountId === tokens.account_id)
        const sameUser = bundle.accounts.accounts.map((account, index) => ({ account, index }))
          .filter(({ account }) => tokenSubject(account.accessToken) !== null && tokenSubject(account.accessToken) === tokenSubject(tokens.access_token))
        const match = indexes.length === 1 ? indexes[0] : sameUser.length === 1 ? sameUser[0] : undefined
        if (!match) throw new AiCredentialRuntimeError('CODEX_ACTIVE_CREDENTIAL_MISMATCH')
        const claims = JSON.parse(Buffer.from(String(tokens.access_token).split('.')[1] || '', 'base64url').toString())
        const active: CodexMultiAuthAccount = { ...match.account, accountId: String(tokens.account_id), accessToken: String(tokens.access_token),
          refreshToken: String(tokens.refresh_token), ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp * 1000 } : {}),
          accountIdSource: 'token', workspaces: undefined, currentWorkspaceIndex: undefined }
        const verified = await verifyLocalAiAccounts(deps, 'codex', [{ accountId: tokens.account_id as string }], [active], { budgetMs: 60_000 })
        if (!verified.accounts[0]?.ok) throw new AiCredentialRuntimeError(
          verified.accounts[0]?.errorKind === 'AUTHENTICATION_FAILED' ? 'CODEX_AUTHENTICATION_FAILED' : 'CODEX_SOURCE_VERIFICATION_FAILED')
        if (await deps.readFile(livePath) !== raw) throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_CHANGED')
        bundle.accounts.accounts[match.index] = active
        bundle.accounts.activeIndex = match.index
        payload = JSON.stringify({ ...bundle, recoveryAuth: {
          auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: live.last_refresh,
          tokens: { account_id: tokens.account_id, access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token },
        } })
      }
      assertPayloadSize(payload)
      return { provider: selected, payload }
    }))
  }

  function tokenSubject(token: unknown): string | null {
    const claims = tokenClaims(token)
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null
  }

  function tokenClaims(token: unknown): Record<string, unknown> {
    try {
      const claims = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString())
      return isObject(claims) ? claims : {}
    } catch { return {} }
  }

  async function repairCodex(input: { provider: 'codex'; payload: string }) {
    if (input?.provider !== 'codex' || typeof input.payload !== 'string') throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    assertPayloadSize(input.payload)
    return serialize(() => withSafeErrors('CODEX_RECOVERY_FAILED', () => retryOnceOnLostRace(async () => {
      const bundle = parseCodexMultiAuthBundle(input.payload)
      const auth = JSON.parse(input.payload).recoveryAuth
      const selected = bundle?.accounts.accounts[bundle.accounts.activeIndex]
      if (!bundle || !selected || selected.enabled === false || !isObject(auth) || !isObject(auth.tokens)
        || typeof auth.tokens.id_token !== 'string' || !auth.tokens.id_token
        || typeof selected.accountId !== 'string' || typeof selected.accessToken !== 'string'
        || auth.tokens.account_id !== selected.accountId || auth.tokens.access_token !== selected.accessToken
        || auth.tokens.refresh_token !== selected.refreshToken) throw new AiCredentialRuntimeError('CODEX_ACTIVE_CREDENTIAL_MISMATCH')
      if ((await readTrialMarker()).leases.codex) throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
      await ensureCodexMultiAuth()
      const root = codexMultiAuthDir()
      await deps.mkdir(root, { recursive: true, mode: 0o700 })
      const accountsPath = join(root, 'openai-codex-accounts.json')
      const settingsPath = join(root, 'settings.json')
      const authPath = deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json')
      let current = bundle.accounts
      const savedRaw = await readOptionalText(deps, accountsPath)
      const saved = parseOptionalCredentialJson(savedRaw)
      if (saved) {
        const local = parseCodexMultiAuthBundle(JSON.stringify({ ...bundle, accounts: saved }))
        if (!local) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        current = local.accounts
      }
      if (!current.accounts.some(account => account.accountId === selected.accountId)) {
        const subject = tokenSubject(selected.accessToken)
        const sameUser = current.accounts.map((account, index) => ({ account, index }))
          .filter(({ account }) => subject !== null && tokenSubject(account.accessToken) === subject)
        if (sameUser.length > 1) throw new AiCredentialRuntimeError('CODEX_ACTIVE_CREDENTIAL_MISMATCH')
        if (sameUser.length === 1) current = { ...current, accounts: current.accounts.map((account, index) => index === sameUser[0]!.index ? { ...selected } : account) }
      }
      const merged = mergeCodexAccounts(current, bundle.accounts)
      const activeIndex = merged.accounts.findIndex(account => account.accountId === selected.accountId)
      if (activeIndex < 0) throw new AiCredentialRuntimeError('CODEX_ACTIVE_CREDENTIAL_MISMATCH')
      merged.accounts[activeIndex] = { ...selected }
      merged.activeIndex = activeIndex
      merged.pinnedAccountIndex = undefined
      merged.activeIndexByFamily = Object.fromEntries(Object.keys(merged.activeIndexByFamily ?? {}).map(family => [family, activeIndex]))
      const previousAuthRaw = await readOptionalText(deps, authPath)
      const previousAuth = parseOptionalCredentialJson(previousAuthRaw)
      const previousSettings = await readOptionalJson(settingsPath)
      const settings = enforceCodexRotationSettings(isObject(previousSettings) && previousSettings.version === 1 && isObject(previousSettings.pluginConfig)
        ? previousSettings as CodexMultiAuthBundle['settings'] : bundle.settings)
      const applyGeneration = await reserveApplyGeneration('codex')
      await replaceCodexMultiAuthFiles(deps, [
        { path: accountsPath, content: JSON.stringify(merged), expected: savedRaw },
        { path: settingsPath, content: JSON.stringify(settings) },
        { path: authPath, content: JSON.stringify(auth), expected: previousAuthRaw },
      ], async () => { await assertCodexLiveAccount(selected) })
      const cwd = await deps.makeTempDir()
      let probe: CodexRecoveryProbeResult
      let stateRecovered = false
      const stateRoot = codexStateRecoveryRoot(codexHome())
      const recoveredState = join(stateRoot, String(applyGeneration))
      try {
        probe = await (deps.probeCodex ?? probeHappyCodex)(cwd)
        // Authentication failures never change state storage. Diagnose a startup timeout by
        // varying only SQLite storage, and retain it only after an actual Happy inference.
        if (!probe.ok && probe.errorKind === 'CODEX_INITIALIZE_TIMEOUT' && !deps.env.CODEX_SQLITE_HOME?.trim()) {
          await deps.mkdir(recoveredState, { recursive: true, mode: 0o700 })
          try {
            probe = await (deps.probeCodex ?? probeHappyCodex)(cwd, undefined, { CODEX_SQLITE_HOME: recoveredState })
            stateRecovered = probe.ok
          } finally {
            if (!stateRecovered) await deps.rm(recoveredState, { recursive: true, force: true })
          }
        }
      }
      finally { await deps.rm(cwd, { recursive: true, force: true }) }
      const liveAfterProbe = await readOptionalJson(authPath)
      if (!isObject(liveAfterProbe?.tokens) || liveAfterProbe.tokens.account_id !== selected.accountId
        || liveAfterProbe.tokens.access_token !== selected.accessToken || liveAfterProbe.tokens.refresh_token !== selected.refreshToken) {
        if (stateRecovered) await deps.rm(recoveredState, { recursive: true, force: true })
        throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_CHANGED')
      }
      if (stateRecovered) await writeAtomicFile(deps, join(stateRoot, 'current.json'), JSON.stringify({ version: 1, generation: applyGeneration }))
      return { provider: 'codex' as const, configured: probe.ok, applyGeneration,
        runtime: { transport: 'happy-app-server' as const, attempts: probe.attempts,
          stateRecovered,
          authChanged: JSON.stringify(previousAuth) !== JSON.stringify(auth),
          rotationChanged: JSON.stringify(previousSettings) !== JSON.stringify(settings) },
        verification: { checkedAt: deps.now(), accounts: [{ account: 1, ok: probe.ok,
          ...(probe.ok ? { model: probe.model } : { errorKind: probe.errorKind }) }] } }
    })))
  }

  async function claudeSwapPython(): Promise<string> {
    try {
      await deps.execFile('uv', ['python', 'find', '>=3.12'])
      return '>=3.12'
    } catch (error) {
      // Windows can refuse uv's minor-version junction (os error 448); use the real patch install.
      const physical = await physicalUvPython()
      if (!physical) throw error
      deps.warn?.('uv Python version link was unusable; using the physical patch installation')
      return physical
    }
  }

  async function physicalUvPython(): Promise<string | null> {
    const root = (await deps.execFile('uv', ['python', 'dir'])).stdout.trim()
    if (!root) return null
    // uv reports its python folder even before it ever installed one there.
    const names = await deps.readdir(root).catch((error: NodeJS.ErrnoException) => { if (error?.code === 'ENOENT') return null; throw error })
    if (!names) return null
    const installs = names
      .map((name) => ({ name, version: /^cpython-3\.(\d+)\.(\d+)-/.exec(name) }))
      .filter((entry) => entry.version && Number(entry.version[1]) >= 12)
      .sort((a, b) => Number(b.version![1]) - Number(a.version![1]) || Number(b.version![2]) - Number(a.version![2]))
    for (const { name } of installs) {
      for (const python of [join(root, name, 'python.exe'), join(root, name, 'bin', 'python3')]) {
        try {
          await deps.execFile(python, ['--version'])
          return python
        } catch {
          // Not this layout or not runnable; try the next candidate.
        }
      }
    }
    return null
  }

  async function installedClaudeSwapVersion(): Promise<string | null> {
    try { return parseCswapVersion((await deps.execFile('cswap', ['--version'])).stdout) } catch { return null }
  }

  async function ensureClaudeSwap(preserveSettings = false): Promise<void> {
    await deps.execFile('uv', ['--version'])
    // A newer installed build is kept: replacing it with the pin would be a silent downgrade.
    if (!cswapAtLeastPinned(await installedClaudeSwapVersion())) {
      // Only an install needs a Python. Desktop installs cswap on its own pinned Windows Python, which uv cannot discover;
      // looking for one before every apply failed every group sync there (2026-10-12 hmrepo, Error:ENOENT).
      const python = await claudeSwapPython()
      await deps.execFile('uv', [
        'tool', 'install', `${CLAUDE_SWAP_PACKAGE}==${CLAUDE_SWAP_VERSION}`,
        '--python', python, '--force',
      ], { timeoutMs: 300_000 })
    }
    if (preserveSettings) return
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.threshold', '95'])
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first'])
  }

  async function setupTokenRuntimeSupported(): Promise<boolean> {
    try {
      return supportsManagedSetupTokens((await deps.execFile('cswap', ['token-runtime', 'capabilities'], {
        maxOutputBytes: 64 * 1024, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout)
    } catch { return false }
  }

  async function applyClaudeAdditive(payload: string, knownCompanyIdentities: Set<string>, groupOwned: ReadonlySet<string> = new Set()) {
    const incoming = claudeImportedAccountIdentities(payload)
    if (!incoming) throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
    let managed: Array<Record<string, unknown> & { email: string }>
    try { managed = JSON.parse(payload).accounts.filter(isManagedSetupTokenAccount) } catch { throw new AiCredentialRuntimeError('INVALID_PAYLOAD') }
    // Unsupported or missing runtimes need action before anything installs or changes.
    if (managed.length > 0 && !await setupTokenRuntimeSupported()) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
    await ensureClaudeSwap(true)
    const list = async () => parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], {
      maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
    })).stdout)
    let before = await list()
    // cswap storage is authoritative for managed metadata. A managed slot is replaced only
    // when this deployment proves it owns the slot; a personal import of the same synthetic
    // email is a conflict, never a silent takeover. --force drops `disabled`, so restore it.
    const exportedAccounts = async () => {
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      if (exported.version !== 1 || exported.encrypted === true || !Array.isArray(exported.accounts)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      return exported.accounts as Array<Record<string, unknown>>
    }
    const owns = (account: Record<string, unknown> & { email: string }) => groupOwned.has(setupTokenGroupIdentity(account.managedAccountId as string))
      || [...knownCompanyIdentities].some(identity => JSON.parse(identity)[0] === account.email)
    // Every ownership and generation check runs before anything is captured, repaired or imported:
    // a refused apply leaves the account pool exactly as it was (specs/claude-setup-token-managed-sync R3).
    const managedInstalled = managed.filter(account => before.accounts.some(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account)))
    let changed: typeof managed = []
    const restored: typeof managed = []
    if (managedInstalled.length > 0) {
      const local = await exportedAccounts()
      changed = managedInstalled.filter(account => !sameManagedSetupToken(local.find(slot => slot.email === account.email), account))
      for (const account of changed) {
        const stored = local.find(slot => slot.email === account.email)
        // This scope installed that managed account (owned) and the slot only lost its managed metadata: restore it.
        if (stored && stored.managedAccountId === undefined && owns(account)) { restored.push(account); continue }
        if (!owns(account) || !stored || stored.managedAccountId !== account.managedAccountId) {
          // Which check refused, without any account detail: the daemon log otherwise cannot tell a takeover attempt
          // from a slot missing in cswap or a changed managed id (2026-10-12 hmrepo).
          const conflict = new AiCredentialRuntimeError('AI_GROUP_CREDENTIAL_CONFLICT')
          conflict.failureCause = !owns(account) ? 'not-owned' : !stored ? 'slot-missing' : 'managed-id-mismatch'
          throw conflict
        }
        const storedGeneration = Number(stored.credentialGeneration)
        if (storedGeneration > Number(account.credentialGeneration)) throw new AiCredentialRuntimeError('AI_GROUP_GENERATION_STALE')
        if (storedGeneration === account.credentialGeneration) throw new AiCredentialRuntimeError('AI_GROUP_GENERATION_CONFLICT')
      }
    }
    const config = await readOptionalJson(deps.env.CLAUDE_CONFIG_DIR
      ? join(deps.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(deps.homeDir, '.claude.json'))
    const liveIdentity = isObject(config?.oauthAccount) ? config.oauthAccount : null
    const unregistered = typeof liveIdentity?.emailAddress === 'string' && !!liveIdentity.emailAddress
      && !before.accounts.some(account => account.email === liveIdentity.emailAddress
        && (account.organizationUuid ?? '') === (liveIdentity.organizationUuid ?? ''))
    // A live login on a managed setup-token account is the group's own slot, never a personal account to keep: capturing
    // it drops the managed metadata and every later apply refuses the slot (2026-10-12 hmrepo).
    const liveManaged = typeof liveIdentity?.emailAddress === 'string' && managedSetupTokenId(liveIdentity.emailAddress) !== null
    if (!liveManaged && (unregistered || before.activeAccountNumber === null)) {
      // Secure storage may be redirected independently; an explicitly empty override means the default home.
      const credentialHome = deps.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? deps.env.CLAUDE_CONFIG_DIR
      const live = await readOptionalJson(join(credentialHome || join(deps.homeDir, '.claude'), '.credentials.json'))
      // Windows has no macOS Keychain fallback. ENOENT alone proves this is only a stale identity;
      // unreadable/malformed/existing stores still require capture, as do explicit environment credentials.
      const staleWindowsIdentity = (deps.platform ?? process.platform) === 'win32' && live === null
        && !['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(key => deps.env[key])
      if ((unregistered && !staleWindowsIdentity) || isObject(live?.claudeAiOauth)) {
        await deps.execFile('cswap', ['add'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        before = await list()
        if (before.activeAccountNumber === null) throw new AiCredentialRuntimeError('AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED')
      }
    }
    const envelope = JSON.parse(payload)
    let repairRequestedAccountCount = 0
    const repairedIdentities = new Set<string>()
    // Managed setup-token slots are replaced by generation below; they never take the inference repair path.
    const duplicates: Array<Record<string, unknown> & { email: string }> = envelope.accounts.filter((account: { email: string }) =>
      managedSetupTokenId(account.email) === null && before.accounts.some(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account) && local.disabled !== true))
    if (duplicates.length > 0) {
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      if (exported.version !== 1 || exported.encrypted === true || !Array.isArray(exported.accounts)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      const identities = (accounts: Array<Record<string, unknown> & { email: string }>) => accounts.map(account => ({
        email: account.email, organizationUuid: typeof account.organizationUuid === 'string' ? account.organizationUuid : '',
      }))
      // Authentication failure is the only proof that permits replacing a duplicate.
      // Quota, transport, missing credentials and exhausted budgets keep it untouched.
      const localVerification = await verifyLocalAiAccounts(deps, 'claude', identities(duplicates), exported.accounts, { budgetMs: 60_000 })
      const invalid = duplicates.filter((_account, index) => localVerification.accounts[index]?.errorKind === 'AUTHENTICATION_FAILED')
        .map(account => ({ ...account, disabled: before.accounts.find(local =>
          claudeListAccountIdentity(local) === claudeListAccountIdentity(account))?.disabled }))
      if (invalid.length > 0) {
        repairRequestedAccountCount = invalid.length
        const requested = identities(invalid)
        const verification = await verifyLocalAiAccounts(deps, 'claude', requested, invalid, { budgetMs: 60_000 })
        let accepted = invalid.filter((_account, index) => verification.accounts[index]?.ok)
        if (accepted.length > 0) {
          const current = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
          if (current.version !== 1 || current.encrypted === true || !Array.isArray(current.accounts)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
          // A login or refresh during the probes wins over the older failed snapshot.
          for (const [index, account] of invalid.entries()) {
            const find = (accounts: Array<{ email: string; credentials?: unknown; config?: unknown }>) => accounts.find(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account))
            const original = find(exported.accounts), latest = find(current.accounts)
            if (!original || !latest || JSON.stringify([original.credentials, original.config]) !== JSON.stringify([latest.credentials, latest.config])) {
              verification.accounts[index] = { account: index + 1, ok: false, errorKind: 'LOCAL_ACCOUNT_CHANGED' }
            }
          }
          accepted = invalid.filter((_account, index) => verification.accounts[index]?.ok)
        }
        if (accepted.length > 0) {
          const repaired = await applyClaudeRepair({ before, envelope: { ...envelope, accounts: accepted }, requested, verification, automatic: true }, { budgetMs: 60_000 })
          for (const account of repaired?.verifiedAccounts ?? []) {
            repairedIdentities.add(claudeListAccountIdentity(account))
            knownCompanyIdentities.add(JSON.stringify([account.email, account.organizationUuid ?? '', account.organizationName ?? '']))
          }
        }
      }
    }
    // Probes can span rotation ticks and user changes; preserve the latest state
    // even when an automatic repair was skipped before any credential write.
    if (duplicates.length > 0) before = await list()
    const existing = new Set(before.accounts.map(claudeListAccountIdentity))
    // Existing slots that were not proven invalid remain outside the import,
    // which also preserves their local disabled metadata.
    envelope.accounts = envelope.accounts.filter((account: { email: string }) => !existing.has(claudeListAccountIdentity(account)))
    if (envelope.accounts.length > 0) {
      const tempDir = await deps.makeTempDir()
      const file = join(tempDir, 'claude-swap.json')
      try {
        await deps.writeFile(file, JSON.stringify(envelope), { mode: 0o600 })
        await deps.chmod(file, 0o600)
        await deps.execFile('cswap', ['import', file])
      } finally {
        await deps.rm(tempDir, { recursive: true, force: true })
      }
    }
    const managedExisting = managed.filter(account => existing.has(claudeListAccountIdentity(account)))
    // Slots removed and imported again to restore their managed metadata: prior slot number -> current one.
    const renumbered = new Map<number, number>()
    const expectedNumber = (number: number) => renumbered.get(number) ?? number
    if (managedExisting.length > 0) {
      // Checked above against the pool before anything changed; only slots still installed are replaced in place.
      changed = changed.filter(account => managedExisting.includes(account))
      const restoring = restored.filter(account => changed.includes(account))
      const importAccounts = async (accounts: typeof changed, force: boolean) => {
        const tempDir = await deps.makeTempDir()
        const file = join(tempDir, 'claude-swap.json')
        try {
          await deps.writeFile(file, JSON.stringify({ ...envelope, accounts }), { mode: 0o600 })
          await deps.chmod(file, 0o600)
          await deps.execFile('cswap', ['import', file, ...(force ? ['--force'] : [])])
        } finally {
          await deps.rm(tempDir, { recursive: true, force: true })
        }
      }
      const replaced = changed.filter(account => !restoring.includes(account))
      if (replaced.length > 0) await importAccounts(replaced, true)
      if (restoring.length > 0) {
        // cswap refuses any import that would make a bare slot of that email managed, --force included ('managed
        // identity conflict', 2026-10-12 hmrepo: every apply failed as COMMAND_FAILED). Remove the bare slot, import it again.
        for (const account of restoring) {
          const prior = before.accounts.find(slot => claudeListAccountIdentity(slot) === claudeListAccountIdentity(account))
          if (prior) await deps.execFile('cswap', ['remove', String(prior.number)], { input: 'y\n', timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        }
        await importAccounts(restoring, false)
      }
      if (changed.length > 0) {
        const current = await list()
        for (const account of changed) {
          const prior = before.accounts.find(slot => claudeListAccountIdentity(slot) === claudeListAccountIdentity(account))
          const slot = current.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))
          if (!prior || !slot) continue
          if (prior.number !== slot.number) renumbered.set(prior.number, slot.number)
          if (prior.disabled === true && slot.disabled !== true) {
            await deps.execFile('cswap', ['disable', String(slot.number)], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
          }
        }
        // A restored slot that was active stays active under whatever number the import gave it.
        if (before.activeAccountNumber !== null && restoring.some(account => before.accounts.find(slot => slot.number === before.activeAccountNumber
          && claudeListAccountIdentity(slot) === claudeListAccountIdentity(account))) && current.activeAccountNumber !== expectedNumber(before.activeAccountNumber)) {
          await deps.execFile('cswap', ['switch', String(expectedNumber(before.activeAccountNumber)), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        }
      }
      for (const account of managedExisting.filter(owns)) knownCompanyIdentities.add(JSON.stringify([account.email, '', '']))
    }
    let after = await list()
    if (managed.length > 0) {
      // Presence is not enough: ID, generation, label and credential must all be this payload's.
      const local = await exportedAccounts()
      if (managed.some(account => !sameManagedSetupToken(local.find(slot => slot.email === account.email), account))) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
    }
    // Only newly imported slots are proven organizational material. Matching
    // personal credentials were deliberately not overwritten by this import.
    const sharedAccounts = (details: ClaudeListDetails) => details.accounts.filter(account => incoming.has(claudeListAccountIdentity(account)) && (!existing.has(claudeListAccountIdentity(account)) || knownCompanyIdentities.has(JSON.stringify([account.email, account.organizationUuid ?? '', account.organizationName ?? '']))))
    const present = new Set(after.accounts.map(claudeListAccountIdentity))
    if ([...existing, ...incoming].some(identity => !present.has(identity))
      || before.accounts.some(account => {
        const retained = after.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))
        return retained?.number !== expectedNumber(account.number) || retained?.disabled !== account.disabled
      })) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
    if (before.activeAccountNumber !== null) {
      if (after.activeAccountNumber !== expectedNumber(before.activeAccountNumber)) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
    } else {
      // Nothing personal is active to keep. Like a replace, activate a usable account rather than report
      // "configured" while Claude Code stays signed out (a fresh Windows PC, 2026-10-02).
      const imported = sharedAccounts(after)
      try {
        // A stored setup-token is activatable without readable usage; its usage scope is a separate state.
        const setupToken = (details: ClaudeListDetails) => details.accounts.find(account => account.number === details.activeAccountNumber
          && account.disabled !== true && managed.some(incomingAccount => incomingAccount.email === account.email))
        const target = after.activeAccountNumber !== null && (after.activeUsable || after.activeCredentialKind === 'api_key' || setupToken(after))
          ? after.activeAccountNumber
          : after.usableAccountNumber ?? after.accounts.find(account => account.disabled !== true
            && managed.some(incomingAccount => incomingAccount.email === account.email))?.number ?? null
        if (target === null) throw new AiCredentialRuntimeError(claudeNoUsableAccountKind(after))
        await deps.execFile('cswap', ['switch', String(target), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        after = await list()
        if (!after.activeUsable && after.activeCredentialKind !== 'api_key' && !setupToken(after)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      } catch (error) {
        // The imported slots stay on the machine, so a failed activation must not leave them unattributed.
        throw new ClaudeActivationError(error instanceof AiCredentialRuntimeError ? error.kind : 'CLAUDE_APPLY_FAILED', imported)
      }
    }
    return {
      result: { provider: 'claude' as const, configured: true, ...claudeAccountHealth(after),
        repairedAccountCount: repairedIdentities.size,
        credentialRepairFailedAccountCount: repairRequestedAccountCount - repairedIdentities.size,
        rotation: deps.supervisor.status() },
      verifiedAccounts: sharedAccounts(after),
    }
  }

  async function prepareClaudeRepair(payload: string) {
    if (!claudeImportedAccountIdentities(payload)) throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    await ensureClaudeSwap(true)
    const before = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], {
      maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
    })).stdout)
    const envelope = JSON.parse(payload)
    const requested: Array<{ email: string; organizationUuid: string }> = envelope.accounts.map((account: { email: string; organizationUuid?: string }) => ({
      email: account.email, organizationUuid: account.organizationUuid ?? '',
    }))
    // The explicit repair may replace a matching personal identity, as approved
    // by the user. Other identities and locally disabled slots stay untouched.
    const candidates = envelope.accounts.filter((account: { email: string }) =>
      before.accounts.some(existing => claudeListAccountIdentity(existing) === claudeListAccountIdentity(account)))
      .map((account: { email: string }) => ({ ...account, disabled: before.accounts.find(existing =>
        claudeListAccountIdentity(existing) === claudeListAccountIdentity(account))?.disabled === true }))
    const verification = await verifyLocalAiAccounts(deps, 'claude', requested, candidates)
    const accepted = envelope.accounts.filter((_account: unknown, index: number) => verification.accounts[index]?.ok)
      .map((account: { email: string }) => ({ ...account, disabled: before.accounts.find(existing =>
        claudeListAccountIdentity(existing) === claudeListAccountIdentity(account))?.disabled }))
    if (accepted.length === 0) {
      // Keep request rejection reasons observable without exposing identities or provider output.
      deps.warn?.(`Claude repair preflight rejected: ${JSON.stringify(verification.accounts.map(({ account, ok, errorKind }) => ({ account, ok, errorKind })))}`)
      throw new AiCredentialRuntimeError('CLAUDE_APPLY_RELOGIN_REQUIRED')
    }
    return { before, envelope: { ...envelope, accounts: accepted }, requested, verification }
  }

  async function applyClaudeRepair(prepared: Awaited<ReturnType<typeof prepareClaudeRepair>> & { automatic?: boolean }, verificationOptions?: { budgetMs: number }) {
    const list = async () => parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], {
      maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
    })).stdout)
    const { before, envelope, requested, verification } = prepared
    const restoreRotation = deps.supervisor.status().state !== 'stopped'
    let rotationStopped = false
    const tempDir = await deps.makeTempDir()
    let after: ClaudeListDetails
    let installed: Awaited<ReturnType<typeof verifyLocalAiAccounts>>
    let accounts = verification.accounts
    try {
      if (restoreRotation) {
        await deps.supervisor.stop()
        rotationStopped = true
      }
      const current = await list()
      const changed = current.activeAccountNumber !== before.activeAccountNumber || before.accounts.some(account => {
        const retained = current.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))
        return retained?.number !== account.number || retained?.disabled !== account.disabled
      }) || (prepared.automatic && envelope.accounts.some((account: { email: string }) =>
        before.accounts.find(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account))?.usageStatus === 'relogin_required'
        && current.accounts.find(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account))?.usageStatus !== 'relogin_required'))
      if (changed) {
        if (prepared.automatic) return null
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
      const file = join(tempDir, 'claude-swap.json')
      await deps.writeFile(file, JSON.stringify(envelope), { mode: 0o600 })
      await deps.chmod(file, 0o600)
      await deps.execFile('cswap', ['import', file, '--force'])
      const repairedIdentities = new Set(envelope.accounts.map(claudeListAccountIdentity))
      const active = before.accounts.find(account => account.number === before.activeAccountNumber)
      if (active && repairedIdentities.has(claudeListAccountIdentity(active))) {
        // Import repairs the backup only. The selected slot's live credential
        // must be restored without backing its broken login over that backup.
        await deps.execFile('cswap', ['switch', String(active.number), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
      }
      after = await list()
      if (after.activeAccountNumber !== before.activeAccountNumber || before.accounts.some(account => {
        const retained = after.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))
        return retained?.number !== account.number || retained?.disabled !== account.disabled
      })) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      if (exported.version !== 1 || exported.encrypted === true || !Array.isArray(exported.accounts)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      const acceptedIndices = requested.flatMap((_identity, index) => verification.accounts[index]?.ok ? [index] : [])
      installed = await verifyLocalAiAccounts(deps, 'claude', acceptedIndices.map(index => requested[index]!), exported.accounts.map((account: { email: string }) => ({
        ...account, disabled: after.accounts.find(existing => claudeListAccountIdentity(existing) === claudeListAccountIdentity(account))?.disabled === true,
      })), verificationOptions)
      accounts = verification.accounts.map((account, index) => account.ok
        ? { ...installed.accounts[acceptedIndices.indexOf(index)]!, account: index + 1 } : account)
      if (!accounts.some(account => account.ok)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
    } finally {
      try { await deps.rm(tempDir, { recursive: true, force: true }) }
      finally { if (rotationStopped) await deps.supervisor.enable() }
    }
    return {
      result: { provider: 'claude' as const, configured: true, ...claudeAccountHealth(after),
        verification: { checkedAt: installed.checkedAt, accounts }, rotation: deps.supervisor.status() },
      verifiedAccounts: after.accounts.filter(account => requested.some((identity, index) => accounts[index]?.ok
        && claudeListAccountIdentity(account) === claudeListAccountIdentity(identity))),
    }
  }

  async function applyClaude(payload: string) {
    await purgeManagedProvider('zai')
    const apiKeyTargetEmail = claudeApiKeyTargetEmail(payload)
    const importedAccountIdentities = claudeImportedAccountIdentities(payload)
    const verifyImportedAccounts = (details: ClaudeListDetails) => {
      if (importedAccountIdentities === null) return
      const remainingIdentities = new Set(details.accounts.map(claudeListAccountIdentity))
      if (details.accounts.length !== importedAccountIdentities.size
        || remainingIdentities.size !== importedAccountIdentities.size
        || [...importedAccountIdentities].some((identity) => !remainingIdentities.has(identity))) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
    }
    if (importedAccountIdentities !== null) await deps.supervisor.stop()
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
    if (importedAccountIdentities !== null) {
      const previousAccounts = details.accounts.filter((account) => (
        !importedAccountIdentities.has(claudeListAccountIdentity(account))
      ))
      for (const account of previousAccounts) {
        await deps.execFile('cswap', ['remove', String(account.number)], {
          input: 'y\n',
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
      }
      if (previousAccounts.length > 0) {
        status = await deps.execFile('cswap', ['list', '--json'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        details = parseClaudeListDetails(status.stdout)
      }
      verifyImportedAccounts(details)
      const active = details.accounts.find((account) => (
        account.number === details.activeAccountNumber && account.disabled !== true
      ))
      if (active) {
        // Import replaces the stored backup, not the live credential (including
        // macOS Keychain). Even an "ok" or "relogin_required" active slot still
        // describes the old login. Force activation skips backing that login
        // up over the imported credential; use the resolved local slot number.
        await deps.execFile('cswap', [
          'switch', String(active.number), '--force', '--json',
        ], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        status = await deps.execFile('cswap', ['list', '--json'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        details = parseClaudeListDetails(status.stdout)
        verifyImportedAccounts(details)
        if (details.activeAccountNumber !== active.number) {
          throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
        }
      }
    }
    if (apiKeyTargetEmail !== null) {
      let target = details.accounts.find((account) => (
        account.email === apiKeyTargetEmail
        && account.usageStatus === 'api_key'
        && account.disabled !== true
      ))
      if (!target) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      const targetNumber = target.number
      if (details.activeAccountNumber !== targetNumber) {
        await deps.execFile('cswap', [
          'switch', String(targetNumber), '--force', '--json',
        ], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        status = await deps.execFile('cswap', ['list', '--json'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        details = parseClaudeListDetails(status.stdout)
        verifyImportedAccounts(details)
        target = details.accounts.find((account) => (
          account.email === apiKeyTargetEmail
          && account.usageStatus === 'api_key'
          && account.disabled !== true
        ))
        if (!target || details.activeAccountNumber !== target.number) {
          throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
        }
      }
      return {
        result: {
          provider: 'claude' as const,
          configured: true,
          credentialKind: 'api_key' as const,
          rotation: apiKeyRotationStatus(),
        },
        verifiedAccounts: importedAccountIdentities === null ? null : details.accounts,
      }
    }
    // Only once the list is verified to be exactly the imported bundle can
    // "every enabled account needs login" be blamed on the bundle itself.
    const noUsableAccountKind = (current: ClaudeListDetails) => {
      if (importedAccountIdentities === null) return 'CLAUDE_APPLY_VERIFICATION_FAILED'
      const enabled = current.accounts.filter((account) => account.disabled !== true)
      return enabled.length > 0 && enabled.every((account) => account.usageStatus === 'relogin_required')
        ? 'CLAUDE_APPLY_RELOGIN_REQUIRED'
        : 'CLAUDE_APPLY_VERIFICATION_FAILED'
    }
    if (!details.activeUsable) {
      if (details.usableAccountNumber === null) {
        throw new AiCredentialRuntimeError(noUsableAccountKind(details))
      }
      await deps.execFile('cswap', [
        'switch', String(details.usableAccountNumber), '--force', '--json',
      ], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
      status = await deps.execFile('cswap', ['list', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      details = parseClaudeListDetails(status.stdout)
      verifyImportedAccounts(details)
      if (!details.activeUsable) {
        throw new AiCredentialRuntimeError(noUsableAccountKind(details))
      }
    }
    await deps.supervisor.enable()
    return {
      result: {
        provider: 'claude' as const,
        configured: true,
        rotation: deps.supervisor.status(),
      },
      // What cswap holds after the import, checked against the payload's
      // accounts. `null` when the payload's accounts could not be identified.
      verifiedAccounts: importedAccountIdentities === null ? null : details.accounts,
    }
  }

  async function applyCodex(payload: string, applyMode: 'merge' | 'replace' = 'replace') {
    const bundle = parseCodexMultiAuthBundle(payload)
    if (bundle) return retryOnceOnLostRace(() => applyCodexMultiAuth(bundle, applyMode))
    if (applyMode === 'merge') throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
    const home = codexHome()
    const authPath = join(home, 'auth.json')
    const backupPath = join(home, 'auth.json.happy-backup')
    const tempPath = join(home, '.auth.json.happy-tmp')
    await deps.mkdir(home, { recursive: true, mode: 0o700 })
    // Desktop's remote scripts swap this file under the same lock; hold it for the whole local replace.
    return deps.lockCredentialFile(authPath, async () => {
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
    })
  }

  async function ensureCodexMultiAuth(): Promise<void> {
    const installed = await supportedCodexMultiAuthInstalled()
    if (!installed) {
      await deps.execFile('npm', [
        'install', '--global', `codex-multi-auth@${CODEX_MULTI_AUTH_VERSION}`,
      ], { timeoutMs: 300_000 })
      if (!await supportedCodexMultiAuthInstalled()) {
        throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_VERSION_MISMATCH')
      }
    }
    await deps.execFile('codex', ['--version'])
  }

  async function assertSupportedCodexMultiAuthInstalled(): Promise<string> {
    const installed = await inspectCodexMultiAuthInstallation()
    if (isSupportedCodexMultiAuthVersion(installed.cli) && installed.cli === installed.global) return installed.cli
    const error = new AiCredentialRuntimeError('CODEX_MULTI_AUTH_VERSION_MISMATCH')
    error.message += ` [codex-multi-auth installed=${installed.cli} global=${installed.global} supported=${SUPPORTED_CODEX_MULTI_AUTH_VERSION_RANGE}]`
    throw error
  }

  async function supportedCodexMultiAuthInstalled(): Promise<string | null> {
    const installed = await inspectCodexMultiAuthInstallation()
    return isSupportedCodexMultiAuthVersion(installed.cli) && installed.cli === installed.global ? installed.cli : null
  }

  async function inspectCodexMultiAuthInstallation(): Promise<{ cli: string; global: string }> {
    const installed = { cli: 'unknown', global: 'unknown' }
    const safeVersion = (value: unknown): string => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : 'unknown'
    try {
      installed.cli = safeVersion((await deps.execFile('codex-multi-auth', ['--version'])).stdout.trim())
    } catch {
      // Preserve unknown for the diagnostic; never include command output or secrets.
    }
    try {
      const root = nonEmptyTrimmed((await deps.execFile('npm', ['root', '--global'])).stdout)
      if (root) {
        const packageJson = JSON.parse(await deps.readFile(join(root, 'codex-multi-auth', 'package.json'))) as unknown
        installed.global = isObject(packageJson) ? safeVersion(packageJson.version) : 'unknown'
      }
    } catch {
      // Missing/unreadable global metadata is a failed compatibility check.
    }
    return installed
  }

  async function readOptionalJson(path: string): Promise<Record<string, unknown> | null> {
    return parseOptionalCredentialJson(await readOptionalText(deps, path))
  }

  async function applyCodexMultiAuth(bundle: CodexMultiAuthBundle, applyMode: 'merge' | 'replace') {
    await ensureCodexMultiAuth()
    const root = codexMultiAuthDir()
    await deps.mkdir(root, { recursive: true, mode: 0o700 })
    await deps.chmod(root, 0o700)
    const settings = enforceCodexRotationSettings(bundle.settings)
    const accountsPath = join(root, 'openai-codex-accounts.json')
    const settingsPath = join(root, 'settings.json')
    if (applyMode === 'merge') {
      let current = bundle
      let savedSettings: CodexMultiAuthBundle['settings'] = { version: 1, pluginConfig: {} }
      // What this merge read; every pool write below is compared against it under the lock.
      let poolRaw = await readOptionalText(deps, accountsPath)
      if (poolRaw !== null) {
        current = parseCodexMultiAuthBundle(JSON.stringify({ ...bundle, accounts: JSON.parse(poolRaw) }))!
        if (!current) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
      }
      const livePath = deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json')
      const liveRaw = await readOptionalText(deps, livePath)
      const live = parseOptionalCredentialJson(liveRaw)
      if (live) {
        const tokens = isObject(live.tokens) ? live.tokens : null
        if (!tokens || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
          || typeof tokens.access_token !== 'string' || !tokens.access_token) {
          throw new AiCredentialRuntimeError('AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED')
        }
        const claims = (token: unknown): Record<string, unknown> => {
          try { const parsed = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString()); return isObject(parsed) ? parsed : {} } catch { return {} }
        }
        const access = claims(tokens.access_token), id = claims(tokens.id_token)
        const auth = id['https://api.openai.com/auth'] || access['https://api.openai.com/auth']
        const accountId = tokens.account_id || (isObject(auth) ? auth.chatgpt_account_id : null)
        if (typeof accountId !== 'string' || !accountId) throw new AiCredentialRuntimeError('AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED')
        const candidate: CodexMultiAuthAccount = {
          accountId, refreshToken: tokens.refresh_token, accessToken: tokens.access_token,
          ...(typeof (id.email || access.email) === 'string' ? { email: String(id.email || access.email) } : {}),
          ...(typeof access.exp === 'number' ? { expiresAt: access.exp * 1000 } : {}),
          addedAt: deps.now(), lastUsed: deps.now(),
        }
        // Capture first, before importing any shared material. A fresh pool starts on the live identity.
        const personalPool = poolRaw !== null ? mergeCodexAccounts(current.accounts, { ...bundle.accounts, accounts: [candidate] })
          : { version: 3 as const, activeIndex: 0, accounts: [candidate] }
        current = { ...bundle, accounts: personalPool }
        // The captured entry copies the live refresh token: if Codex refreshed it meanwhile, the copy is stale.
        await replaceCodexMultiAuthFiles(deps, [{ path: accountsPath, content: JSON.stringify(personalPool), expected: poolRaw }], async () => {
          if (await deps.readFile(accountsPath) !== JSON.stringify(personalPool)) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        }, [{ path: livePath, expected: liveRaw }])
        poolRaw = JSON.stringify(personalPool)
      }
      try {
        savedSettings = JSON.parse(await deps.readFile(settingsPath))
        if (!isObject(savedSettings) || savedSettings.version !== 1 || !isObject(savedSettings.pluginConfig)) {
          throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const identity = (account: CodexMultiAuthAccount): VerificationIdentity => typeof account.accountId === 'string' && account.accountId
        ? { accountId: account.accountId } : { email: typeof account.email === 'string' ? account.email : undefined }
      const matching = (account: CodexMultiAuthAccount, other: CodexMultiAuthAccount) => account.accountId
        ? account.accountId === other.accountId : account.email === other.email
      const duplicates = bundle.accounts.accounts.filter(incoming => current.accounts.accounts.some(local => matching(local, incoming)
        && local.enabled !== false && (local.accessToken !== incoming.accessToken || local.refreshToken !== incoming.refreshToken)))
      const localCheck = await verifyLocalAiAccounts(deps, 'codex', duplicates.map(identity), current.accounts.accounts, { budgetMs: 60_000 })
      const invalid = duplicates.filter((_account, index) => localCheck.accounts[index]?.errorKind === 'AUTHENTICATION_FAILED')
      const sharedCheck = await verifyLocalAiAccounts(deps, 'codex', invalid.map(identity), invalid, { budgetMs: 60_000 })
      const accepted = invalid.filter((_account, index) => sharedCheck.accounts[index]?.ok)
      const refreshed = { ...current.accounts, accounts: current.accounts.accounts.map(local => {
        const incoming = accepted.find(account => matching(local, account))
        return incoming ? { ...local, refreshToken: incoming.refreshToken, accessToken: incoming.accessToken,
          expiresAt: incoming.expiresAt } : local
      }) }
      const repairedActive = accepted.some(account => {
        const active = current.accounts.accounts[current.accounts.activeIndex]
        return active && matching(active, account) && !!live && isObject(live.tokens) && live.tokens.account_id === active.accountId
      })
      const merged = mergeCodexAccounts(refreshed, bundle.accounts)
      // A refresh/login performed while probing wins over our older snapshot: the write below compares the pool
      // under its lock and, if it moved, the whole merge runs once more from a fresh read.
      await replaceCodexMultiAuthFiles(deps, [
        { path: accountsPath, content: JSON.stringify(merged), expected: poolRaw },
        { path: settingsPath, content: JSON.stringify(savedSettings) },
      ], async () => {
        if (await deps.readFile(accountsPath) !== JSON.stringify(merged)
          || await deps.readFile(settingsPath) !== JSON.stringify(savedSettings)) {
          throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        }
      })
      if (repairedActive) {
        // Refresh the same live identity, never switch a valid personal login to another account.
        await deps.execFile('codex-multi-auth', ['switch', String(merged.activeIndex + 1)], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        // Read what the switch left and write it back under one lock hold, so nothing lands in between.
        await deps.lockCredentialFile(accountsPath, async () => {
          const selected = JSON.parse(await deps.readFile(accountsPath)) as CodexMultiAuthBundle['accounts']
          await assertCodexLiveAccount(selected.accounts[merged.activeIndex]!)
          await writeAtomicFile(deps, accountsPath, JSON.stringify({ ...merged, accounts: selected.accounts }))
        })
      }
      return { provider: 'codex' as const, configured: true, accountCount: merged.accounts.length }
    }
    const applied = await replaceCodexMultiAuthFiles(deps, [
      { path: accountsPath, content: JSON.stringify(bundle.accounts) },
      { path: settingsPath, content: JSON.stringify(settings) },
    ], async (ownWrite) => {
      await deps.execFile('codex-multi-auth', ['forecast', '--live', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      // `forecast --live` may refresh pool tokens. Sort what it left, reading and writing under one lock hold
      // so a refresh is never sorted away; the network call above stays outside the lock.
      const quotaCache = await readCodexQuotaCache(deps, root)
      const sortedPool = await deps.lockCredentialFile(accountsPath, async () => {
        const currentBundle = parseCodexMultiAuthBundle(JSON.stringify({
          ...bundle,
          accounts: JSON.parse(await deps.readFile(accountsPath)),
        }))
        if (!currentBundle
          || currentBundle.accounts.accounts.length !== bundle.accounts.accounts.length) {
          throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        }
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
        const sortedContent = JSON.stringify(sorted)
        ownWrite(accountsPath, sortedContent)
        await writeAtomicFile(deps, accountsPath, sortedContent)
        return { selection, accountCount: currentBundle.accounts.accounts.length }
      })
      await deps.execFile('codex-multi-auth', ['check'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      return sortedPool
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

  function zaiEnvironmentPath(): string {
    return join(deps.homeDir, '.happy', 'zai-claude-env.json')
  }

  function parseZaiPayload(payload: string): Record<string, string> {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new AiCredentialRuntimeError('ZAI_PAYLOAD_INVALID')
    }
    if (!isObject(parsed)
      || parsed.version !== 1
      || parsed.kind !== 'zai-anthropic'
      || typeof parsed.apiKey !== 'string'
      || !/^[\x21-\x7e]{1,1024}$/.test(parsed.apiKey)) {
      throw new AiCredentialRuntimeError('ZAI_PAYLOAD_INVALID')
    }
    return buildZaiClaudeEnvironment(parsed.apiKey)
  }

  function parseZaiEnvironment(raw: string): Record<string, string> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new AiCredentialRuntimeError('ZAI_ENV_INVALID')
    }
    if (!isObject(parsed)) throw new AiCredentialRuntimeError('ZAI_ENV_INVALID')
    const values = Object.values(parsed)
    // ANTHROPIC_MODEL was added after machines were already running, and the
    // file on disk is only rewritten on the next apply. Rejecting the older
    // six-key form would invalidate the Z.AI credential of every machine
    // between this CLI landing and that apply, so both shapes are accepted —
    // such a session still reaches the flash default through the per-path
    // fallbacks. The key set stays closed either way: an extra key is still
    // rejected, so this file cannot smuggle arbitrary env into a session.
    const hasDefaultModel = 'ANTHROPIC_MODEL' in parsed
    if (Object.keys(parsed).length !== (hasDefaultModel ? 7 : 6)
      || values.some((value) => typeof value !== 'string')
      || parsed.ANTHROPIC_BASE_URL !== 'https://api.z.ai/api/anthropic'
      || parsed.API_TIMEOUT_MS !== ZAI_CLAUDE_TIMEOUT_MS
      || (hasDefaultModel && parsed.ANTHROPIC_MODEL !== ZAI_CLAUDE_DEFAULT_MODEL)
      || parsed.ANTHROPIC_DEFAULT_OPUS_MODEL !== ZAI_CLAUDE_MODELS.opus
      || parsed.ANTHROPIC_DEFAULT_SONNET_MODEL !== ZAI_CLAUDE_MODELS.sonnet
      || parsed.ANTHROPIC_DEFAULT_HAIKU_MODEL !== ZAI_CLAUDE_MODELS.haiku
      || typeof parsed.ANTHROPIC_AUTH_TOKEN !== 'string'
      || !/^[\x21-\x7e]{1,1024}$/.test(parsed.ANTHROPIC_AUTH_TOKEN)) {
      throw new AiCredentialRuntimeError('ZAI_ENV_INVALID')
    }
    return parsed as Record<string, string>
  }

  function isAuthenticatedZaiProbe(raw: string): boolean {
    try {
      const parsed = JSON.parse(raw) as unknown
      return isObject(parsed)
        && typeof parsed.result === 'string'
        && parsed.result.trim() === 'CLAUDE_AUTH_OK'
    } catch {
      return false
    }
  }

  function isRejectedZaiAuthentication(probe: AiCredentialCommandResult): boolean {
    const stderrLines = probe.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const diagnostic = stderrLines[stderrLines.length - 1] ?? ''
    return /\b401\b|\bunauthorized\b|authentication[_ -]*error|invalid[_ -]*api[_ -]*key/i
      .test(diagnostic)
  }

  async function applyZai(payload: string) {
    const environment = parseZaiPayload(payload)
    await purgeManagedProvider('claude')
    await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 })
    await writeAtomicFile(deps, zaiEnvironmentPath(), JSON.stringify(environment))
    return { provider: 'zai' as const, configured: true, accountCount: 1 }
  }

  function provenancePath(): string {
    return join(deps.homeDir, AI_CREDENTIAL_PROVENANCE_PATH)
  }

  /**
   * Bookkeeping for the observed-source check. A failure here must never fail
   * the apply itself — the credential is already in place — so it is reported
   * and swallowed. The generation fence keeps an unwritten record harmless.
   */
  async function writeClaudeProvenance(content: string): Promise<void> {
    try {
      await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 })
      await writeAtomicFile(deps, provenancePath(), content)
    } catch (error) {
      deps.warn?.(`[ai-credential] could not write the Claude provenance record: ${
        error instanceof Error ? error.message : String(error)
      }`)
    }
  }

  async function recordClaudeProvenance(
    input: { trialLease?: unknown; provenance?: unknown },
    applyGeneration: number,
    verifiedAccounts: ClaudeListDetails['accounts'] | null,
  ): Promise<void> {
    if (input.trialLease !== undefined) return
    const provenance = parseClaudeProvenanceInput(input.provenance)
    if (!provenance || !verifiedAccounts || verifiedAccounts.length === 0) return
    // Taken from cswap's own list after the import, not from the payload: the
    // organization name is what the login metadata and accountInfo() will
    // report, and the payload's copy of it was never checked.
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    const identities = new Set(verifiedAccounts.map((account) => JSON.stringify([
      account.email,
      text(account.organizationUuid),
      text(account.organizationName),
    ])))
    await writeClaudeProvenance(serializeAppliedClaudeProvenance({
      ...provenance,
      generation: applyGeneration,
      identities,
    }))
  }

  async function requestedActivation(input: { provider: AiCredentialProvider; payload: string; activeAccountIndex?: number }) {
    if (input.activeAccountIndex === undefined) return null
    const parsed = JSON.parse(input.payload)
    const accounts = input.provider === 'claude' ? parsed.accounts : parsed.accounts?.accounts
    const index = input.activeAccountIndex
    if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(accounts) || index >= accounts.length) {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    const account = accounts[index]
    const requested: VerificationIdentity = input.provider === 'claude'
      ? { email: account.email, organizationUuid: account.organizationUuid ?? '' }
      : account.accountId ? { accountId: account.accountId } : { email: account.email }
    const verification = await verifyLocalAiAccounts(deps, input.provider as 'claude' | 'codex', [requested], [account], { budgetMs: 60_000 })
    if (!verification.accounts[0]?.ok) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
    return requested
  }

  async function assertCodexLiveAccount(account: CodexMultiAuthAccount) {
    const live = await readOptionalJson(deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json'))
    if (!isObject(live?.tokens) || typeof account.accountId !== 'string' || live.tokens.account_id !== account.accountId
      || typeof account.accessToken !== 'string' || live.tokens.access_token !== account.accessToken) {
      throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
    }
  }

  async function activateInstalledAccount(selected: 'claude' | 'codex', identity: VerificationIdentity) {
    if (selected === 'claude') {
      const before = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'])).stdout)
      const account = before.accounts.find(item => item.email === identity.email && (item.organizationUuid ?? '') === (identity.organizationUuid ?? ''))
      if (!account || account.disabled) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      const verified = await verifyLocalAiAccounts(deps, selected, [identity], exported.accounts, { budgetMs: 60_000 })
      if (!verified.accounts[0]?.ok) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      try {
        await deps.execFile('cswap', ['switch', String(account.number), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        const after = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'])).stdout)
        if (after.activeAccountNumber !== account.number) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      } catch (error) {
        if (before.activeAccountNumber !== null) await deps.execFile('cswap', ['switch', String(before.activeAccountNumber), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS }).catch(() => undefined)
        throw error
      }
    } else {
      const path = join(codexMultiAuthDir(), 'openai-codex-accounts.json')
      const before = JSON.parse(await deps.readFile(path)) as CodexMultiAuthBundle['accounts']
      const livePath = deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json')
      let previousLive: string | null = null
      try { previousLive = await deps.readFile(livePath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const index = before.accounts.findIndex(account => identity.accountId ? account.accountId === identity.accountId : account.email === identity.email)
      if (index < 0 || before.accounts[index]?.enabled === false) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      const verified = await verifyLocalAiAccounts(deps, selected, [identity], before.accounts, { budgetMs: 60_000 })
      if (!verified.accounts[0]?.ok) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      try {
        await deps.execFile('codex-multi-auth', ['switch', String(index + 1)], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        const after = JSON.parse(await deps.readFile(path))
        if (after.activeIndex !== index) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
        await assertCodexLiveAccount(after.accounts[index])
      } catch (error) {
        await deps.execFile('codex-multi-auth', ['switch', String(before.activeIndex + 1)], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS }).catch(() => undefined)
        await writeAtomicFile(deps, path, JSON.stringify(before))
        if (previousLive !== null) await writeAtomicFile(deps, livePath, previousLive)
        else await deps.rm(livePath, { force: true })
        throw error
      }
    }
  }

  async function apply(input: {
    provider: AiCredentialProvider
    payload: string
    trialLease?: TrialAiCredentialLeaseMarker
    applyMode?: 'merge' | 'replace' | 'repair'
    activeAccountIndex?: number
    /** Sent only by the org deployment: which company bundle this is. */
    provenance?: unknown
  }) {
    if (input?.provider === 'claude') cancelPersonal()
    const selected = provider(input?.provider)
    if (typeof input?.payload !== 'string') {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    assertPayloadSize(input.payload)
    const applyMode = input.applyMode ?? 'replace'
    if (applyMode !== 'merge' && applyMode !== 'replace' && applyMode !== 'repair') throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    if (input.activeAccountIndex !== undefined && (applyMode !== 'merge' || selected === 'zai')) throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    if (applyMode === 'repair' && (selected !== 'claude' || input.trialLease !== undefined || !parseClaudeProvenanceInput(input.provenance))) {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    if (applyMode === 'merge' && (input.trialLease !== undefined || selected === 'zai')) {
      throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
    }
    return serialize(() => withSafeErrors(
      `${selected.toUpperCase()}_APPLY_FAILED`,
      async () => {
        if (applyMode === 'merge' || applyMode === 'repair') {
          const marker = await readTrialMarker()
          if (marker.leases[selected] || (selected === 'claude' && marker.leases.zai)) {
            throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
          }
        }
        // Verify incoming repair material before advancing the apply fence:
        // rejected source credentials never invalidate the installed provenance.
        const activation = await requestedActivation(input)
        const repair = applyMode === 'repair' ? await prepareClaudeRepair(input.payload) : null
        const previousProvenance = selected === 'claude' && applyMode === 'merge'
          ? await readActiveClaudeProvenance({ homeDir: deps.homeDir, readFile: deps.readFile })
          : null
        const incomingProvenance = parseClaudeProvenanceInput(input.provenance)
        const knownCompanyIdentities = previousProvenance && incomingProvenance
          && previousProvenance.companyId === incomingProvenance.companyId
          ? previousProvenance.identities : new Set<string>()
        // A manual/legacy apply can supersede managed slots. Never use an old group receipt as proof.
        let touched: string[] | null = null
        if (applyMode === 'merge' && selected !== 'zai') { try { touched = groupPayloadIdentities(selected, input.payload) } catch {} }
        await groups.invalidate(selected === 'zai' ? 'claude' : selected, touched)
        const applyGeneration = await reserveApplyGeneration(selected)
        // A Claude record is only believed for the current claude generation.
        // A Claude apply just bumped it; a Z.AI apply purges the Claude login,
        // so it bumps it too — the fence then holds even if the explicit
        // invalidation below cannot be written.
        if (selected === 'zai') await reserveApplyGeneration('claude')
        if (selected === 'claude' || selected === 'zai') {
          await writeClaudeProvenance(serializeInvalidatedClaudeProvenance(applyGeneration))
        }
        let requestedLease: TrialAiCredentialLeaseMarker | undefined
        let marker: TrialAiCredentialMarkerFile | undefined
        let previousLease: TrialAiCredentialLeaseMarker | undefined
        let markerChanged = false
        try {
          if (input.trialLease !== undefined) {
            requestedLease = trialLease(input.trialLease)
            marker = await readTrialMarker()
            const currentLease = marker.leases[selected]
            if (currentLease && currentLease.leaseId !== requestedLease.leaseId) {
              throw new AiCredentialRuntimeError('TRIAL_LEASE_CONFLICT')
            }
            const conflictingClaudeRuntime = selected === 'zai'
              ? marker.leases.claude
              : selected === 'claude'
                ? marker.leases.zai
                : undefined
            if (conflictingClaudeRuntime) {
              throw new AiCredentialRuntimeError('TRIAL_LEASE_CONFLICT')
            }
            previousLease = currentLease
            marker.leases[selected] = requestedLease
            await writeTrialMarker(marker)
            markerChanged = true
          }
          const claudeApplied = selected === 'claude'
            ? await (repair ? applyClaudeRepair(repair) : applyMode === 'merge' ? applyClaudeAdditive(input.payload, knownCompanyIdentities) : applyClaude(input.payload))
            : null
          const result = claudeApplied
            ? claudeApplied.result
            : selected === 'zai'
              ? await applyZai(input.payload)
              : await applyCodex(input.payload, applyMode === 'merge' ? 'merge' : 'replace')
          if (!requestedLease) {
            const nonTrialMarker = await readTrialMarker()
            const providersToClear: AiCredentialProvider[] = selected === 'claude'
              ? ['claude', 'zai']
              : selected === 'zai'
                ? ['zai', 'claude']
                : ['codex']
            let changed = false
            for (const providerToClear of providersToClear) {
              if (nonTrialMarker.leases[providerToClear]) {
                delete nonTrialMarker.leases[providerToClear]
                changed = true
              }
            }
            if (changed) {
              if (Object.keys(nonTrialMarker.leases).length === 0) {
                await deps.rm(trialMarkerPath(), { force: true })
              } else {
                await writeTrialMarker(nonTrialMarker)
              }
            }
          }
          if (activation) await activateInstalledAccount(selected as 'claude' | 'codex', activation)
          if (claudeApplied) await recordClaudeProvenance(input, applyGeneration, claudeApplied.verifiedAccounts)
          return { ...result, applyGeneration, ...(activation ? { activeAccountIndex: input.activeAccountIndex } : {}), ...(input.applyMode ? { applyMode } : {}) }
        } catch (error) {
          if (error instanceof ClaudeActivationError) {
            await recordClaudeProvenance(input, applyGeneration, error.importedAccounts)
              .catch(() => deps.warn?.('Claude provenance could not be recorded after a failed activation'))
          }
          if (requestedLease && marker && markerChanged) {
            if (previousLease) marker.leases[selected] = previousLease
            else delete marker.leases[selected]
            try {
              if (Object.keys(marker.leases).length === 0) {
                await deps.rm(trialMarkerPath(), { force: true })
              } else {
                await writeTrialMarker(marker)
              }
            } catch {
              // Keep the newly written ownership marker when rollback fails so
              // the server can still issue a matching purge RPC.
            }
          }
          throw error instanceof AiCredentialRuntimeError
            ? new AiCredentialRuntimeError(error.kind, applyGeneration)
            : new AiCredentialRuntimeError(`${selected.toUpperCase()}_APPLY_FAILED`, applyGeneration)
        }
      },
    ))
  }

  const groupAdapters = createGroupProviderAdapters(deps)
  const groupJournalPath = join(deps.homeDir, '.happy', 'ai-credential-groups.json')
  const groups = createCredentialGroupSync({
    read: async () => { try { return await deps.readFile(groupJournalPath) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } },
    write: async content => { await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 }); await deps.chmod(join(deps.homeDir, '.happy'), 0o700); await writeAtomicFile(deps, groupJournalPath, content) },
    snapshot: groupAdapters.snapshot, managedInstalled: groupAdapters.managedInstalled, incoming: groupPayloadIdentities, remove: groupAdapters.remove, appliedMachineId: deps.machineId,
    inUse: async selected => selected !== 'claude' ? [] : (deps.setupTokenAccountsInUse?.() ?? []).map(setupTokenGroupIdentity),
    managedIdentities: (selected, payload) => selected !== 'claude' ? [] : (JSON.parse(payload).accounts as Array<Record<string, unknown>>)
      .filter(account => account?.credentialType === 'setup_token' && typeof account.managedAccountId === 'string')
      .map(account => setupTokenGroupIdentity(account.managedAccountId as string)),
    appliedCredentials: (selected, payload, applied) => {
      if (selected !== 'claude') return []
      const managedPairs = (accounts: unknown) => (Array.isArray(accounts) ? accounts : [])
        .filter((account): account is Record<string, unknown> => isObject(account) && account.credentialType === 'setup_token'
          && typeof account.managedAccountId === 'string' && Number.isSafeInteger(account.credentialGeneration) && Number(account.credentialGeneration) >= 1)
        .map(account => ({ managedAccountId: account.managedAccountId as string, credentialGeneration: account.credentialGeneration as number }))
      const key = (pair: { managedAccountId: string; credentialGeneration: number }) => `${pair.managedAccountId}:${pair.credentialGeneration}`
      const expected = managedPairs(JSON.parse(payload).accounts).map(key)
      // Only cswap's verified import proves what was applied; the requested payload never does.
      const verified = isObject(applied) && Array.isArray(applied.verifiedAccounts) ? managedPairs(applied.verifiedAccounts) : null
      if (expected.length > 0 && !verified) throw new AiCredentialRuntimeError('AI_GROUP_RECEIPT_INVALID')
      const result = verified ?? []
      const actual = result.map(key)
      if (new Set(expected).size !== expected.length || new Set(actual).size !== actual.length
        || expected.length !== actual.length || expected.some(pair => !actual.includes(pair))) {
        throw new AiCredentialRuntimeError('AI_GROUP_RECEIPT_INVALID')
      }
      return result
    },
    apply: async (selected, payload, owned) => {
      const marker = await readTrialMarker()
      if (marker.leases[selected] || (selected === 'claude' && marker.leases.zai)) throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
      if (selected === 'claude') return applyClaudeAdditive(payload, new Set(), new Set(owned))
      return applyCodex(payload, 'merge')
    },
  })
  async function groupSync(input: CredentialGroupRequest) {
    if (input?.provider === 'claude') cancelPersonal()
    return serialize(() => withSafeErrors('AI_GROUP_SYNC_FAILED', async () => {
      if (input?.principalType === 'machine' && (!deps.machineId || input.machineId !== deps.machineId)) {
        throw new AiCredentialRuntimeError('AI_GROUP_MACHINE_MISMATCH')
      }
      // The journal snapshots cswap before applying, so the runtime gate must come first.
      if (input?.provider === 'claude' && typeof input.payload === 'string' && containsManagedSetupTokens(input.payload)
        && !await setupTokenRuntimeSupported()) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
      return groups.sync(input)
    }))
  }

  /**
   * Bound sessions on these managed accounts ended: a removal a group sync deferred for them happens now, queued behind
   * any group sync. Off while the assignment kill switch is on; a failure is retried by the next sync.
   */
  async function releaseSetupTokenAccounts(managedAccountIds: string[]) {
    if (managedAccountIds.length === 0 || ['1', 'true', 'on'].includes((deps.env.APLUS_SETUP_TOKEN_ASSIGNMENT_KILL_SWITCH ?? '').toLowerCase())) return false
    return serialize(() => withSafeErrors('AI_GROUP_SYNC_FAILED', () => groups.reclaimDeferred('claude', managedAccountIds.map(setupTokenGroupIdentity))))
  }

  /** Opens the customer-key relayed NaCl assignment and then uses the normal scoped journal path. */
  async function setupTokenGroupSync(input: unknown, machineId: string, recipient: SetupTokenAssignmentRecipient) {
    return withSafeErrors('AI_GROUP_SYNC_FAILED', async () => {
      const value = input as Record<string, unknown> | null
      if (!isObject(value) || value.version !== 1 || value.provider !== 'claude' || value.credentialType !== 'setup_token'
        || value.payload !== null || value.machineId !== machineId || typeof value.machineId !== 'string'
        || typeof value.sealedPayload !== 'object' || value.sealedPayload === null || Array.isArray(value.sealedPayload)) {
        throw new AiCredentialRuntimeError('AI_GROUP_INVALID_INPUT')
      }
      if (['1', 'true', 'on'].includes((deps.env.APLUS_SETUP_TOKEN_ASSIGNMENT_KILL_SWITCH ?? '').toLowerCase())) {
        throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_ASSIGNMENT_DISABLED')
      }
      if (!await setupTokenRuntimeSupported()) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
      let context: ReturnType<typeof openSetupTokenAssignment>
      try {
        context = openSetupTokenAssignment(value.sealedPayload, recipient, deps.now())
      } catch (error) {
        if (error instanceof Error && /^SETUP_TOKEN_/.test(error.message)) {
          throw new AiCredentialRuntimeError(error.message)
        }
        throw error
      }
      // A shared machine's assignment has no user: the sealed context names the machine as principal.
      const machinePrincipal = context.principalType === 'machine'
      if ((value.principalType ?? null) !== (machinePrincipal ? 'machine' : null)
        || (machinePrincipal ? 'userId' in value : context.userId !== value.userId)
        || context.scope !== value.scope || context.machineId !== value.machineId
        || context.provider !== value.provider || context.generation !== value.generation || context.fingerprint !== value.fingerprint
        || context.leaseId.length === 0
        || ('leaseId' in value && (typeof value.leaseId !== 'string' || value.leaseId !== context.leaseId))
        || ('assignmentGeneration' in value && (value.assignmentGeneration !== context.generation))) {
        throw new AiCredentialRuntimeError('AI_GROUP_CONTEXT_CONFLICT')
      }
      const assignment = {
        version: 1 as const, scope: context.scope, provider: 'claude' as const, generation: context.generation,
        assignmentGeneration: context.generation, fingerprint: context.fingerprint, leaseId: context.leaseId, payload: context.payload,
      }
      return groupSync(machinePrincipal
        ? { ...assignment, principalType: 'machine', machineId: context.machineId }
        : { ...assignment, userId: context.userId })
    })
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
    if (selected === 'zai') {
      await deps.rm(zaiEnvironmentPath(), { force: true })
      return
    }
    const home = codexHome()
    await deps.rm(join(home, 'auth.json'), { force: true })
    await deps.rm(join(home, 'auth.json.happy-backup'), { force: true })
    await deps.rm(join(home, '.auth.json.happy-tmp'), { force: true })
    await deps.rm(codexMultiAuthDir(), { recursive: true, force: true })
  }

  async function purge(input: { provider: AiCredentialProvider; leaseId: string }) {
    if (input?.provider === 'claude') cancelPersonal()
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
      if (selected === 'zai') {
        const marker = await readTrialMarker()
        if (!marker.leases.zai) {
          return { provider: selected, configured: false, accountCount: 0 }
        }
        let environment: Record<string, string>
        try {
          environment = parseZaiEnvironment(await deps.readFile(zaiEnvironmentPath()))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT'
            || (error instanceof AiCredentialRuntimeError && error.kind === 'ZAI_ENV_INVALID')) {
            return { provider: selected, configured: false, accountCount: 0 }
          }
          throw error
        }
        const probe = await deps.execFile(
          'claude',
          [
            '--print',
            '--no-session-persistence',
            '--safe-mode',
            '--output-format',
            'json',
            '--model',
            'sonnet',
            // `--tools <tools...>` 는 가변 인자라 뒤에 오는 프롬프트까지 삼킨다
            // (Claude Code 2.1.246: "Input must be provided ... when using --print").
            // 프롬프트를 먼저 두고 빈 `--tools` 를 마지막에 둔다.
            'Reply with exactly: CLAUDE_AUTH_OK',
            '--tools',
            '',
          ],
          {
            maxOutputBytes: MAX_PAYLOAD_BYTES,
            timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
            acceptNonZeroExit: true,
            environment: overlayManagedCredentialEnvironment(
              Object.fromEntries(
                Object.entries(deps.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              environment,
            ),
          },
        )
        if (probe.exitCode !== undefined && probe.exitCode !== 0) {
          if (isRejectedZaiAuthentication(probe)) {
            return { provider: selected, configured: false, accountCount: 0 }
          }
          throw new AiCredentialRuntimeError('ZAI_PROBE_FAILED', undefined, {
            exitCode: probe.exitCode,
            stderrTail: lastLine(probe.stderr),
          })
        }
        if (!isAuthenticatedZaiProbe(probe.stdout)) {
          return { provider: selected, configured: false, accountCount: 0 }
        }
        return { provider: selected, configured: true, accountCount: 1 }
      }
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
        await assertSupportedCodexMultiAuthInstalled()
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
      const tokenRuntime = await readTokenRuntime({ invoke: async args => (await deps.execFile('cswap', args, {
        timeoutMs: 5000, maxOutputBytes: 65536, environment: deps.env,
      })).stdout })
      return {
        provider: selected,
        ...claudeStatus,
        ...(tokenRuntime ? { tokenRuntime } : {}),
        rotation: claudeStatus.credentialKind === 'api_key'
          ? apiKeyRotationStatus()
          : deps.supervisor.status(),
      }
    }))
  }

  async function verify(input: { provider: AiCredentialProvider; accounts?: VerificationIdentity[]; scope?: 'active' | 'accounts' }) {
    const selected = provider(input?.provider)
    const scope = input.scope ?? 'accounts'
    if (selected === 'zai' || !['active', 'accounts'].includes(scope) || (scope === 'accounts' && (!Array.isArray(input.accounts) || input.accounts.length === 0 || input.accounts.length > 100
      || input.accounts.some(identity => !isObject(identity)
        || (selected === 'claude' ? typeof identity.email !== 'string' || !identity.email
          : !(typeof identity.accountId === 'string' && identity.accountId) && !(typeof identity.email === 'string' && identity.email)))))) {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    return serialize(() => withSafeErrors('AI_CREDENTIAL_VERIFICATION_FAILED', async () => {
      let accounts: Array<Record<string, unknown>>
      let requested = input.accounts ?? []
      let activeAccountNumber: number | null = null
      let activeAccount = ''
      if (selected === 'claude') {
        const listed = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], { maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout)
        if (scope === 'active') {
          const active = listed.accounts.find(account => account.number === listed.activeAccountNumber)
          if (!active) throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_NOT_SELECTED')
          activeAccountNumber = active.number
          activeAccount = active.email
          requested = [{ email: active.email, organizationUuid: typeof active.organizationUuid === 'string' ? active.organizationUuid : '' }]
        }
        const exported = await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })
        const parsed = JSON.parse(exported.stdout)
        if (parsed.version !== 1 || parsed.encrypted === true || !Array.isArray(parsed.accounts)) throw new Error('invalid local export')
        accounts = parsed.accounts.map((account: Record<string, unknown> & { email: string }) => ({
          ...account,
          disabled: listed.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))?.disabled === true,
        }))
      } else {
        const parsed = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'openai-codex-accounts.json')))
        if (parsed.version !== 3 || !Array.isArray(parsed.accounts)) throw new Error('invalid local pool')
        accounts = parsed.accounts
        if (scope === 'active') {
          const active = Number.isInteger(parsed.activeIndex) ? accounts[parsed.activeIndex] : undefined
          if (!active || (!active.accountId && !active.email)) throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_NOT_SELECTED')
          activeAccountNumber = parsed.activeIndex + 1
          activeAccount = typeof active.email === 'string' ? active.email : ''
          requested = [{ accountId: active.accountId as string | undefined, email: active.email as string | undefined }]
        }
      }
      const verification = await verifyLocalAiAccounts(deps, selected, requested, accounts)
      if (scope !== 'active') return verification
      if (selected === 'claude') {
        const current = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], { maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout)
        const active = current.accounts.find(account => account.number === current.activeAccountNumber)
        if (!active || active.number !== activeAccountNumber || active.email !== requested[0]?.email
          || (active.organizationUuid ?? '') !== requested[0]?.organizationUuid) throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_CHANGED')
      } else {
        const current = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'openai-codex-accounts.json')))
        const active = current.accounts?.[current.activeIndex]
        if (current.activeIndex + 1 !== activeAccountNumber || !active
          || (requested[0]?.accountId ? active.accountId !== requested[0].accountId : active.email !== requested[0]?.email)) {
          throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_CHANGED')
        }
      }
      return { ...verification, scope: 'active' as const, activeAccountNumber, activeAccount: maskEmail(activeAccount) }
    }))
  }

  async function rotation(input: { action: 'start' | 'stop' }) {
    if (input?.action !== 'start' && input?.action !== 'stop') {
      throw new AiCredentialRuntimeError('UNSUPPORTED_ROTATION_ACTION')
    }
    return serialize(() => withSafeErrors('ROTATION_UPDATE_FAILED', async () => {
      if (input.action === 'start') {
        await ensureClaudeSwap()
        const result = await deps.execFile('cswap', ['list', '--json'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        if (parseClaudeListDetails(result.stdout).activeCredentialKind === 'api_key') {
          await deps.supervisor.stop()
          return {
            provider: 'claude' as const,
            credentialKind: 'api_key' as const,
            rotation: apiKeyRotationStatus(),
          }
        }
        await deps.supervisor.enable()
      } else {
        await deps.supervisor.stop()
      }
      return { provider: 'claude' as const, rotation: deps.supervisor.status() }
    }))
  }

  /**
   * Binds one new Claude spawn to a managed setup-token slot. The token reaches only
   * that child's environment (as with a Z.AI lease); every other Claude auth override
   * is written empty so neither inherited nor tmux-server values can win. Fails
   * closed: no substitute credential is ever returned.
   */
  const bindingNoncePath = join(deps.homeDir, '.happy', 'setup-token-binding-nonces.json')
  // Only the exact daemon-created object can authorize a spawn; never an RPC DTO.
  const defaultSessionLaunches = new WeakSet<Record<string, string>>()
  const sharedMachineLaunches = new WeakSet<Record<string, string>>()
  const sessionLaunches = new WeakMap<Record<string, string>, {
    agent: string | undefined; selection: Extract<AiAuthSelection, { kind: 'claude-setup-token' }>
    binding: SetupTokenBinding; expiresAt: number | null; started: boolean
  }>()
  /** One-use, durable across restarts: a grant observed on the wire cannot start a second session. */
  async function consumeBindingNonce(nonce: string, expiresAt: number) {
    let ledger: { version: 1; nonces: Record<string, number> }
    try {
      const raw = await deps.readFile(bindingNoncePath).catch(error => { if (error?.code === 'ENOENT') return null; throw error })
      ledger = raw === null ? { version: 1, nonces: {} } : JSON.parse(raw)
      if (ledger?.version !== 1 || typeof ledger.nonces !== 'object' || ledger.nonces === null || Array.isArray(ledger.nonces)
        || Object.entries(ledger.nonces).some(([nonce, expiry]) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce)
          || !Number.isSafeInteger(expiry) || expiry < 1)) throw new Error('invalid')
    } catch { throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_LEDGER_INVALID') }
    const now = deps.now()
    // Entries are kept until well past their grant's validity, so pruning cannot reopen a replay.
    const nonces = Object.fromEntries(Object.entries(ledger.nonces).filter(([, until]) => until + 120_000 > now))
    if (nonce in nonces) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
    if (Object.keys(nonces).length >= 4096) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    nonces[nonce] = expiresAt
    if (!deps.syncFile || !deps.syncDirectory) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    const directory = join(deps.homeDir, '.happy')
    await deps.mkdir(directory, { recursive: true, mode: 0o700 })
    const tempPath = `${bindingNoncePath}.happy-tmp`
    try {
      await deps.writeFile(tempPath, JSON.stringify({ version: 1, nonces }), { mode: 0o600 })
      await deps.chmod(tempPath, 0o600)
      await deps.syncFile(tempPath)
      await deps.rename(tempPath, bindingNoncePath)
      await deps.syncDirectory(directory)
      // Also persist .happy itself when this was the first creation of that directory.
      await deps.syncDirectory(deps.homeDir)
    } catch (error) {
      // Never roll back a renamed ledger: its nonce may already be durable.
      await deps.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * Both launch reads are read-only and independent. Each is its own helper start, which costs
   * seconds on endpoint-secured Windows PCs, so they run together; every check still sees both.
   * The first failure refuses the launch and cancels the other read, so no export is left running.
   */
  async function readSlotRosterAndExport() {
    const pair = new AbortController()
    const cancelSiblingOnFailure = <T>(read: Promise<T>) => read.catch((error: unknown) => { pair.abort(); throw error })
    const [listed, exported] = await Promise.all([
      cancelSiblingOnFailure(deps.execFile('cswap', ['list', '--json'], { maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS, signal: pair.signal })
        .then(result => parseClaudeListDetails(result.stdout).accounts)),
      cancelSiblingOnFailure(deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES, signal: pair.signal })
        .then(result => JSON.parse(result.stdout))),
    ])
    return { listed, exported }
  }

  /**
   * Binds one Claude spawn to a managed setup-token slot. A new spawn needs a
   * server-signed binding grant (caller, company, machine, account, generation,
   * one-use nonce); a resume reuses the binding recorded when that grant was
   * consumed. Both re-check the journal (reconciled, owned by that user) and the
   * stored generation. The token reaches only that child's environment and every
   * other Claude auth override is written empty. Never a substitute credential.
   */
  async function setupTokenSessionEnvironment(agent: string | undefined, selection: Extract<AiAuthSelection, { kind: 'claude-setup-token' }>, recorded: SetupTokenBinding | undefined) {
    const { managedAccountId, credentialGeneration, groupScope } = selection
    if (agent !== undefined && agent !== 'claude') throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    if (!await setupTokenRuntimeSupported()) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
    const unavailable = () => new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    let binding: SetupTokenBinding
    let consume: { nonce: string; expiresAt: number } | null = null
    if (recorded) {
      if (recorded.managedAccountId !== managedAccountId || recorded.groupScope !== groupScope || recorded.credentialGeneration !== credentialGeneration) throw unavailable()
      binding = recorded
    } else {
      if (!deps.setupTokenBinding || !selection.bindingGrant) throw unavailable()
      const claims = await deps.setupTokenBinding.verify(selection.bindingGrant)
      if (!claims || claims.managedAccountId !== managedAccountId || claims.groupScope !== groupScope
        || claims.credentialGeneration !== credentialGeneration || (selection.credentialProofVersion === 1 && !claims.tokenProof)) throw unavailable()
      const { companyId, userId, machineId, keyId, nonce, issuedAt } = claims
      binding = { managedAccountId, credentialGeneration, groupScope, companyId, userId, machineId, keyId, nonce, issuedAt,
        ...(claims.tokenProof ? { tokenProof: claims.tokenProof } : {}) }
      consume = { nonce, expiresAt: claims.expiresAt }
    }
    // A recorded resume must not carry a former PC's authority into a newly registered daemon.
    if (binding.machineId !== deps.machineId || binding.companyId !== groupScope) throw unavailable()
    const proven = !isMachineSetupTokenBinding(binding) && binding.tokenProof ? binding : null
    let tokenIdentities = new Set<string>()
    // A current-PC proof owns the token through this user's desired assignment, irrespective of historical apply PC.
    // Personal, other-company, other-user and revoked slots fail; legacy bindings also require a reconciled apply.
    if (isMachineSetupTokenBinding(binding)) {
      if (!deps.machineSetupTokenAuthority) throw unavailable()
      await deps.machineSetupTokenAuthority(binding)
      if (binding.machineId !== deps.machineId || binding.companyId !== groupScope) throw unavailable()
      const receipt = await groups.receipt(groupScope, 'claude', { principalType: 'machine', machineId: binding.machineId, userId: binding.machineId })
      if (!receipt || !receipt.reconciled || receipt.assignmentGeneration !== binding.assignmentGeneration
        || receipt.fingerprint !== binding.assignmentFingerprint
        || !receipt.appliedCredentials.some(row => row.managedAccountId === managedAccountId && row.credentialGeneration === credentialGeneration)
        || !await groups.authorizeMachine(groupScope, binding.machineId, setupTokenGroupIdentity(managedAccountId))) throw unavailable()
    } else {
      const assignment = await groups.assignment(groupScope, 'claude', proven ? binding.userId : undefined)
      if (!assignment || assignment.userId !== binding.userId
        || (!proven && (!assignment.reconciled || !assignment.desired.includes(setupTokenGroupIdentity(managedAccountId))))) throw unavailable()
      tokenIdentities = new Set(assignment.desired)
      if (proven && tokenIdentities.size === 0) throw unavailable()
    }
    const email = managedSetupTokenEmail(managedAccountId)
    const { listed: roster, exported } = await readSlotRosterAndExport()
    let listed = roster.find(account => account.email === email)
    let slot = Array.isArray(exported?.accounts) ? exported.accounts.find((account: Record<string, unknown>) => account?.email === email) : undefined
    if (proven) {
      if (listed?.disabled === true) throw unavailable()
      // A set copy may give the same token another id. Only this owner's currently desired managed slots are candidates.
      slot = Array.isArray(exported?.accounts) ? exported.accounts.find((candidate: Record<string, unknown>) => {
        const id = managedSetupTokenId(candidate?.email)
        const value = (candidate?.credentials as { claudeAiOauth?: { accessToken?: unknown } } | undefined)?.claudeAiOauth?.accessToken
        return id && candidate.credentialType === 'setup_token' && candidate.managedAccountId === id && tokenIdentities.has(setupTokenGroupIdentity(id))
          && roster.some(row => row.email === candidate.email && row.disabled !== true) && typeof value === 'string' && setupTokenCredentialMatches(value, proven)
      }) : undefined
      if (!slot) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_TOKEN_MISMATCH')
      listed = roster.find(account => account.email === slot.email)
    }
    const token = slot?.credentials?.claudeAiOauth?.accessToken
    if (!listed || listed.disabled === true || slot?.credentialType !== 'setup_token' || (!proven && slot.managedAccountId !== managedAccountId)
      || typeof token !== 'string' || !token.startsWith('sk-ant-oat01-')
      || !Number.isSafeInteger(slot.credentialGeneration) || slot.credentialGeneration < 1) throw unavailable()
    if (!proven && slot.credentialGeneration !== credentialGeneration) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_STALE')
    if (consume) {
      // A fresh grant must still be live when it is spent and when its token env is handed out;
      // the slot reads and the durable write can cross the 60 s lifetime. A recorded resume has no fresh grant.
      const expired = () => new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_EXPIRED')
      if (deps.now() >= consume.expiresAt) throw expired()
      await consumeBindingNonce(consume.nonce, consume.expiresAt)
      if (deps.now() >= consume.expiresAt) throw expired()
    }
    const cleared = Object.fromEntries(CLAUDE_AUTH_OVERRIDE_ENV_KEYS.map(key => [key, '']))
    const environment = { ...cleared, CLAUDE_CODE_OAUTH_TOKEN: token, [HAPPY_AI_AUTH_SOURCE_ENV]: 'org-bundle',
      [SETUP_TOKEN_BINDING_ENV]: formatSetupTokenBinding(binding) }
    sessionLaunches.set(environment, { agent, selection, binding, expiresAt: consume?.expiresAt ?? null, started: false })
    return environment
  }

  /**
   * A shared machine's assigned setup-token is that machine's default credential: an
   * unbound launch spends it through the child's environment only, like a bound one.
   * Null when the machine has no such assignment, or a user assignment desires a
   * setup-token (its refusal then decides). Never a substitute credential.
   *
   * It prefers an account not known to be used up (Saycode specs/shared-pc-session-account-continuation).
   * `account`: exactly the account a prepared launch runs on; `moveFrom`: another usable account for a
   * session leaving that one. Either is null when there is none.
   */
  async function sharedMachineSessionEnvironment(choice?: { account: string | undefined } | { moveFrom: string } | { prefer: string }): Promise<Record<string, string> | null> {
    const held = await sharedMachineCandidates()
    if (!held) return null
    return withSafeErrors('CLAUDE_SETUP_TOKEN_MACHINE_DEFAULT_UNAVAILABLE', async () => {
      const { candidates } = await held.read()
      const usable = candidates.filter(candidate => !sharedAccountUsedUp(candidate.managedAccountId))
      // With every account used up a launch still gets the default: the provider's refusal then speaks.
      const chosen = !choice ? usable[0] ?? candidates[0]
        : 'account' in choice ? candidates.find(candidate => candidate.managedAccountId === choice.account)
        : 'prefer' in choice ? candidates.find(candidate => candidate.managedAccountId === choice.prefer) ?? usable[0] ?? candidates[0]
        : usable.find(candidate => candidate.managedAccountId !== choice.moveFrom)
      if (!chosen) {
        if (choice) return null
        throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_MACHINE_DEFAULT_UNAVAILABLE')
      }
      const cleared = Object.fromEntries(CLAUDE_AUTH_OVERRIDE_ENV_KEYS.map(key => [key, '']))
      return { ...cleared, CLAUDE_CODE_OAUTH_TOKEN: chosen.token, [HAPPY_AI_AUTH_SOURCE_ENV]: 'org-bundle', HAPPY_AI_AUTH_SETUP_TOKEN_LEGACY_SHARED: '1',
        [SETUP_TOKEN_SHARED_ACCOUNT_ENV]: chosen.managedAccountId }
    })
  }

  /**
   * The setup-token accounts assigned to this shared machine that its slots hold. Null when the machine has no such
   * assignment or a user assignment desires a setup-token; `read` lists them (it reads the slot roster).
   */
  async function sharedMachineCandidates() {
    if (!deps.machineId || await groups.hasManagedDesired('claude', 'user')) return null
    const entries = await groups.machineManaged('claude', deps.machineId)
    if (entries.length === 0) return null
    if (entries.some(entry => entry.pending)) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_ASSIGNMENT_UNRESOLVED')
    if (!await setupTokenRuntimeSupported()) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
    const identities = new Set(entries.flatMap(entry => entry.managed))
    return {
      companyId: entries.length === 1 ? entries[0].scope : null,
      async read() {
        const { listed, exported } = await readSlotRosterAndExport()
        const slots: Array<Record<string, unknown>> = Array.isArray(exported?.accounts) ? exported.accounts : []
        const candidates = slots.flatMap(slot => {
          const id = managedSetupTokenId(slot?.email)
          const accessToken = (slot?.credentials as { claudeAiOauth?: { accessToken?: unknown } } | undefined)?.claudeAiOauth?.accessToken
          const enabled = listed.some(account => account.email === slot.email && account.disabled !== true)
          return id !== null && identities.has(setupTokenGroupIdentity(id)) && enabled && slot.credentialType === 'setup_token'
            && slot.managedAccountId === id && typeof accessToken === 'string' && accessToken.startsWith('sk-ant-oat01-')
            ? [{ managedAccountId: id, token: accessToken, credentialGeneration: Number(slot.credentialGeneration) }] : []
        })
        return { candidates }
      },
    }
  }
  /**
   * Saycode specs/setup-token-switch-usage-check Phase 4 — Studio's pick among the accounts this shared PC holds.
   * Asked outside the launch queue: checking a candidate runs the collector, which queues there too.
   * The account, null when Studio has none usable, undefined when Studio was not asked or could not answer.
   */
  async function sharedStudioChoice(moveFrom?: string): Promise<string | null | undefined> {
    if (!deps.sharedChoose) return undefined
    const held = await serializeLaunch('prepare', async () => {
      // A launch on a Z.AI lease never runs on a shared account: no roster read for it.
      if (moveFrom === undefined && (await readTrialMarker()).leases.zai) return null
      const shared = await sharedMachineCandidates()
      return shared?.companyId ? { companyId: shared.companyId, candidates: (await shared.read()).candidates } : null
    }).catch(() => null)
    if (!held?.candidates.length) return undefined
    // Sessions' refusals stay on this PC, so Studio cannot know them: the accounts held as used up are excluded,
    // and an answer naming one of them is not taken.
    const exclude = [...new Set([...(moveFrom === undefined ? [] : [moveFrom]),
      ...held.candidates.filter(candidate => sharedAccountUsedUp(candidate.managedAccountId)).map(candidate => candidate.managedAccountId)])]
    const chosen = await deps.sharedChoose({ companyId: held.companyId, exclude, measure: moveFrom !== undefined,
      candidates: held.candidates.map(({ managedAccountId, credentialGeneration }) => ({ managedAccountId, credentialGeneration })) })
    if (chosen && exclude.includes(chosen)) {
      logger.debug(`[setup-token-switch] Studio chose ${chosen}, which this PC holds as used up; choosing locally`)
      return undefined
    }
    return chosen
  }

  /**
   * What sessions observed of each shared account (Saycode specs/shared-pc-session-account-continuation): the latest
   * reading per window, and a refusal no window explains. Process-local: after a daemon restart a session learns it
   * again from its first refused turn and moves.
   */
  const sharedAccountUsage = new Map<string, { windows: Map<string, { observedAt: number; usedUpUntil: number | null }>; refusal: { observedAt: number; until: number } | null }>()
  const sharedAccountUsedUp = (managedAccountId: string) => {
    const usage = sharedAccountUsage.get(managedAccountId), now = deps.now()
    return !!usage && ((usage.refusal?.until ?? 0) > now || [...usage.windows.values()].some(window => (window.usedUpUntil ?? 0) > now))
  }
  /** A shared-PC session's reading of its account. A window it does not mention, or an older reading, changes nothing. */
  async function sharedMachineUsage(managedAccountId: string, observation: SetupTokenUsageObservation) {
    const usage = sharedAccountUsage.get(managedAccountId) ?? { windows: new Map(), refusal: null }
    sharedAccountUsage.set(managedAccountId, usage)
    let full = false
    for (const window of observation.windows) {
      const usedUp = window.pct !== null && window.pct >= SHARED_ACCOUNT_USED_UP_PCT
      full ||= usedUp
      if ((usage.windows.get(window.kind)?.observedAt ?? -Infinity) > observation.observedAt) continue
      usage.windows.set(window.kind, { observedAt: observation.observedAt,
        usedUpUntil: usedUp ? window.resetsAt ?? observation.observedAt + SHARED_ACCOUNT_UNKNOWN_RESET_MS : null })
    }
    if (observation.reason === 'rate-limited') {
      // Held until its retry time; without one, as long as a full window says, else for one 5-hour window. Never shortened.
      const until = observation.retryAt ?? (full ? null : observation.observedAt + SHARED_ACCOUNT_UNKNOWN_RESET_MS)
      if (until !== null && until > (usage.refusal?.until ?? -Infinity)) usage.refusal = { observedAt: observation.observedAt, until }
    } else if (usage.refusal && usage.refusal.observedAt < observation.observedAt) {
      usage.refusal = null
    }
  }
  /**
   * Another account assigned to this shared PC for a session leaving a used-up one; null when none is usable.
   * The session applies the environment itself and restarts its provider on the same conversation.
   */
  async function sharedMachineRebind(managedAccountId: string, observation?: SetupTokenUsageObservation) {
    if (observation) await sharedMachineUsage(managedAccountId, observation)
    // Asked to move: the account is used up even when the session has no reading of when it resets.
    if (!sharedAccountUsedUp(managedAccountId)) await sharedMachineUsage(managedAccountId, { observedAt: deps.now(), reason: 'rate-limited', retryAt: null, windows: [] })
    const studio = await sharedStudioChoice(managedAccountId)
    if (studio === null) return null
    if (studio) {
      const chosen = await serializeLaunch('prepare', () => sharedMachineSessionEnvironment({ account: studio }))
      if (chosen) return chosen
      logger.debug(`[setup-token-switch] Studio chose ${studio}, which this PC does not hold; choosing locally`)
    }
    return serializeLaunch('prepare', () => sharedMachineSessionEnvironment({ moveFrom: managedAccountId }))
  }
  /** The environment of exactly that shared account, for a session catching up with a move; null when it is gone. */
  function sharedMachineAccountEnvironment(managedAccountId: string) {
    return serializeLaunch('prepare', () => sharedMachineSessionEnvironment({ account: managedAccountId }))
  }

  /**
   * A launch or resume without a setup-token binding runs on the machine default.
   * While any current assignment desires an org-managed setup-token, that is
   * refused with an actionable code, even with a personal login active: group-sync
   * keeps the personal login, so an unbound launch (agent facade, automation, fork,
   * unrecorded resume) would otherwise silently decide the credential. Revoked
   * assignments, ordinary OAuth groups, Z.AI leases, other agents and machines
   * without assignments are unchanged. Journal-only: no cswap call per launch.
   */
  async function refuseUnboundManagedDefault() {
    const required = () => new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_SELECTION_REQUIRED')
    if (await groups.hasManagedDesired('claude')) throw required()
    // Journals from before the projection cannot say whether they desire a managed slot.
    // An empty (revoked) one desires nothing. A non-empty one is classified from the roster
    // once and recorded; until every desired identity is classified it is refused, never
    // treated as unmanaged. Later launches then use the journal only.
    const legacy = await groups.unprojected('claude')
    for (const entry of legacy.filter(entry => entry.desired.length === 0)) await groups.recordManaged('claude', entry.scope, [])
    const unknown = legacy.filter(entry => entry.desired.length > 0)
    if (unknown.length === 0) return
    const unresolved = () => new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_ASSIGNMENT_UNRESOLVED')
    let accounts: Array<Record<string, unknown>>
    try {
      accounts = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout).accounts
      const live = await readOptionalJson(deps.env.CLAUDE_CONFIG_DIR ? join(deps.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(deps.homeDir, '.claude.json'))
      const liveAccount = live?.oauthAccount as { emailAddress?: unknown; organizationUuid?: unknown } | undefined
      if (typeof liveAccount?.emailAddress === 'string' && liveAccount.emailAddress) {
        accounts = [...accounts, { email: liveAccount.emailAddress, organizationUuid: typeof liveAccount.organizationUuid === 'string' ? liveAccount.organizationUuid : '' }]
      }
    } catch { throw unresolved() }
    // Both identity formats a journal may hold for a managed slot (managed-ID and older email
    // hash); every other installed account classifies its identity as not managed.
    const managedIdentities = new Set<string>()
    const classified = new Set<string>()
    for (const account of accounts) {
      const id = managedSetupTokenId(account.email)
      if (id !== null) {
        for (const identity of [setupTokenGroupIdentity(id), createHash('sha256').update(JSON.stringify(['claude', String(account.email).trim().toLowerCase(), ''])).digest('hex')]) {
          managedIdentities.add(identity); classified.add(identity)
        }
      } else {
        try { classified.add(groupAccountIdentity('claude', account)) } catch { /* no identity, cannot classify anything */ }
      }
    }
    let managed = false
    let pending = false
    for (const entry of unknown) {
      if (entry.desired.some(identity => !classified.has(identity))) { pending = true; continue }
      const desiredManaged = entry.desired.filter(identity => managedIdentities.has(identity))
      await groups.recordManaged('claude', entry.scope, desiredManaged)
      if (desiredManaged.length > 0) managed = true
    }
    if (managed) throw required()
    if (pending) throw unresolved()
  }

  async function sessionEnvironment(agent: string | undefined, selection?: AiAuthSelection, recorded?: SetupTokenBinding): Promise<Record<string, string>> {
    if (selection?.kind === 'claude-setup-token') return serializeLaunch('prepare', () => withSafeErrors('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE',
      () => setupTokenSessionEnvironment(agent, selection, recorded)))
    if (agent !== undefined && agent !== 'claude') return {}
    const studio = await sharedStudioChoice()
    return serializeLaunch('prepare', async () => {
      const marker = await readTrialMarker()
      if (marker.leases.zai) return parseZaiEnvironment(await deps.readFile(zaiEnvironmentPath()))
      const shared = await sharedMachineSessionEnvironment(studio ? { prefer: studio } : undefined)
      if (shared) {
        sharedMachineLaunches.add(shared)
        return shared
      }
      await refuseUnboundManagedDefault()
      const environment = {}
      defaultSessionLaunches.add(environment)
      return environment
    })
  }

  // The caller invokes this around the actual child creation, after preparation.
  async function launchSession<T>(environment: Record<string, string>, start: () => T | Promise<T>): Promise<T> {
    const launch = sessionLaunches.get(environment)
    if (!launch) {
      if (SETUP_TOKEN_BINDING_ENV in environment) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      // Recognize only default Claude environments prepared by this runtime.
      // Explicit personal, other agents and ZAI environments retain their bypass.
      // The shared machine's token is read again under the group-sync queue; a replaced one is stale.
      if (sharedMachineLaunches.has(environment)) return serializeLaunch('launch', async () => {
        const current = await sharedMachineSessionEnvironment({ account: environment[SETUP_TOKEN_SHARED_ACCOUNT_ENV] })
        if (current?.CLAUDE_CODE_OAUTH_TOKEN !== environment.CLAUDE_CODE_OAUTH_TOKEN) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_STALE')
        return await start()
      })
      if (defaultSessionLaunches.has(environment)) return serializeLaunch('launch', async () => {
        await refuseUnboundManagedDefault()
        return await start()
      })
      return start()
    }
    return serializeLaunch('launch', () => withSafeErrors('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE', async () => {
      if (launch.started) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_REPLAYED')
      const checkExpiry = () => {
        if (launch.expiresAt !== null && deps.now() >= launch.expiresAt) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_EXPIRED')
      }
      checkExpiry()
      // Recheck custody/disabled/generation under the same queue as group-sync.
      // The original grant was consumed already; this is not another grant use.
      const current = await setupTokenSessionEnvironment(launch.agent, launch.selection, launch.binding)
      if (current.CLAUDE_CODE_OAUTH_TOKEN !== environment.CLAUDE_CODE_OAUTH_TOKEN) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_STALE')
      checkExpiry()
      if (isMachineSetupTokenBinding(launch.binding)) {
        if (!deps.machineSetupTokenStart) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE');
        await deps.machineSetupTokenStart(launch.binding);
      }
      launch.started = true
      // No asynchronous launch preparation belongs in start: plain spawn calls
      // spawnHappyCLI, tmux calls new-window, Windows resumes a suspended root.
      // Keep custody locked until submitted.
      return await start()
    }))
  }

  let personalUse = { online: false, inUse: false }
  let personalCancelEpoch = 0
  const personalRefEpochs = new Map<string, number>()
  let personalCommand: { ref: string; controller: AbortController } | null = null
  const personalInvoke = async (args: string[], signal?: AbortSignal) => (await deps.execFile('cswap', args, {
    ...cswapCollectorCommandOptions(args), environment: deps.env, signal,
  })).stdout
  const personalScheduler = createPersonalProbeScheduler({
    now: deps.now, online: () => personalUse.online, inUse: () => personalUse.inUse,
    roster: async () => (await readTokenRuntime({ invoke: args => personalInvoke(args), now: deps.now }))?.accounts ?? [],
    collect: (row, signal) => tokenProbe({ version: 1, operation: 'collect', accountRef: row.accountRef, credentialGeneration: row.credentialGeneration }, signal),
  })
  function cancelPersonal(ref?: string) {
    if (ref) {
      // Bound memory without allowing an old captured ref epoch to become current again.
      if (!personalRefEpochs.has(ref) && personalRefEpochs.size >= 1000) { personalCancelEpoch++; personalRefEpochs.clear() }
      personalRefEpochs.set(ref, (personalRefEpochs.get(ref) ?? 0) + 1)
    } else personalCancelEpoch++
    personalScheduler.cancel(ref)
    if (personalCommand && (!ref || personalCommand.ref === ref)) personalCommand.controller.abort()
  }
  async function tokenProbe(input: unknown, signal?: AbortSignal) {
    const request = input as { operation?: string; enabled?: boolean; accountRef?: string }
    if (request?.operation === 'consent' && request.enabled === false) cancelPersonal(request.accountRef)
    const queuedEpoch = personalCancelEpoch
    const queuedRefEpoch = personalRefEpochs.get(request?.accountRef ?? '') ?? 0
    return serialize(async () => {
      const revoked = queuedRefEpoch !== (personalRefEpochs.get(request?.accountRef ?? '') ?? 0)
      if (request?.operation === 'collect' && (revoked || queuedEpoch !== personalCancelEpoch || signal?.aborted)) {
        return { version: 1, status: revoked ? 'disabled' : 'unavailable', reason: revoked ? 'probe_disabled' : 'cancelled', error: 'TOKEN_PROBE_CANCELLED' }
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) controller.abort()
      const flight = request?.operation === 'collect' ? { ref: request.accountRef ?? '', controller } : null
      if (flight) personalCommand = flight
      try {
        return await createTokenProbe({ invoke: args => personalInvoke(args, controller.signal), now: deps.now })(input)
      } finally {
        signal?.removeEventListener('abort', abort)
        if (personalCommand === flight) personalCommand = null
      }
    })
  }
  function personalSchedulerTick(context: { online: boolean; inUse: boolean }) {
    personalUse = context
    if (!context.online || !context.inUse) cancelPersonal()
    return personalScheduler.tick()
  }
  function stopPersonalScheduler() { personalUse = { online: false, inUse: false }; personalScheduler.close(); cancelPersonal() }
  function collectorOrigin() {
    return readTrustedStudioOrigin(deps.env)
  }
  async function collectorProbe(input: unknown, machineId: string) {
    return serialize(async () => {
      const origin = collectorOrigin()
      return createClaudeCollector({
        studioOrigin: origin, machineId, now: deps.now,
        authorize: r => authorizeCollectorRequest(groups, setupTokenGroupIdentity, r),
        consume: (id, expiresAt) => consumeCollectorPermit(join(deps.homeDir, '.happy', 'claude-collector'), id, expiresAt, deps.now()),
        invoke: async (args, input) => (await deps.execFile('cswap', args, {
          input, ...cswapCollectorCommandOptions(args), environment: deps.env,
        })).stdout,
      })(input)
    })
  }

  /** Saycode specs/setup-token-switch-usage-check — an account measured with a reserved permit, through the collector boundary. */
  const measureWithPermit = createPermitMeasure({
    invoke: async args => (await deps.execFile('cswap', args, { ...cswapCollectorCommandOptions(args), environment: deps.env })).stdout,
    collect: request => collectorProbe(request, request.machineId),
  })

  // Launch eligibility only. Authority is still checked by Studio and at token/launch under serializeLaunch.
  const sharedMachineSetupTokenScope = () => serializeLaunch('scope', async () => {
    if (!deps.machineId || await groups.hasManagedDesired('claude', 'user') || (await readTrialMarker()).leases.zai) return null
    const entries = await groups.machineManaged('claude', deps.machineId)
    if (!entries.length) return null
    if (entries.length !== 1 || entries[0].pending) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_ASSIGNMENT_UNRESOLVED')
    return entries[0].scope
  })
  return { sharedMachineSetupTokenScope, sharedMachineUsage, sharedMachineRebind, sharedMachineAccountEnvironment, measureWithPermit, launchSession, personalSchedulerTick, stopPersonalScheduler, tokenProbe, collectorProbe, capture, repairCodex, apply, groupSync, setupTokenGroupSync, releaseSetupTokenAccounts, groupReceipt: (scope: string, selected: 'claude' | 'codex', principal?: { principalType: 'machine'; machineId: string }) => serialize(() => groups.receipt(scope, selected, principal ? { ...principal, userId: principal.machineId } : undefined)), purge, status, verify, rotation, sessionEnvironment, capabilities: async (machineId?: string) => {
    // One fresh runtime observation per RPC: launching cswap repeatedly can block a secured Windows host.
    let stdout = ''
    try { stdout = (await deps.execFile('cswap', ['token-runtime', 'capabilities'], { maxOutputBytes: 64 * 1024, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout } catch {}
    let metadata: Record<string, unknown> = {}
    try { const value: unknown = JSON.parse(stdout); if (isObject(value)) metadata = value } catch {}
    const setupToken = supportsManagedSetupTokens(stdout), personal = personalProbeSupported(metadata), origin = collectorOrigin()
    let collector = false
    if (machineId && origin && metadata.artifact === 'saycode-setup-token-runtime-v1' && metadata.organizationCollectorVersion === 1) {
      try { collector = await collectorVerificationReady(origin) } catch {}
    }
    return { version: 1, codexRecoveryVersion: 1, ...(personal ? { tokenProbeVersion: 1 } : {}), ...(collector ? { collectorProbeVersion: 1, collectorMachinePrincipalVersion: 1 } : {}), groupAssignmentVersion: 1, sharedMachineAssignmentVersion: 1, setupTokenResumeRequirementVersion: 1, activeSelectionVersion: 1, verificationVersion: 1, verificationScopes: ['accounts', 'active'], applyModes: ['merge', 'replace', 'repair'],
    // Managed setup-token import with metadata verification, only on the marked cswap token runtime.
    ...(setupToken ? { setupTokenVersion: 1, setupTokenStatusVersion: 1 } : {}),
    // Advertised only when a server-signed binding proof can actually be verified here.
    ...(setupToken && deps.setupTokenBinding && await deps.setupTokenBinding.available()
      ? { newSessionProfileBinding: true, setupTokenSessionBindingVersion: 1, setupTokenCredentialProofVersion: 1 } : { newSessionProfileBinding: false }) } } }
}

type ClaudeListDetails = {
  configured: boolean
  activeAccount: string | null
  activeAccountNumber: number | null
  activeUsable: boolean
  usableAccountNumber: number | null
  activeCredentialKind: 'oauth' | 'api_key' | null
  accounts: Array<Record<string, unknown> & { number: number; email: string }>
}

function claudeApiKeyTargetEmail(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!isObject(parsed) || parsed.version !== 1 || parsed.encrypted === true
      || !Array.isArray(parsed.accounts) || parsed.accounts.length !== 1) return null
    const account = parsed.accounts[0]
    if (!isObject(account)
      || typeof account.email !== 'string'
      || typeof account.credentials !== 'string'
      || !account.credentials.startsWith('sk-ant-api')) return null
    return account.email
  } catch {
    return null
  }
}

function containsManagedSetupTokens(payload: string): boolean {
  try { return JSON.parse(payload)?.accounts?.some((account: Record<string, unknown>) => account?.credentialType === 'setup_token') === true } catch { return false }
}

function claudeImportedAccountIdentities(payload: string): Set<string> | null {
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!isObject(parsed) || parsed.version !== 1 || parsed.encrypted === true
      || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) return null
    const identities = new Set<string>()
    for (const account of parsed.accounts) {
      if (!isObject(account)
        || typeof account.email !== 'string'
        || (account.organizationUuid !== undefined
          && typeof account.organizationUuid !== 'string')) return null
      identities.add(JSON.stringify([account.email, account.organizationUuid ?? '']))
    }
    return identities.size === parsed.accounts.length ? identities : null
  } catch {
    return null
  }
}

function claudeListAccountIdentity(
  account: Record<string, unknown> & { email: string },
): string {
  return JSON.stringify([
    account.email,
    typeof account.organizationUuid === 'string' ? account.organizationUuid : '',
  ])
}

/** Why no Claude account can be made active: every enabled account needs re-login, or the list is not as expected. */
function claudeNoUsableAccountKind(details: ClaudeListDetails): 'CLAUDE_APPLY_RELOGIN_REQUIRED' | 'CLAUDE_APPLY_VERIFICATION_FAILED' {
  const enabled = details.accounts.filter((account) => account.disabled !== true)
  return enabled.length > 0 && enabled.every((account) => account.usageStatus === 'relogin_required')
    ? 'CLAUDE_APPLY_RELOGIN_REQUIRED'
    : 'CLAUDE_APPLY_VERIFICATION_FAILED'
}

function parseClaudeListDetails(stdout: string): ClaudeListDetails {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!isObject(parsed)
      || parsed.schemaVersion !== 1
      || !Array.isArray(parsed.accounts)
      || (parsed.activeAccountNumber !== null
        && !Number.isSafeInteger(parsed.activeAccountNumber))) {
      throw new Error('invalid status')
    }
    const accounts: Array<Record<string, unknown>> = []
    const accountNumbers = new Set<number>()
    for (const account of parsed.accounts) {
      if (!isObject(account)
        || !Number.isSafeInteger(account.number)
        || Number(account.number) < 1
        || typeof account.email !== 'string'
        || (account.organizationUuid !== undefined
          && typeof account.organizationUuid !== 'string')
        || accountNumbers.has(Number(account.number))) {
        throw new Error('invalid account')
      }
      accountNumbers.add(Number(account.number))
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
        activeAccountNumber: null,
        activeUsable: false,
        usableAccountNumber: typeof usableAccount?.number === 'number'
          ? usableAccount.number
          : null,
        activeCredentialKind: null,
        accounts: accounts as ClaudeListDetails['accounts'],
      }
    }
    const active = accounts.find((account) => account.number === parsed.activeAccountNumber)
    if (!active || typeof active.email !== 'string') {
      throw new Error('active account missing')
    }
    return {
      configured: true,
      activeAccount: maskEmail(active.email),
      activeAccountNumber: Number(parsed.activeAccountNumber),
      activeUsable: usable(active),
      usableAccountNumber: typeof usableAccount?.number === 'number'
        ? usableAccount.number
        : null,
      activeCredentialKind: active.usageStatus === 'api_key' ? 'api_key' : 'oauth',
      accounts: accounts as ClaudeListDetails['accounts'],
    }
  } catch {
    throw new AiCredentialRuntimeError('CLAUDE_STATUS_INVALID')
  }
}

function apiKeyRotationStatus(): AiCredentialRotationStatus {
  return { state: 'not-applicable', lastErrorKind: null }
}

function claudeAccountHealth(details: ClaudeListDetails) {
  const active = details.accounts.find(account => account.number === details.activeAccountNumber)
  const activeAccountStatus = !active ? 'not-selected' as const
    : active.disabled === true ? 'disabled' as const
    : active.usageStatus === 'ok' ? 'usage-readable' as const
    : active.usageStatus === 'api_key' ? 'api-key' as const
    : managedSetupTokenId(active.email) !== null ? 'unknown' as const
    : active.usageStatus === 'relogin_required' ? 'relogin-required' as const
    : 'unknown' as const
  return {
    accountCount: details.accounts.length,
    activeAccountStatus,
    usableAccountCount: details.accounts.filter(account => account.disabled !== true
      && (account.usageStatus === 'ok' || account.usageStatus === 'api_key')).length,
    // A setup-token has no refresh token; cswap's relogin verdict is not an authentication result for it.
    reloginRequiredAccountCount: details.accounts.filter(account => account.disabled !== true && account.usageStatus === 'relogin_required'
      && managedSetupTokenId(account.email) === null).length,
  }
}

function parseClaudeList(stdout: string) {
  const details = parseClaudeListDetails(stdout)
  const { configured, activeAccount, activeCredentialKind } = details
  const setupToken = setupTokenRuntimeStatus(details.accounts, details.activeAccountNumber)
  return {
    configured,
    activeAccount,
    ...claudeAccountHealth(details),
    ...(setupToken.accounts.length > 0 ? { setupToken } : {}),
    ...(activeCredentialKind ? { credentialKind: activeCredentialKind } : {}),
  }
}

type CodexMultiAuthAccount = CodexAccountIdentity & {
  refreshToken: string
  addedAt: number
  lastUsed: number
  [key: string]: unknown
}

export type CodexMultiAuthBundle = {
  version: 1
  kind: 'codex-multi-auth'
  packageVersion: string
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
    || typeof parsed.packageVersion !== 'string'
    || !isReadableCodexMultiAuthBundleVersion(parsed.packageVersion)
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

/**
 * `expected` is the file's content as this operation last read it (`null`: it was absent). A file
 * with `expected` is compared again under its credential lock right before anything is replaced;
 * if Codex or another tool rewrote it meanwhile, nothing is written (aplus D4 C-R5).
 */
type ManagedCodexFile = { path: string; content: string; expected?: string | null }
/** A credential this write depends on without rewriting it, e.g. the live login a pool entry was copied from. */
type CredentialGuard = { path: string; expected: string | null }

/** The file or another writer changed after this operation read it. One fresh retry is allowed. */
export const CREDENTIAL_LOST_RACE = 'AI_CREDENTIAL_LOST_RACE'

function parseOptionalCredentialJson(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null
  const parsed = JSON.parse(raw)
  if (!isObject(parsed)) throw new AiCredentialRuntimeError('AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED')
  return parsed
}

async function readOptionalText(deps: AiCredentialRuntimeDependencies, path: string): Promise<string | null> {
  try {
    return await deps.readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Takes every listed credential lock, in path order so two writers never wait on each other. */
function withCredentialFileLocks<T>(deps: AiCredentialRuntimeDependencies, paths: string[], work: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(paths)].sort()
  return first === undefined ? work() : deps.lockCredentialFile(first, () => withCredentialFileLocks(deps, rest, work))
}

async function assertCredentialsUnchanged(deps: AiCredentialRuntimeDependencies, expected: CredentialGuard[]): Promise<void> {
  for (const file of expected) {
    if (await readOptionalText(deps, file.path) !== file.expected) throw new AiCredentialRuntimeError(CREDENTIAL_LOST_RACE)
  }
}

/** Runs a credential write operation again, from its reads, once if it lost the race to another writer. */
async function retryOnceOnLostRace<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof AiCredentialRuntimeError) || error.kind !== CREDENTIAL_LOST_RACE) throw error
    logger.debug('[ai-credential] a credential file changed while it was being written; retrying once from a fresh read')
    return operation()
  }
}

/**
 * Installs `files` with backups, runs `verify`, and rolls back on failure. `verify` reports its own rewrites
 * of an installed file through `ownWrite`, so the rollback restores over them instead of keeping them as another writer's.
 */
async function replaceCodexMultiAuthFiles<T>(
  deps: AiCredentialRuntimeDependencies,
  files: ManagedCodexFile[],
  verify: (ownWrite: (path: string, content: string) => void) => Promise<T>,
  guards: CredentialGuard[] = [],
): Promise<T> {
  const backups = new Set<string>()
  /** Every content this operation wrote to each installed path. */
  const installed = new Map<string, Set<string>>()
  const compared: CredentialGuard[] = [
    ...guards,
    ...files.flatMap(file => file.expected === undefined ? [] : [{ path: file.path, expected: file.expected }]),
  ]
  let verified = false
  try {
    // Only the local compare-and-replace holds the locks; `verify` may reach the network. Every replaced file is
    // locked, compared or not, so an install never lands inside another writer's read-modify-write.
    await withCredentialFileLocks(deps, [...files.map(file => file.path), ...compared.map(file => file.path)], async () => {
      await assertCredentialsUnchanged(deps, compared)
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
        installed.set(file.path, new Set([file.content]))
        await writeAtomicFile(deps, file.path, file.content)
      }
    })
    const result = await verify((path, content) => { installed.get(path)?.add(content) })
    verified = true
    for (const path of backups) await deps.rm(`${path}.happy-backup`, { force: true })
    return result
  } catch (error) {
    if (verified) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_BACKUP_CLEANUP_FAILED')
    }
    // A file another writer (Codex, codex-multi-auth) replaced after we installed it is newer than our backup: keep it.
    const replacedByOthers = new Set<string>()
    for (const file of files) {
      await deps.rm(`${file.path}.happy-tmp`, { force: true }).catch(() => undefined)
      await deps.rm(`${file.path}.happy-sort-tmp`, { force: true }).catch(() => undefined)
      const ours = installed.get(file.path)
      if (ours) {
        const current = await readOptionalText(deps, file.path).catch(() => null)
        if (current !== null && !ours.has(current)) {
          replacedByOthers.add(file.path)
          continue
        }
        await deps.rm(file.path, { force: true }).catch(() => undefined)
      }
    }
    for (const path of backups) {
      if (replacedByOthers.has(path)) {
        await deps.rm(`${path}.happy-backup`, { force: true }).catch(() => undefined)
        continue
      }
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
  try {
    await deps.writeFile(tempPath, content, { mode: 0o600 })
    await deps.chmod(tempPath, 0o600)
    await deps.rename(tempPath, path)
  } catch (error) {
    await deps.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

// Group journal and provider adapters throw their own fixed codes as plain Errors; those name the real failure.
const GROUP_FAILURE_CODE = /^AI_GROUP_[A-Z0-9_]{1,64}$/

async function withSafeErrors<T>(kind: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AiCredentialRuntimeError) throw error
    if (error instanceof Error && GROUP_FAILURE_CODE.test(error.message)) throw new AiCredentialRuntimeError(error.message)
    const failure = new AiCredentialRuntimeError(kind)
    failure.failureCause = safeFailureCause(error)
    throw failure
  }
}

function safeFailureCause(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : typeof error
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? `${name}:${code}` : name
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

/**
 * Persists a directory entry after a rename. Windows cannot fsync a directory (EPERM), and
 * its rename is already metadata-journaled, so the step is skipped there like claudeCollector.
 */
export async function syncDirectoryForDurability(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/**
 * Field PCs with endpoint security pay a large per-process cost for every
 * credential helper start. Log each call's duration (command and word-shaped
 * subcommands only, never paths, numbers or payload arguments) so a slow launch can be split by step.
 */
export function timeAiCredentialCommand<O, R>(
  run: (command: string, args: string[], options?: O) => Promise<R>,
  now: () => number = Date.now,
  log: (message: string) => void = message => logger.debug(message),
) {
  return async (command: string, args: string[], options?: O): Promise<R> => {
    const startedAt = now()
    let outcome = 'failed'
    try {
      const result = await run(command, args, options)
      outcome = 'ok'
      return result
    } finally {
      log(`[timing] ai-credential-command ${[command, ...args.slice(0, 2).filter(arg => /^-{0,2}[a-z][a-z-]*$/.test(arg))].join(' ')} ${outcome} ${now() - startedAt}ms`)
    }
  }
}

export function createNodeAiCredentialRuntime(
  supervisor: Supervisor,
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
  options: Pick<AiCredentialRuntimeDependencies, 'setupTokenBinding'|'machineId'|'setupTokenAccountsInUse'|'machineSetupTokenAuthority'|'machineSetupTokenStart'|'sharedChoose'> = {},
) {
  return createAiCredentialRuntime({
    ...options,
    homeDir,
    now: Date.now,
    env,
    execFile: timeAiCredentialCommand(routeClaudeSwapThroughPython((command, args, options) => runAiCredentialCommand(command, args, options), claudeSwapPython)),
    readFile: (path) => readFile(path, 'utf8'),
    readdir: (path) => readdir(path),
    syncFile: async (path) => { const file = await open(path, 'r+'); try { await file.sync() } finally { await file.close() } },
    syncDirectory: path => syncDirectoryForDurability(path),
    writeFile: async (path, content, options) => { await writeFile(path, content, options) },
    mkdir,
    rename,
    chmod,
    rm,
    makeTempDir: () => mkdtemp(join(stagingParent(), 'happy-ai-credential-')),
    lockCredentialFile: (path, work) => withCredentialLock(credentialFileLockPath(path), work),
    supervisor,
    warn: (message) => logger.debug(message),
  })
}

export function runAiCredentialCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
  // Windows npm installs expose .cmd shims; native spawn cannot resolve them.
  spawnCommand: typeof spawn = process.platform === 'win32' || options.terminateProcessTree ? crossSpawn as typeof spawn : spawn,
): Promise<AiCredentialCommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new AiCredentialRuntimeError('COMMAND_CANCELLED')); return }
    const environment = options.environment ?? process.env
    const child = spawnCommand(command, args, {
      env: command === 'uv' || command === 'cswap'
        ? withUvToolBinOnPath(environment, homedir(), command)
        : environment,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.terminateProcessTree && process.platform !== 'win32' ? { detached: true } : {}),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const fail = (kind: string) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      if (timeout) clearTimeout(timeout)
      // A Windows npm shim owns a shell wrapper as well as the actual CLI process.
      if ((options.terminateProcessTree || process.platform === 'win32') && child.pid) {
        if (process.platform === 'win32') {
          const killer = spawnCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
          const killTimeout = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL'); reject(new AiCredentialRuntimeError('COMMAND_TREE_TERMINATION_FAILED')) }, 5_000)
          killer.on('error', () => { clearTimeout(killTimeout); child.kill('SIGKILL'); reject(new AiCredentialRuntimeError('COMMAND_TREE_TERMINATION_FAILED')) })
          killer.on('close', (code) => { clearTimeout(killTimeout); reject(new AiCredentialRuntimeError(code === 0 ? kind : 'COMMAND_TREE_TERMINATION_FAILED')) })
          return
        }
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else {
        child.kill('SIGKILL')
      }
      reject(new AiCredentialRuntimeError(kind))
    }
    const abort = () => fail('COMMAND_CANCELLED')
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
    child.stdout!.on('data', collect(stdout))
    child.stderr!.on('data', collect(stderr))
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(error.code === 'ENOENT' ? 'COMMAND_NOT_AVAILABLE' : 'COMMAND_FAILED')
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      if (timeout) clearTimeout(timeout)
      if (code !== 0) {
        if (!options.acceptNonZeroExit) {
          reject(new AiCredentialRuntimeError('COMMAND_FAILED'))
          return
        }
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(options.acceptNonZeroExit && { exitCode: code ?? -1 }),
      })
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    timeout = setTimeout(() => fail('COMMAND_TIMED_OUT'), options.timeoutMs ?? 30_000)
    if (options.input !== undefined) {
      child.stdin?.on('error', () => fail('COMMAND_FAILED'))
      child.stdin?.end(options.input)
    }
  })
}

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

export type AiCredentialRuntime = ReturnType<typeof createAiCredentialRuntime>

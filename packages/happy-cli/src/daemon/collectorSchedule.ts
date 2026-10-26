/**
 * Measures, on this machine, the organization accounts its collector policies name, on Studio's schedule — whether or
 * not anyone has a Desktop open (Saycode specs/setup-token-switch-usage-check Phase 5). Studio says which accounts are
 * due (past their interval, not known to be used up), reserves each permit and enforces the budget; the reading goes
 * through the same signed collector boundary as every other collection.
 */
import { logger } from '@/ui/logger'

const REQUEST_TIMEOUT_MS = 15_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type CollectorScheduleDeps = {
  /** The daemon's single trusted Studio origin; without one nothing is collected. */
  studioOrigin: string | null
  machineId: string
  /** The daemon's machine token; Studio has Happy confirm it owns this machine. */
  bearer(): string
  fetch: typeof fetch
  /** Measures one account with the permit Studio reserved; the reading to publish, or null when nothing was observed. */
  measure(input: { companyId: string; machineId: string; managedAccountId: string; credentialGeneration: number; permit: Record<string, unknown> }): Promise<Record<string, unknown> | null>
}
type DueAccount = { managedAccountId: string; credentialGeneration: number; policyRevision: number }

export function createCollectorSchedule(deps: CollectorScheduleDeps) {
  const post = (route: string, body: object) => deps.fetch(`${deps.studioOrigin}/api/claude-setup-token/daemon/collect/${route}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${deps.bearer()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  let running: Promise<void> | null = null

  async function collect(account: DueAccount) {
    const label = `[collector-schedule] account ${account.managedAccountId}`
    const request = { machineId: deps.machineId, ...account }
    const reserved = await post('reserve', request)
    const permit = await reserved.json().catch(() => null) as Record<string, unknown> | null
    if (!reserved.ok || !permit || typeof permit.permitId !== 'string' || typeof permit.companyId !== 'string') {
      logger.debug(`${label}: not reserved (${reserved.status} ${String(permit?.error ?? '')})`)
      return
    }
    const observation = await deps.measure({ companyId: permit.companyId, machineId: deps.machineId,
      managedAccountId: account.managedAccountId, credentialGeneration: account.credentialGeneration, permit })
    if (!observation) { logger.debug(`${label}: measurement told nothing`); return }
    const published = await post('publish', { ...request, permitId: permit.permitId, observation })
    logger.debug(`${label}: measured, ${published.ok ? 'published' : `publish refused ${published.status}`}`)
  }

  async function cycle() {
    const response = await post('due', { machineId: deps.machineId })
    const body = await response.json().catch(() => null) as { accounts?: unknown } | null
    if (!response.ok || !Array.isArray(body?.accounts)) {
      logger.debug(`[collector-schedule] due list unavailable (${response.status})`)
      return
    }
    const due = (body.accounts as DueAccount[]).filter(account => typeof account?.managedAccountId === 'string' && UUID.test(account.managedAccountId)
      && Number.isSafeInteger(account.credentialGeneration) && Number.isSafeInteger(account.policyRevision))
    // One at a time: the collector runs serialized on this machine anyway, and a failure stops only its own account.
    for (const account of due) {
      try { await collect(account) }
      catch (error) { logger.debug(`[collector-schedule] account ${account.managedAccountId}: failed ${(error as Error)?.name ?? 'error'}`) }
    }
  }

  return {
    /** One cycle; a tick while one runs joins it. */
    tick(): Promise<void> {
      if (!deps.studioOrigin) return Promise.resolve()
      running ??= cycle()
        .catch(error => { logger.debug(`[collector-schedule] cycle failed ${(error as Error)?.name ?? 'error'}`) })
        .finally(() => { running = null })
      return running
    },
  }
}

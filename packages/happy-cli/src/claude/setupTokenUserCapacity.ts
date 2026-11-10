import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
export type SetupTokenCapacityActor = { companyId: string; machineId: string; sessionId: string; requestId: string; contentHash: string; proof: string }
export function readSetupTokenCapacityActor(value: unknown, text: string): SetupTokenCapacityActor | undefined {
  if (value === undefined) return undefined
  const actor = value as SetupTokenCapacityActor
  if (!actor || !['companyId', 'machineId', 'sessionId', 'requestId'].every(key => typeof actor[key as keyof SetupTokenCapacityActor] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(actor[key as keyof SetupTokenCapacityActor]))
    || typeof actor.proof !== 'string' || !actor.proof.length || actor.proof.length > 4096 || actor.contentHash !== createHash('sha256').update(text).digest('hex')) throw new Error('CAPACITY_INPUT_PROOF_INVALID')
  return actor
}
type Entry = { actor: SetupTokenCapacityActor; runtimeId: string; seq: number; attempt?: number; started?: boolean; phase: 'waiting' | 'claiming' | 'attempting' | 'result' | 'finished'; result?: unknown }
type Reply = { state: string; managedAccountId?: string; credentialGeneration?: number; epoch?: number; validForMs?: number; retryAfterMs?: number; requiresMove?: boolean; reason?: string }
/** Durable input ownership: a lost claim answer never authorizes a second provider delivery. */
export function createSetupTokenCapacityRuntime(deps: {
  directory: string
  request(operation: string, actor: SetupTokenCapacityActor, runtimeId: string, extra?: Record<string, unknown>, signal?: AbortSignal): Promise<Reply>
  notify(): void
  move(): Promise<boolean>
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>
}) {
  const active = new Map<string, Entry>()
  const writes = new WeakMap<Entry, Promise<void>>()
  const reports = new WeakMap<Entry, Promise<unknown>>()
  let current: Entry | undefined
  let providerAlive = false
  let recovered = false
  const path = (actor: SetupTokenCapacityActor) => join(deps.directory, createHash('sha256').update(JSON.stringify([actor.companyId, actor.requestId])).digest('hex') + '.json')
  const resultRef = (entry: Entry) => createHash('sha256').update(JSON.stringify([entry.actor.companyId, entry.actor.requestId, entry.attempt ?? 0])).digest('hex')
  const resultPath = (entry: Entry) => join(deps.directory, `result-${resultRef(entry)}.json`)
  const legacyId = (entry: Entry) => {
    if (!entry.attempt) return entry.runtimeId
    const hex = createHash('sha256').update(JSON.stringify([entry.runtimeId, entry.attempt])).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  const failedResult = (value: unknown) => {
    const result = value as { type?: unknown; subtype?: unknown; is_error?: unknown } | null
    return result?.type === 'result' && (result.is_error === true || typeof result.subtype === 'string' && result.subtype !== 'success')
  }
  const send = (entry: Entry, operation: string, extra?: Record<string, unknown>, signal?: AbortSignal) => deps.request(operation, entry.actor, entry.runtimeId, { ...extra, attempt: entry.attempt ?? 0 }, signal)
  async function save(entry: Entry) {
    // After the previous write whatever its outcome: one failed write must not fail every later one.
    const pending = (writes.get(entry) ?? Promise.resolve()).catch(() => undefined).then(() => write(entry))
    writes.set(entry, pending)
    return pending
  }
  async function write(entry: Entry) {
    await writeJson(path(entry.actor), entry)
  }
  async function writeJson(target: string, value: unknown) {
    await mkdir(deps.directory, { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await rename(temporary, target)
    if (process.platform !== 'win32') {
      const directory = await open(deps.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
  async function report(entry: Entry, operation: string, extra: Record<string, unknown> = {}) {
    // Same isolation as save(): a failed heartbeat must not fail the delivery and finish reports after it.
    const pending = (reports.get(entry) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const seq = ++entry.seq; await save(entry)
      return send(entry, operation, { ...extra, seq })
    })
    reports.set(entry, pending)
    return pending
  }
  async function finish(entry: Entry) {
    if ((await report(entry, 'finish')).state !== 'finished') throw new Error('CAPACITY_FINISH_UNCONFIRMED')
    entry.phase = 'finished'; await save(entry); active.delete(entry.actor.requestId)
  }
  async function arm(entry: Entry, operation: 'claim' | 'observe', extra: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted()
    entry.phase = 'claiming'; await save(entry)
    const reply = await send(entry, operation, extra, signal)
    if (reply.state !== (operation === 'claim' ? 'claimed' : 'observed')) throw new Error('CAPACITY_CLAIM_UNCONFIRMED')
    active.set(entry.actor.requestId, entry); current = entry
    entry.started = providerAlive
    if (signal.aborted) { await finish(entry); signal.throwIfAborted() }
    entry.phase = 'attempting'; await save(entry)
    if ((await report(entry, 'delivery', { deliveryState: 'attempting' })).state !== 'attempting') throw new Error('CAPACITY_DELIVERY_UNCONFIRMED')
    signal.throwIfAborted()
  }
  async function recoverOutstanding() {
    if (recovered) return
    let files: string[]
    try { files = await readdir(deps.directory) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = [] }
    for (const name of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const entry: Entry = JSON.parse(await readFile(join(deps.directory, name), 'utf8'))
      if (!['claiming', 'attempting', 'result'].includes(entry.phase)) continue
      try { await send(entry, 'lost') } catch (error) {
        // The server holds no execution for this input (its claim was rejected or never arrived): nothing is left to
        // reconcile. Settle it here, or every later input in this session fails on the same answer.
        if (!(error instanceof Error && error.message === 'CAPACITY_NOT_FOUND')) throw error
        entry.phase = 'finished'; await save(entry)
      }
    }
    recovered = true
  }
  return {
    hasActive: () => active.size > 0,
    providerStarted() { providerAlive = true; for (const entry of active.values()) entry.started = true },
    async admit(actor: SetupTokenCapacityActor, signal: AbortSignal): Promise<{ state: 'admitted' | 'moved' } | { state: 'off'; legacyRequestId: string } | { state: 'result'; result: unknown }> {
      signal.throwIfAborted()
      let entry: Entry
      try { entry = JSON.parse(await readFile(path(actor), 'utf8')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('CAPACITY_JOURNAL_UNREADABLE')
        entry = { actor, runtimeId: randomUUID(), seq: 0, phase: 'waiting' }; await save(entry)
      }
      if (entry.actor.proof !== actor.proof || entry.actor.contentHash !== actor.contentHash || !entry.runtimeId || !Number.isSafeInteger(entry.seq)) throw new Error('CAPACITY_INPUT_CONFLICT')
      if (entry.result === undefined && ['attempting', 'result', 'finished'].includes(entry.phase)) {
        try { entry.result = JSON.parse(await readFile(resultPath(entry), 'utf8')) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('CAPACITY_RESULT_UNREADABLE') }
      }
      if (entry.result !== undefined) {
        await recoverOutstanding().catch(error => console.warn('[setup-token-capacity] cached result restored; runtime reconciliation pending', error instanceof Error ? error.name : 'unknown'))
        return { state: 'result', result: entry.result }
      }
      await recoverOutstanding()
      if (entry.phase !== 'waiting') {
        await send(entry, 'recover')
        throw new Error('CAPACITY_DELIVERY_UNKNOWN')
      }
      const started = performance.now()
      let notified = false
      try {
        while (true) {
          signal.throwIfAborted()
          if (performance.now() - started >= 1800000) throw new Error('CAPACITY_WAIT_EXPIRED')
          const sent = performance.now()
          const decision = await send(entry, 'reserve', undefined, signal)
          signal.throwIfAborted()
          if (decision.state === 'off') return { state: 'off', legacyRequestId: legacyId(entry) }
          if (decision.state === 'reserved') {
            if (!Number.isSafeInteger(decision.epoch) || !Number.isSafeInteger(decision.credentialGeneration) || typeof decision.managedAccountId !== 'string'
              || !Number.isFinite(decision.validForMs) || decision.validForMs! <= performance.now() - sent || decision.validForMs! > 15000) throw new Error('CAPACITY_INVALID_PERMIT')
            if (decision.requiresMove) {
              if (!await deps.move()) throw new Error('CAPACITY_ACCOUNT_MOVE_FAILED')
              return { state: 'moved' }
            }
            await arm(entry, 'claim', { epoch: decision.epoch, managedAccountId: decision.managedAccountId, credentialGeneration: decision.credentialGeneration }, signal)
            return { state: 'admitted' }
          }
          if (decision.state !== 'wait' || !Number.isFinite(decision.retryAfterMs) || decision.retryAfterMs! <= 0) throw new Error(`CAPACITY_${decision.reason ?? 'UNAVAILABLE'}`)
          if (!notified) { notified = true; deps.notify() }
          const milliseconds = Math.min(30000, decision.retryAfterMs!, Math.max(1, 1800000 - (performance.now() - started)))
          if (deps.wait) await deps.wait(milliseconds, signal)
          else await delay(milliseconds, undefined, { signal })
        }
      } catch (error) {
        if (entry.phase === 'waiting') await send(entry, 'cancel').catch(error => console.warn('[setup-token-capacity] cancellation unconfirmed', error instanceof Error ? error.name : 'unknown'))
        else if (entry.phase === 'claiming') await send(entry, 'lost').catch(error => console.warn('[setup-token-capacity] claim outcome unconfirmed', error instanceof Error ? error.name : 'unknown'))
        throw error
      }
    },
    async observe(actor: SetupTokenCapacityActor, signal: AbortSignal) {
      const entry: Entry = JSON.parse(await readFile(path(actor), 'utf8'))
      if (entry.phase !== 'waiting' || entry.actor.proof !== actor.proof) throw new Error('CAPACITY_INPUT_CONFLICT')
      await arm(entry, 'observe', { legacyRequestId: legacyId(entry) }, signal)
    },
    async retry(actor: SetupTokenCapacityActor) {
      const entry: Entry = JSON.parse(await readFile(path(actor), 'utf8'))
      if (entry.actor.proof !== actor.proof) throw new Error('CAPACITY_INPUT_CONFLICT')
      if (entry.phase === 'waiting' && (entry.attempt ?? 0) > 0) return
      if (entry.phase !== 'finished' || !failedResult(entry.result)) throw new Error('CAPACITY_RETRY_UNCONFIRMED')
      entry.attempt = (entry.attempt ?? 0) + 1; entry.phase = 'waiting'; entry.seq = 0; delete entry.result
      await save(entry)
    },
    async result(result: unknown, backgroundActive: boolean) {
      if (!current) return
      const entry = current; current = undefined
      await writeJson(resultPath(entry), result)
      entry.result = result; entry.phase = 'result'; await save(entry)
      await report(entry, 'delivery', { deliveryState: 'result', resultRef: resultRef(entry), resultStatus: failedResult(result) ? 'error' : 'success' })
      if (!backgroundActive) for (const held of [...active.values()]) if (held.result !== undefined) await finish(held)
    },
    async idle() { for (const entry of [...active.values()]) if (entry.result !== undefined) await finish(entry) },
    async heartbeat() { for (const entry of [...active.values()]) await report(entry, 'heartbeat') },
    async providerStopped(exitObserved: boolean) {
      let uncertain = false
      let failure: unknown
      for (const entry of [...active.values()]) {
        try {
          if (exitObserved || !entry.started) await finish(entry)
          else { await send(entry, 'lost'); uncertain = true }
        } catch (error) { failure ??= error }
      }
      active.clear(); current = undefined; providerAlive = false
      if (failure) throw failure
      if (uncertain) throw new Error('CAPACITY_PROVIDER_EXIT_UNCONFIRMED')
    },
  }
}

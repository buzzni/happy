import { prepareDifficultyRoutingArtifacts } from './difficultyRoutingArtifacts'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import tweetnacl from 'tweetnacl'
import { decodeBase64 } from '@/api/encryption'

/**
 * The two contracts are mutually exclusive on the wire. `deadlineAt` is an absolute instant
 * produced by *another* machine; `remainingMs` is a duration this host starts counting on
 * arrival, so it never compares its own clock against someone else's.
 */
type DifficultyRoutingRelayFields = {
  version: 1
  requestId: string
  signedGrant: string
  policyRevision: number
  sourceMachineId: string
  hostMachineId: string
  hostProcessKeyId: string
  sealedText: {
    alg: 'x25519-xsalsa20-poly1305'
    nonce: string
    ephemeralPublicKey: string
    ciphertext: string
  }
}

/** Legacy: an absolute instant produced by the *sending* machine. */
export type DifficultyRoutingRelayRequestLegacy = DifficultyRoutingRelayFields & {
  timingVersion?: undefined
  deadlineAt: number
  remainingMs?: undefined
}

/** Timing v2: a duration this host starts counting on arrival. */
export type DifficultyRoutingRelayRequestV2 = DifficultyRoutingRelayFields & {
  timingVersion: 2
  remainingMs: number
  deadlineAt?: undefined
}

export type DifficultyRoutingRelayRequest = DifficultyRoutingRelayRequestLegacy | DifficultyRoutingRelayRequestV2

export type DifficultyRoutingRelayResponse = {
  version: 1
  /** Echoed on every answer to a v2 request, so the caller can tell the contracts apart. */
  timingVersion?: 2
  requestId: string
  policyRevision: number
  status: 'ok' | 'busy' | 'not-ready' | 'expired' | 'revoked' | 'unsupported' | 'error'
  difficulty?: 'trivial' | 'routine' | 'hard' | null
  classifierRevision?: string
  elapsedMs?: number
}

type WorkerMessage =
  | { type: 'ready'; classifierRevision: string }
  | { type: 'result'; requestId: string; difficulty: 'trivial' | 'routine' | 'hard'; classifierRevision: string }
  | { type: 'error'; requestId: string; error: string }

type Pending = {
  request: DifficultyRoutingRelayRequest
  resolve: (value: DifficultyRoutingRelayResponse) => void
  /** Both on the monotonic clock. Set once on admission and never recomputed. */
  startedMono: number
  deadlineMono: number
  settled: boolean
  timer: ReturnType<typeof setTimeout>
}

export type ClassifierHostDeps = {
  spawnWorker?: () => ChildProcess
  /**
   * Wall clock. Used *only* to read a legacy `deadlineAt` at the entrance — that is the one
   * place a foreign absolute instant has to be interpreted, and it is also the legacy flaw
   * this contract exists to retire. Nothing downstream may use it.
   */
  wallNow?: () => number
  /** Process monotonic clock: every deadline, timer, replay window and elapsed measurement. */
  monotonicNow?: () => number
  /** Must validate live policy, exact signed grant, principal and session scope. */
  authorize?: (request: DifficultyRoutingRelayRequest, signal: AbortSignal) => Promise<boolean>
  idleMs?: number
  hangGraceMs?: number
}

/** Longest a consumed grant must stay unusable: 60s of life, 15s of future-iat the server
 *  still accepts, and the millisecond where `now === exp` is not yet expired. */
const REPLAY_RETENTION_MS = 75_001

type Budget = { ok: true; remainingMs: number } | { ok: false; status: 'expired' | 'error' | 'unsupported' }

/** Reads whichever contract the body is on, without ever guessing which field wins. */
export function readRelayBudget(request: DifficultyRoutingRelayRequest, wallNow: number): Budget {
  if (request.timingVersion !== undefined) {
    if (request.timingVersion !== 2) return { ok: false, status: 'unsupported' }
    if (request.deadlineAt !== undefined) return { ok: false, status: 'error' }
    const remainingMs = request.remainingMs
    return typeof remainingMs === 'number' && Number.isSafeInteger(remainingMs) && remainingMs >= 1 && remainingMs <= 3000
      ? { ok: true, remainingMs }
      : { ok: false, status: 'error' }
  }
  if (request.remainingMs !== undefined) return { ok: false, status: 'error' }
  const deadlineAt = request.deadlineAt
  if (!Number.isFinite(deadlineAt) || deadlineAt <= wallNow) return { ok: false, status: 'expired' }
  // Legacy only: this is the single place a foreign absolute instant is read, and the reason
  // a clock difference used to kill the turn. Converted to a local duration immediately.
  return deadlineAt > wallNow + 1000 ? { ok: false, status: 'error' } : { ok: true, remainingMs: deadlineAt - wallNow }
}

export class DifficultyRoutingClassifierHost {
  private readonly queue: Pending[] = []
  private readonly replay = new Map<string, number>()
  private active: Pending | null = null
  private worker: ChildProcess | null = null
  private classifierRevision: string | null = null
  private preparation: AbortController | null = null
  private retryAt = 0
  private stopping = false
  private admittedBytes = 0
  private enabled = false
  private epoch = 0
  private admitting = 0
  private idleTimer?: ReturnType<typeof setTimeout>
  private hangTimer?: ReturnType<typeof setTimeout>
  private loadTimer?: ReturnType<typeof setTimeout>
  private readonly wallNow: () => number
  private readonly mono: () => number
  constructor(private readonly hostProcessKey: { id: string; publicKey: Uint8Array; secretKey: Uint8Array }, private readonly deps: ClassifierHostDeps = {}) {
    this.wallNow = deps.wallNow ?? Date.now
    this.mono = deps.monotonicNow ?? (() => performance.now())
  }
  capability() {
    return { hostProcessKeyId: this.hostProcessKey.id, hostProcessPublicKey: Buffer.from(this.hostProcessKey.publicKey).toString('base64'), ready: Boolean(this.classifierRevision) }
  }
  setEnabled(enabled: boolean): void {
    if (!enabled) { this.terminate(); return }
    if (this.enabled) return
    this.enabled = true
    this.retryAt = 0
    this.prepare()
  }
  prepare(): void {
    if (!this.enabled || this.worker || this.preparation || this.mono() < this.retryAt) return
    if (this.deps.spawnWorker) {
      try { this.ensureWorker().send?.({ type: 'prepare' }) } catch { this.stopWorker('error') }
      return
    }
    const controller = new AbortController(), epoch = this.epoch
    this.preparation = controller
    void prepareDifficultyRoutingArtifacts({ signal: controller.signal, directory: process.env.HAPPY_DIFFICULTY_ROUTING_MODEL_DIR }).then(directory => {
      if (this.enabled && epoch === this.epoch && !controller.signal.aborted) this.ensureWorker(directory).send?.({ type: 'prepare' })
    }).catch(() => { if (epoch === this.epoch) this.stopWorker('error') }).finally(() => {
      if (this.preparation === controller) this.preparation = null
    })
  }
  async classify(request: DifficultyRoutingRelayRequest): Promise<DifficultyRoutingRelayResponse> {
    if (!this.enabled) return this.reply(request, 'revoked')
    if (!request || request.version !== 1 || request.hostProcessKeyId !== this.hostProcessKey.id) return this.reply(request, 'unsupported')
    // One reading of the clock for this turn. Everything after this is a duration.
    const h0 = this.mono()
    const budget = readRelayBudget(request, this.wallNow())
    if (!budget.ok) return this.reply(request, budget.status)
    const deadlineMono = h0 + budget.remainingMs
    if (!validId(request.requestId) || typeof request.signedGrant !== 'string' || request.signedGrant.length > 8192) return this.reply(request, 'error')
    if (!request.sealedText || typeof request.sealedText.ciphertext !== 'string' || request.sealedText.ciphertext.length > 42700) return this.reply(request, 'error')
    if (!this.classifierRevision) { this.prepare(); return this.reply(request, 'not-ready') }
    if (this.admittedBytes + request.sealedText.ciphertext.length > 256 * 1024) return this.reply(request, 'busy')
    if (this.queue.length + this.admitting >= 8 && this.active) return this.reply(request, 'busy')
    for (const [key, expires] of this.replay) if (expires <= this.mono()) this.replay.delete(key)
    const replayKey = request.signedGrant
    if (this.replay.has(replayKey)) return this.reply(request, 'revoked')
    if (this.replay.size >= 1024 || this.queue.length + this.admitting >= 9) return this.reply(request, 'busy')
    this.replay.set(replayKey, this.mono() + REPLAY_RETENTION_MS)
    this.admittedBytes += request.sealedText.ciphertext.length
    this.admitting++
    const epoch = this.epoch
    const authorized = await this.authorized(request, deadlineMono)
    this.admitting--
    this.admittedBytes -= request.sealedText.ciphertext.length
    if (!authorized || !this.enabled || epoch !== this.epoch) {
      this.replay.delete(replayKey)
      return this.reply(request, 'revoked')
    }
    if (deadlineMono <= this.mono()) return this.reply(request, 'expired')
    clearTimeout(this.idleTimer)
    return new Promise((resolve) => {
      const pending = { request, resolve, startedMono: h0, deadlineMono, settled: false } as Pending
      pending.timer = setTimeout(() => {
        this.settle(pending, this.reply(request, 'expired'))
        if (this.active !== pending) {
          const index = this.queue.indexOf(pending)
          if (index >= 0) this.queue.splice(index, 1)
        }
      }, Math.max(0, deadlineMono - this.mono()))
      this.admittedBytes += request.sealedText.ciphertext.length
      this.queue.push(pending)
      void this.pump()
    })
  }
  terminate(): void { this.enabled = false; this.stopWorker('revoked') }
  private settle(pending: Pending, result: DifficultyRoutingRelayResponse): void {
    if (pending.settled) return
    pending.settled = true
    this.admittedBytes -= pending.request.sealedText.ciphertext.length
    clearTimeout(pending.timer)
    pending.resolve(result)
  }
  private stopWorker(status: DifficultyRoutingRelayResponse['status']): void {
    this.epoch++
    this.preparation?.abort()
    this.preparation = null
    if (status === 'error') this.retryAt = this.mono() + 30000
    clearTimeout(this.idleTimer); clearTimeout(this.hangTimer); clearTimeout(this.loadTimer)
    if (this.active) this.settle(this.active, this.reply(this.active.request, status))
    for (const pending of this.queue.splice(0)) this.settle(pending, this.reply(pending.request, pending.deadlineMono <= this.mono() ? 'expired' : status))
    this.active = null; this.classifierRevision = null
    const worker = this.worker
    this.stopping = Boolean(worker)
    // Keep the old process reserved until its exit event: kill is not exit.
    if (worker) {
      try { worker.kill('SIGKILL') } catch { /* exit listener owns release */ }
    }
  }
  /**
   * The callback gets the abort signal rather than recomputing a deadline of its own: the
   * HTTP call it makes has to die on the same budget, and it cannot see this host's clock.
   */
  private async authorized(request: DifficultyRoutingRelayRequest, deadlineMono: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    try {
      return await Promise.race([
        this.deps.authorize?.(request, controller.signal) ?? Promise.resolve(false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve(false) }, Math.min(250, Math.max(1, deadlineMono - this.mono())))
        }),
      ])
    } catch { return false } finally { clearTimeout(timer); controller.abort() }
  }
  private async pump(): Promise<void> {
    if (this.active || !this.enabled || !this.classifierRevision) return
    const next = this.queue.shift()
    if (!next) { this.armIdle(); return }
    // Redundant with `settled` whenever the admission timer ran on time — deliberately kept
    // for when it did not. A starved event loop can deliver this dequeue late, and nothing
    // past the budget may reach decryption. No test distinguishes the two.
    if (next.settled || next.deadlineMono <= this.mono()) {
      this.settle(next, this.reply(next.request, 'expired')); void this.pump(); return
    }
    this.active = next
    const epoch = this.epoch
    // Re-validated on what is LEFT of the original budget — the queue never grants more time.
    const authorized = await this.authorized(next.request, next.deadlineMono)
    if (epoch !== this.epoch || this.active !== next) return
    if (!authorized || next.settled || next.deadlineMono <= this.mono()) {
      this.settle(next, this.reply(next.request, authorized ? 'expired' : 'revoked'))
      this.active = null; void this.pump(); return
    }
    const text = this.openSealedText(next.request)
    if (text === null) {
      this.settle(next, this.reply(next.request, 'error')); this.active = null; void this.pump(); return
    }
    this.hangTimer = setTimeout(() => this.stopWorker('error'), Math.max(0, next.deadlineMono - this.mono()) + (this.deps.hangGraceMs ?? 1000))
    try { this.worker?.send?.({ type: 'classify', requestId: next.request.requestId, text, maxInputTokens: 512 }) }
    catch { this.stopWorker('error') }
  }
  private ensureWorker(modelDirectory?: string): ChildProcess {
    if (this.worker) return this.worker
    const worker = this.deps.spawnWorker?.() ?? spawnWorkerProcess(modelDirectory)
    this.worker = worker
    this.stopping = false
    this.loadTimer = setTimeout(() => this.stopWorker('error'), 60000)
    worker.on('message', message => { if (this.worker === worker) this.onWorkerMessage(message as WorkerMessage) })
    worker.on('error', () => { if (this.worker === worker) this.stopWorker('error') })
    worker.on('exit', () => {
      if (this.worker !== worker) return
      const expectedExit = this.stopping
      this.worker = null
      this.stopWorker(expectedExit ? 'not-ready' : 'error')
    })
    return worker
  }
  private onWorkerMessage(message: WorkerMessage): void {
    if (this.stopping || !this.enabled || !message || typeof message !== 'object') return
    if (message.type === 'ready') {
      if (!validId(message.classifierRevision)) { this.stopWorker('error'); return }
      clearTimeout(this.loadTimer)
      this.classifierRevision = message.classifierRevision; this.armIdle(); return
    }
    if (message.type === 'error' && !message.requestId) { this.stopWorker('error'); return }
    const active = this.active
    if (!active || active.request.requestId !== message.requestId) return
    clearTimeout(this.hangTimer)
    this.active = null
    if (active.deadlineMono <= this.mono()) this.settle(active, this.reply(active.request, 'expired'))
    else if (message.type === 'result' && message.classifierRevision === this.classifierRevision && ['trivial', 'routine', 'hard'].includes(message.difficulty)) {
      this.settle(active, { ...this.reply(active.request, 'ok'), difficulty: message.difficulty, classifierRevision: message.classifierRevision, elapsedMs: Math.max(0, this.mono() - active.startedMono) })
    } else this.settle(active, this.reply(active.request, 'error'))
    void this.pump()
  }
  private armIdle(): void {
    clearTimeout(this.idleTimer)
    if (!this.active && !this.queue.length) this.idleTimer = setTimeout(() => this.stopWorker('not-ready'), this.deps.idleMs ?? 60 * 60000)
    this.idleTimer?.unref?.()
  }
  private openSealedText(request: DifficultyRoutingRelayRequest): string | null {
    try {
      if (request.sealedText.alg !== 'x25519-xsalsa20-poly1305') return null
      const plaintext = tweetnacl.box.open(decodeBase64(request.sealedText.ciphertext), decodeBase64(request.sealedText.nonce), decodeBase64(request.sealedText.ephemeralPublicKey), this.hostProcessKey.secretKey)
      if (!plaintext || plaintext.byteLength > 32000) return null
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
      return text.length <= 8000 ? text : null
    } catch { return null }
  }
  private reply(request: DifficultyRoutingRelayRequest, status: DifficultyRoutingRelayResponse['status']): DifficultyRoutingRelayResponse {
    const base = { version: 1 as const, requestId: request?.requestId, policyRevision: request?.policyRevision, status }
    return request?.timingVersion === 2 ? { ...base, timingVersion: 2 } : base
  }
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 }
export function createDifficultyRoutingHostKey() {
  const keyPair = tweetnacl.box.keyPair()
  return { id: randomUUID(), publicKey: keyPair.publicKey, secretKey: keyPair.secretKey }
}
function spawnWorkerProcess(modelDirectory?: string): ChildProcess {
  const entry = process.argv[1]
  if (!entry) throw new Error('difficulty routing worker cannot resolve happy entrypoint')
  // Native inference receives only explicit artifact/process settings, never CLI tokens.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: '/nonexistent', NODE_ENV: 'production', HAPPY_DIFFICULTY_ROUTING_MODEL_DIR: modelDirectory }
  return spawn(process.execPath, [...process.execArgv, entry, 'difficulty-routing-worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env })
}

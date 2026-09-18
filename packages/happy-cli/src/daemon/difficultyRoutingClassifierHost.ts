import { prepareDifficultyRoutingArtifacts } from './difficultyRoutingArtifacts'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import tweetnacl from 'tweetnacl'
import { decodeBase64 } from '@/api/encryption'

export type DifficultyRoutingRelayRequest = {
  version: 1
  requestId: string
  signedGrant: string
  policyRevision: number
  sourceMachineId: string
  hostMachineId: string
  hostProcessKeyId: string
  deadlineAt: number
  sealedText: {
    alg: 'x25519-xsalsa20-poly1305'
    nonce: string
    ephemeralPublicKey: string
    ciphertext: string
  }
}

export type DifficultyRoutingRelayResponse = {
  version: 1
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
  startedAt: number
  settled: boolean
  timer: ReturnType<typeof setTimeout>
}

export type ClassifierHostDeps = {
  spawnWorker?: () => ChildProcess
  now?: () => number
  /** Must validate live policy, exact signed grant, principal and session scope. */
  authorize?: (request: DifficultyRoutingRelayRequest) => Promise<boolean>
  idleMs?: number
  hangGraceMs?: number
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
  private readonly now: () => number
  constructor(private readonly hostProcessKey: { id: string; publicKey: Uint8Array; secretKey: Uint8Array }, private readonly deps: ClassifierHostDeps = {}) {
    this.now = deps.now ?? Date.now
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
    if (!this.enabled || this.worker || this.preparation || this.now() < this.retryAt) return
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
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.now()) return this.reply(request, 'expired')
    if (request.deadlineAt > this.now() + 1000 || !validId(request.requestId) || typeof request.signedGrant !== 'string' || request.signedGrant.length > 8192) return this.reply(request, 'error')
    if (!request.sealedText || typeof request.sealedText.ciphertext !== 'string' || request.sealedText.ciphertext.length > 42700) return this.reply(request, 'error')
    if (!this.classifierRevision) { this.prepare(); return this.reply(request, 'not-ready') }
    if (this.admittedBytes + request.sealedText.ciphertext.length > 256 * 1024) return this.reply(request, 'busy')
    if (this.queue.length + this.admitting >= 8 && this.active) return this.reply(request, 'busy')
    for (const [key, expires] of this.replay) if (expires <= this.now()) this.replay.delete(key)
    const replayKey = request.signedGrant
    if (this.replay.has(replayKey)) return this.reply(request, 'revoked')
    if (this.replay.size >= 1024 || this.queue.length + this.admitting >= 9) return this.reply(request, 'busy')
    this.replay.set(replayKey, this.now() + 60000)
    this.admittedBytes += request.sealedText.ciphertext.length
    this.admitting++
    const epoch = this.epoch
    const authorized = await this.authorized(request)
    this.admitting--
    this.admittedBytes -= request.sealedText.ciphertext.length
    if (!authorized || !this.enabled || epoch !== this.epoch) {
      this.replay.delete(replayKey)
      return this.reply(request, 'revoked')
    }
    if (request.deadlineAt <= this.now()) return this.reply(request, 'expired')
    clearTimeout(this.idleTimer)
    return new Promise((resolve) => {
      const pending = { request, resolve, startedAt: this.now(), settled: false } as Pending
      pending.timer = setTimeout(() => {
        this.settle(pending, this.reply(request, 'expired'))
        if (this.active !== pending) {
          const index = this.queue.indexOf(pending)
          if (index >= 0) this.queue.splice(index, 1)
        }
      }, Math.max(0, request.deadlineAt - this.now()))
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
    if (status === 'error') this.retryAt = this.now() + 30000
    clearTimeout(this.idleTimer); clearTimeout(this.hangTimer); clearTimeout(this.loadTimer)
    if (this.active) this.settle(this.active, this.reply(this.active.request, status))
    for (const pending of this.queue.splice(0)) this.settle(pending, this.reply(pending.request, pending.request.deadlineAt <= this.now() ? 'expired' : status))
    this.active = null; this.classifierRevision = null
    const worker = this.worker
    this.stopping = Boolean(worker)
    // Keep the old process reserved until its exit event: kill is not exit.
    if (worker) {
      try { worker.kill('SIGKILL') } catch { /* exit listener owns release */ }
    }
  }
  private async authorized(request: DifficultyRoutingRelayRequest): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.deps.authorize?.(request) ?? Promise.resolve(false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.min(250, Math.max(1, request.deadlineAt - this.now()))) }),
      ])
    } catch { return false } finally { clearTimeout(timer) }
  }
  private async pump(): Promise<void> {
    if (this.active || !this.enabled || !this.classifierRevision) return
    const next = this.queue.shift()
    if (!next) { this.armIdle(); return }
    if (next.settled || next.request.deadlineAt <= this.now()) {
      this.settle(next, this.reply(next.request, 'expired')); void this.pump(); return
    }
    this.active = next
    const epoch = this.epoch
    const authorized = await this.authorized(next.request)
    if (epoch !== this.epoch || this.active !== next) return
    if (!authorized || next.settled || next.request.deadlineAt <= this.now()) {
      this.settle(next, this.reply(next.request, authorized ? 'expired' : 'revoked'))
      this.active = null; void this.pump(); return
    }
    const text = this.openSealedText(next.request)
    if (text === null) {
      this.settle(next, this.reply(next.request, 'error')); this.active = null; void this.pump(); return
    }
    this.hangTimer = setTimeout(() => this.stopWorker('error'), Math.max(0, next.request.deadlineAt - this.now()) + (this.deps.hangGraceMs ?? 1000))
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
    if (active.request.deadlineAt <= this.now()) this.settle(active, this.reply(active.request, 'expired'))
    else if (message.type === 'result' && message.classifierRevision === this.classifierRevision && ['trivial', 'routine', 'hard'].includes(message.difficulty)) {
      this.settle(active, { ...this.reply(active.request, 'ok'), difficulty: message.difficulty, classifierRevision: message.classifierRevision, elapsedMs: this.now() - active.startedAt })
    } else this.settle(active, this.reply(active.request, 'error'))
    void this.pump()
  }
  private armIdle(): void {
    clearTimeout(this.idleTimer)
    if (!this.active && !this.queue.length) this.idleTimer = setTimeout(() => this.stopWorker('not-ready'), this.deps.idleMs ?? 15 * 60000)
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
    return { version: 1, requestId: request?.requestId, policyRevision: request?.policyRevision, status }
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

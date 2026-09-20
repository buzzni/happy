import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import tweetnacl from 'tweetnacl'
import { encodeBase64, getRandomBytes } from '@/api/encryption'
import {
  DifficultyRoutingClassifierHost,
  createDifficultyRoutingHostKey,
  type DifficultyRoutingRelayRequest,
  type DifficultyRoutingRelayRequestLegacy,
} from './difficultyRoutingClassifierHost'

class FakeWorker extends EventEmitter {
  sent: unknown[] = []
  connected = true
  send(message: unknown) {
    this.sent.push(message)
  }
  kill() {
    this.connected = false
    this.emit('exit', 0)
  }
}

function seal(text: string, publicKey: Uint8Array): DifficultyRoutingRelayRequest['sealedText'] {
  const ephemeral = tweetnacl.box.keyPair()
  const nonce = getRandomBytes(tweetnacl.box.nonceLength)
  const ciphertext = tweetnacl.box(new TextEncoder().encode(text), nonce, publicKey, ephemeral.secretKey)
  return {
    alg: 'x25519-xsalsa20-poly1305',
    nonce: encodeBase64(nonce),
    ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
    ciphertext: encodeBase64(ciphertext),
  }
}

function request(key = createDifficultyRoutingHostKey(), requestId = 'req-1'): DifficultyRoutingRelayRequestLegacy {
  return {
    version: 1,
    requestId,
    signedGrant: `signed-${requestId}`,
    policyRevision: 3,
    sourceMachineId: 'source-1',
    hostMachineId: 'host-1',
    hostProcessKeyId: key.id,
    deadlineAt: Date.now() + 1000,
    sealedText: seal('classify me', key.publicKey),
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000) })
afterEach(() => vi.useRealTimers())
function setup(over: { idleMs?: number } = {}) {
  const key = createDifficultyRoutingHostKey(), worker = new FakeWorker()
  const authorize = vi.fn(async (_request: DifficultyRoutingRelayRequest, _signal: AbortSignal) => true)
  const spawnWorker = vi.fn(() => worker as never)
  const host = new DifficultyRoutingClassifierHost(key, { spawnWorker, authorize, idleMs: 10000, hangGraceMs: 100, ...over })
  return { host, key, worker, authorize, spawnWorker }
}
function ready(f: ReturnType<typeof setup>) {
  f.host.setEnabled(true)
  f.worker.emit('message', { type: 'ready', classifierRevision: 'rev' })
}
describe('native classifier lifecycle and trust boundary', () => {
  it('keeps the default worker warm past 15 minutes and releases it after 60 idle minutes', async () => {
    const f = setup({ idleMs: undefined }); ready(f)
    await vi.advanceTimersByTimeAsync(59 * 60000)
    expect(f.worker.connected).toBe(true)
    expect(f.spawnWorker).toHaveBeenCalledTimes(1)
    const pending = f.host.classify(request(f.key))
    await vi.advanceTimersByTimeAsync(0)
    f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
    await expect(pending).resolves.toMatchObject({ status: 'ok' })
    expect(f.spawnWorker).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(59 * 60000)
    expect(f.worker.connected).toBe(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.worker.connected).toBe(false)
    expect(f.host.capability().ready).toBe(false)
    f.host.terminate()
  })

  it('does not spawn while OFF and returns immediately while preparing', async () => {
    const f = setup()
    await expect(f.host.classify(request(f.key))).resolves.toMatchObject({ status: 'revoked' })
    expect(f.spawnWorker).not.toHaveBeenCalled()
    f.host.setEnabled(true)
    expect(f.worker.sent).toEqual([{ type: 'prepare' }])
    await expect(f.host.classify(request(f.key))).resolves.toMatchObject({ status: 'not-ready' })
    f.host.terminate()
  })
  it('revalidates authority at dequeue before opening sealed text', async () => {
    const f = setup(); ready(f)
    f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(f.host.classify(request(f.key))).resolves.toMatchObject({ status: 'revoked' })
    expect(f.worker.sent).toEqual([{ type: 'prepare' }]); f.host.terminate()
  })
  it('retains the native slot after deadline and terminates a hung worker', async () => {
    const f = setup(); ready(f)
    const first = f.host.classify(request(f.key, 'one'))
    await vi.advanceTimersByTimeAsync(0)
    const second = f.host.classify(request(f.key, 'two'))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(first).resolves.toMatchObject({ status: 'expired' })
    expect(f.worker.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.worker.connected).toBe(false)
    await expect(second).resolves.toMatchObject({ status: 'expired' }); f.host.terminate()
  })
  it('bounds admission, rejects replay and settles every caller on OFF', async () => {
    const f = setup(); ready(f)
    const first = request(f.key, 'one'), pending = [f.host.classify(first)]
    await vi.advanceTimersByTimeAsync(0)
    await expect(f.host.classify(first)).resolves.toMatchObject({ status: 'revoked' })
    for (let i = 0; i < 8; i++) pending.push(f.host.classify(request(f.key, `queue-${i}`)))
    await vi.advanceTimersByTimeAsync(0)
    await expect(f.host.classify(request(f.key, 'overflow'))).resolves.toMatchObject({ status: 'busy' })
    f.host.setEnabled(false)
    expect((await Promise.all(pending)).every(r => r.status === 'revoked')).toBe(true)
    expect(f.worker.connected).toBe(false)
  })
  it('does not let invalid authorizations consume the replay cache', async () => {
    const f = setup(); ready(f)
    f.authorize.mockResolvedValue(false)
    const base = request(f.key)
    for (let i = 0; i < 1025; i++) {
      await expect(f.host.classify({ ...base, signedGrant: `invalid-${i}` })).resolves.toMatchObject({ status: 'revoked' })
    }
    expect(f.worker.sent).toEqual([{ type: 'prepare' }])
    f.authorize.mockResolvedValue(true)
    const valid = f.host.classify({ ...base, signedGrant: 'valid-after-invalid' })
    await vi.advanceTimersByTimeAsync(0)
    f.worker.emit('message', { type: 'result', requestId: base.requestId, difficulty: 'hard', classifierRevision: 'rev' })
    await expect(valid).resolves.toMatchObject({ status: 'ok' })
    f.host.terminate()
  })
  it('reserves the process until exit even when kill has already been requested', async () => {
    const f = setup(); ready(f)
    const kill = vi.spyOn(f.worker, 'kill').mockImplementation(() => { f.worker.connected = false })
    f.host.setEnabled(false)
    expect(kill).toHaveBeenCalledOnce()
    f.host.setEnabled(true)
    await expect(f.host.classify(request(f.key))).resolves.toMatchObject({ status: 'not-ready' })
    expect(f.spawnWorker).toHaveBeenCalledOnce()
    f.worker.emit('message', { type: 'ready', classifierRevision: 'stale' })
    expect(f.host.capability().ready).toBe(false)
    f.worker.emit('exit', 0)
    f.host.prepare()
    expect(f.spawnWorker).toHaveBeenCalledTimes(2)
    f.host.terminate()
  })
  it('sends only bounded text and releases memory by process exit after idle', async () => {
    const f = setup(); ready(f)
    const large = request(f.key, 'large'); large.sealedText = seal('x'.repeat(8001), f.key.publicKey)
    await expect(f.host.classify(large)).resolves.toMatchObject({ status: 'error' })
    const result = f.host.classify(request(f.key, 'good'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.worker.sent.at(-1)).toEqual({ type: 'classify', requestId: 'good', text: 'classify me', maxInputTokens: 512 })
    f.worker.emit('message', { type: 'result', requestId: 'good', difficulty: 'hard', classifierRevision: 'rev' })
    await expect(result).resolves.toMatchObject({ status: 'ok', difficulty: 'hard' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.worker.connected).toBe(false); f.host.terminate()
  })
})

// The whole point of timing v2: this host must behave identically no matter how far its own
// wall clock sits from the machine that sent the request. `vi.setSystemTime` moves the wall
// clock alone — fake timers keep `performance.now()` (the monotonic source) on the timer clock.
describe('timing v2 wire and clock independence', () => {
  function v2(key: ReturnType<typeof createDifficultyRoutingHostKey>, over: Record<string, unknown> = {}): DifficultyRoutingRelayRequest {
    const { deadlineAt: _legacy, ...rest } = request(key)
    return { ...rest, timingVersion: 2, remainingMs: 500, ...over } as DifficultyRoutingRelayRequest
  }

  it('refuses a body that mixes the two contracts or omits the budget', async () => {
    const f = setup(); ready(f)
    for (const over of [
      { deadlineAt: Date.now() + 800 },
      { remainingMs: undefined },
      { remainingMs: 0 },
      { remainingMs: 3001 },
      { remainingMs: 1.5 },
      { remainingMs: '500' },
      { remainingMs: null },
    ]) {
      await expect(f.host.classify(v2(f.key, over)), JSON.stringify(over)).resolves.toMatchObject({ status: 'error' })
    }
    // A budget with no discriminator is not a v2 request and has no legacy deadline either.
    const { deadlineAt: _d, ...bare } = request(f.key)
    await expect(f.host.classify({ ...bare, remainingMs: 500 } as never)).resolves.toMatchObject({ status: 'error' })
    expect(f.worker.sent).toEqual([{ type: 'prepare' }])
    f.host.terminate()
  })

  it('reports an unknown timing contract as unsupported rather than guessing', async () => {
    const f = setup(); ready(f)
    for (const timingVersion of [1, 3, '2', null, true]) {
      await expect(f.host.classify(v2(f.key, { timingVersion })), String(timingVersion))
        .resolves.toMatchObject({ status: 'unsupported' })
    }
    f.host.terminate()
  })

  it('accepts both edges of the allowed budget and echoes the contract back', async () => {
    for (const remainingMs of [1, 3000]) {
      const f = setup(); ready(f)
      const pending = f.host.classify(v2(f.key, { remainingMs }))
      await vi.advanceTimersByTimeAsync(0)
      f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
      await expect(pending).resolves.toMatchObject({ status: 'ok', difficulty: 'hard', timingVersion: 2 })
      f.host.terminate()
    }
  })

  it('leaves the legacy contract answering without a timing version', async () => {
    const f = setup(); ready(f)
    const pending = f.host.classify(request(f.key))
    await vi.advanceTimersByTimeAsync(0)
    f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
    const answer = await pending
    expect(answer).toMatchObject({ status: 'ok' })
    expect(answer).not.toHaveProperty('timingVersion')
    f.host.terminate()
  })

  // A legacy request carries the *sender's* absolute instant. When this host's wall clock sits
  // an hour away, that instant lands outside the accepted window and the turn dies — which is
  // exactly the production failure. The same work expressed as a duration must survive it.
  it('survives a wall clock that a legacy deadline could not', async () => {
    const legacy = setup(); ready(legacy)
    const staleDeadline = { ...request(legacy.key), deadlineAt: Date.now() + 3_600_000 }
    await expect(legacy.host.classify(staleDeadline)).resolves.toMatchObject({ status: 'error' })
    legacy.host.terminate()

    for (const skewMs of [3_600_000, -3_600_000]) {
      const f = setup(); ready(f)
      vi.setSystemTime(1000 + skewMs)
      const pending = f.host.classify(v2(f.key))
      await vi.advanceTimersByTimeAsync(0)
      expect(f.worker.sent.at(-1)).toMatchObject({ type: 'classify', text: 'classify me' })
      f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
      await expect(pending, `skew ${skewMs}`).resolves.toMatchObject({ status: 'ok', difficulty: 'hard' })
      vi.setSystemTime(1000)
      f.host.terminate()
    }
  })

  it('measures elapsed time on the monotonic clock, never the wall clock', async () => {
    const f = setup(); ready(f)
    const pending = f.host.classify(v2(f.key))
    await vi.advanceTimersByTimeAsync(120)
    // A wall clock jump backwards must not produce a negative or wildly wrong elapsed.
    vi.setSystemTime(1000 - 3_600_000)
    f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
    await expect(pending).resolves.toMatchObject({ status: 'ok', elapsedMs: 120 })
    vi.setSystemTime(1000)
    f.host.terminate()
  })

  // Waiting behind another request spends the same budget. The dequeue must not hand out a
  // fresh one — otherwise a queued turn is dispatched long after its caller stopped waiting.
  it('never restarts the budget at dequeue, so a queued turn dies instead of being dispatched', async () => {
    const f = setup(); ready(f)
    const first = f.host.classify(v2(f.key, { remainingMs: 1000, requestId: 'req-1' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.worker.sent.at(-1)).toMatchObject({ type: 'classify', requestId: 'req-1' })

    const queued = f.host.classify(v2(f.key, { remainingMs: 200, requestId: 'req-2', signedGrant: 'signed-req-2' }))
    await vi.advanceTimersByTimeAsync(250)
    await expect(queued).resolves.toMatchObject({ status: 'expired' })
    // Never dispatched: only the first request ever reached the worker.
    expect(f.worker.sent.filter((m) => (m as { type: string }).type === 'classify')).toHaveLength(1)

    f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
    await first
    f.host.terminate()
  })

  // A generous turn budget is not a licence for a slow validation call.
  it('gives up on a silent validation at 250ms even when the budget is far larger', async () => {
    const f = setup(); ready(f)
    let abortedAt: number | null = null
    f.authorize.mockImplementation(async (_request: unknown, signal: AbortSignal) => {
      signal.addEventListener('abort', () => { abortedAt = performance.now() }, { once: true })
      return new Promise<boolean>(() => {})
    })

    const pending = f.host.classify(v2(f.key, { remainingMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toMatchObject({ status: 'revoked' })
    expect(abortedAt).toBe(250)
    expect(f.worker.sent).toEqual([{ type: 'prepare' }])
    f.host.terminate()
  })

  // Re-validation at dequeue gets what is LEFT, not a fresh allowance. Otherwise the
  // authorization HTTP call outlives the turn it was authorizing.
  it('aborts a dequeued re-validation on the remaining budget, not a fresh 250ms', async () => {
    const f = setup(); ready(f)
    let calls = 0
    let lastCallAt = 0
    let abortedAt: number | null = null
    f.authorize.mockImplementation(async (_request: unknown, signal: AbortSignal) => {
      calls++
      if (calls < 4) return true
      // The dequeue re-check: never answers, so only the host's own deadline ends it.
      lastCallAt = performance.now()
      signal.addEventListener('abort', () => { abortedAt = performance.now() }, { once: true })
      return new Promise<boolean>(() => {})
    })

    const first = f.host.classify(v2(f.key, { remainingMs: 1000, requestId: 'req-1' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.worker.sent.at(-1)).toMatchObject({ type: 'classify', requestId: 'req-1' })

    const queued = f.host.classify(v2(f.key, { remainingMs: 300, requestId: 'req-2', signedGrant: 'signed-req-2' }))
    await vi.advanceTimersByTimeAsync(200)
    f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
    await first
    await vi.advanceTimersByTimeAsync(200)
    await queued

    // 300ms budget, 200ms already spent waiting in the queue → 100ms left, not 250.
    expect(abortedAt! - lastCallAt).toBe(100)
    f.host.terminate()
  })

  it('keeps a consumed grant out of reach past the longest life a server could still honour', async () => {
    const f = setup({ idleMs: 10 * 60_000 }); ready(f)
    const first = f.host.classify(v2(f.key))
    await vi.advanceTimersByTimeAsync(0)
    f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
    await first

    // Same signed grant, new turn id: still a replay.
    await expect(f.host.classify(v2(f.key, { requestId: 'req-2' }))).resolves.toMatchObject({ status: 'revoked' })
    // 60s grant life + 15s of future-iat the server still accepts + the exp-equality millisecond.
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(f.host.classify(v2(f.key, { requestId: 'req-3' }))).resolves.toMatchObject({ status: 'revoked' })
    await vi.advanceTimersByTimeAsync(15_002)
    const reused = f.host.classify(v2(f.key, { requestId: 'req-4' }))
    await vi.advanceTimersByTimeAsync(0)
    // Past the window it is admitted again and actually reaches the worker.
    expect(f.worker.sent.at(-1)).toMatchObject({ type: 'classify', requestId: 'req-4' })
    f.worker.emit('message', { type: 'result', requestId: 'req-4', difficulty: 'hard', classifierRevision: 'rev' })
    await expect(reused).resolves.toMatchObject({ status: 'ok' })
    f.host.terminate()
  })

  it('holds the replay window on the monotonic clock', async () => {
    const f = setup(); ready(f)
    const first = f.host.classify(v2(f.key))
    await vi.advanceTimersByTimeAsync(0)
    f.worker.emit('message', { type: 'result', requestId: 'req-1', difficulty: 'hard', classifierRevision: 'rev' })
    await first

    // A wall clock leap must not expire the record early.
    vi.setSystemTime(1000 + 3_600_000)
    await expect(f.host.classify(v2(f.key, { requestId: 'req-2' }))).resolves.toMatchObject({ status: 'revoked' })
    vi.setSystemTime(1000)
    f.host.terminate()
  })
})

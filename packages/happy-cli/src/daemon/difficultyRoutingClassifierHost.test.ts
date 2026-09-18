import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import tweetnacl from 'tweetnacl'
import { encodeBase64, getRandomBytes } from '@/api/encryption'
import {
  DifficultyRoutingClassifierHost,
  createDifficultyRoutingHostKey,
  type DifficultyRoutingRelayRequest,
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

function request(key = createDifficultyRoutingHostKey(), requestId = 'req-1'): DifficultyRoutingRelayRequest {
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
function setup() {
  const key = createDifficultyRoutingHostKey(), worker = new FakeWorker()
  const authorize = vi.fn(async () => true), spawnWorker = vi.fn(() => worker as never)
  const host = new DifficultyRoutingClassifierHost(key, { spawnWorker, authorize, idleMs: 10000, hangGraceMs: 100 })
  return { host, key, worker, authorize, spawnWorker }
}
function ready(f: ReturnType<typeof setup>) {
  f.host.setEnabled(true)
  f.worker.emit('message', { type: 'ready', classifierRevision: 'rev' })
}
describe('native classifier lifecycle and trust boundary', () => {
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

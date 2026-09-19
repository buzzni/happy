import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDifficultyRouting } from './difficultyRoutingRuntime'
import { DifficultyRoutingClassifierHost, createDifficultyRoutingHostKey } from './daemon/difficultyRoutingClassifierHost'

const intent = { version: 1, mode: 'auto', policy: 'org-shared-difficulty-routing.v1', clientRequestId: 'turn-flow', clientRouteSource: 'default-auto' }
const text = 'Add a save button to the draft form'
const input = { agent: 'codex' as const, sourceMachineId: 'source', sessionId: 'session', contentText: 'SYSTEM WRAPPER: ' + text,
  meta: { difficultyRoutingIntent: intent, difficultyRoutingAuthorization: 'turn-authority', difficultyRoutingPrompt: text, modelSource: 'auto', model: 'fallback-model' }, current: { model: 'fallback-model' } }
let host: DifficultyRoutingClassifierHost | undefined
afterEach(() => { host?.terminate(); host = undefined; vi.unstubAllGlobals() })

function setup(options: { revoke?: boolean; wrongResponse?: boolean } = {}) {
  const key = createDifficultyRoutingHostKey()
  const received: Record<string, unknown>[] = []
  const worker = new EventEmitter() as EventEmitter & { send: (message: Record<string, unknown>) => void; kill: () => void }
  worker.kill = () => { worker.emit('exit', 0) }
  worker.send = message => {
    if (message.type === 'prepare') queueMicrotask(() => worker.emit('message', { type: 'ready', classifierRevision: 'fixed-artifact' }))
    else {
      received.push(message)
      queueMicrotask(() => worker.emit('message', { type: 'result', requestId: message.requestId, difficulty: 'hard', classifierRevision: 'fixed-artifact' }))
    }
  }
  const authorize = vi.fn(async () => !options.revoke)
  host = new DifficultyRoutingClassifierHost(key, { spawnWorker: () => worker as never, authorize })
  host.setEnabled(true)
  const requests: { path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, body = JSON.parse(String(init.body))
    requests.push({ path, body })
    expect(String(init.body)).not.toContain(text)
    expect(String(init.body)).not.toContain('SYSTEM WRAPPER')
    if (path.endsWith('/grant')) {
      expect(body).toMatchObject({ authorization: 'turn-authority', sourceMachineId: 'source', sessionId: 'session', clientRequestId: 'turn-flow' })
      return Response.json({ ok: true, aiModelPolicy: { source: 'unrestricted', allowedSelectionKeys: null, defaultSelectionKey: null }, signedGrant: 'validated-grant', grant: { version: 1, grantId: 'grant-flow', policyRevision: 4, expiresAt: Date.now() + 10000, sourceMachineId: 'source', hostMachineId: 'host', hostProcessKeyId: key.id, hostProcessPublicKey: Buffer.from(key.publicKey).toString('base64'), maxInputChars: 8000, modelMaxInputTokens: 512, relayDeadlineAt: Date.now() + 750 } })
    }
    expect(path.endsWith('/classify')).toBe(true)
    const result = await host!.classify(body)
    return Response.json({ ok: true, result: options.wrongResponse ? { ...result, requestId: 'other-turn' } : result })
  }))
  return { received, authorize, requests }
}

describe('sealed shared classifier flow', () => {
  it('sends only original text to the native worker and returns its actual model decision', async () => {
    const f = setup()
    const result = await resolveDifficultyRouting(input)
    expect(f.requests).toHaveLength(2)
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect(f.received).toEqual([{ type: 'classify', requestId: 'turn-flow', text, maxInputTokens: 512 }])
    expect(result?.route).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', difficulty: 'hard' })
    expect(result?.event.ev).toMatchObject({ t: 'difficulty-routing', result: { model: 'gpt-5.6-sol', classifierSource: 'p2-org-shared', policyRevision: 4 } })
  })
  it('does not decrypt after revocation and falls back to local P1', async () => {
    const f = setup({ revoke: true })
    const result = await resolveDifficultyRouting(input)
    expect(f.received).toEqual([])
    expect(result?.route.difficulty).toBe('routine')
    expect(result?.event.ev).toMatchObject({ result: { classifierSource: 'fallback-p1' } })
  })
  it('discards a response bound to another turn', async () => {
    setup({ wrongResponse: true })
    const result = await resolveDifficultyRouting(input)
    expect(result?.route.difficulty).toBe('routine')
    expect(result?.event.ev).toMatchObject({ result: { classifierSource: 'fallback-p1' } })
  })
  it('preserves manual choices without any classification request', async () => {
    const f = setup()
    expect(await resolveDifficultyRouting({ ...input, meta: { ...input.meta, modelSource: 'user' } })).toBeNull()
    expect(f.requests).toEqual([])
  })
})

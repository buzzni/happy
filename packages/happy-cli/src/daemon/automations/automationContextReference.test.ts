import { afterEach, beforeEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { automationExecutionSeedSchema, createEnvelope, sessionCreateBodyHash, type SessionEnvelope } from '@slopus/happy-wire'
import { encrypt, encodeBase64 } from '@/api/encryption'
import type { AutomationContextLaunchRecord } from './automationContextLaunch'
import { createAutomationContextReferenceReader } from './automationContextReference'

let server: Server, origin: string, mode: string, paths: string[]
let record: ReturnType<typeof fixture> | null
const key = new Uint8Array(32).fill(7)
const input = { automationId: 'a1', generation: 2, revision: 3, displaySessionId: 'manual' }
function fixture() {
  const seed = automationExecutionSeedSchema.parse({ version: 1, automationId: 'a1', runId: 'prior', generation: 1, revision: 2,
    displaySessionId: 'manual', question: 'Authored question only', inputBytes: 1000, referenceBytes: 0,
    inputSha256: 'a'.repeat(64), references: [], wholeContextTokens: 'unknown' })
  const { question, ...fields } = seed
  const manifest = { ...fields, questionBytes: Buffer.byteLength(question), seedSha256: createHash('sha256').update(JSON.stringify(seed)).digest('hex') }
  const encrypted = (data: unknown) => encodeBase64(encrypt(key, mode === 'data-key' ? 'dataKey' : 'legacy', data))
  const body = { tag: 'automation-run:prior', metadata: encrypted({ flavor: 'claude', automationExecutionSeedManifest: manifest }), agentState: null,
    ...(mode === 'data-key' ? { dataEncryptionKey: Buffer.alloc(105, 4).toString('base64') } : {}) }
  const row = (seq: number, ev: SessionEnvelope['ev']) => {
    const envelope = createEnvelope('agent', ev, { turn: 'answer-turn' })
    return { seq, localId: `automation-evidence:prior:${envelope.id}`, content: { t: 'encrypted', c: encrypted({ role: 'session', content: envelope }) } }
  }
  return { body, seedMessage: { seq: 1, localId: 'automation-seed:prior', content: { t: 'encrypted',
    c: encrypted({ type: 'automation-execution-seed', seed: mode === 'bad-seed' ? { ...seed, question: 'tampered' } : seed }) } },
  messages: [row(2, { t: 'turn-start' }), row(3, { t: 'final-answer', text: 'Selected answer only' }),
    row(4, { t: 'turn-end', status: mode === 'failed' ? 'failed' : 'completed' })] }
}
beforeEach(async () => {
  mode = 'valid'; paths = []; record = null
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture')
    paths.push(req.url!)
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return }
    if (mode === 'denied') { res.writeHead(403).end('{}'); return }
    if (mode === 'deleted') { res.writeHead(404).end('{}'); return }
    res.setHeader('Content-Type', 'application/json')
    const f = record ??= fixture()
    if (url.pathname === '/v1/automations/a1/execution-reference') {
      expect(url.searchParams.get('machineId')).toBe('m1')
      expect(url.searchParams.get('generation')).toBe('2')
      expect(url.searchParams.get('revision')).toBe('3')
      if (mode === 'none' || url.searchParams.get('beforeRunId') === 'prior' && mode !== 'cycle') {
        res.end(JSON.stringify({ status: 'NONE_ELIGIBLE', automationId: 'a1' })); return
      }
      res.end(JSON.stringify({ status: 'CANDIDATE', automationId: mode === 'foreign' ? 'other' : 'a1', runId: 'prior', generation: 1,
        displaySessionId: 'manual', executionSessionId: 'automation-run:prior', previousRunId: mode === 'cycle' ? 'prior' : null,
        createBodyHash: await sessionCreateBodyHash(f.body), executionExitReceipt: { version: 1, provider: 'claude', observedAt: 1,
          receivedAt: 2, providerExitedCleanly: true, foregroundDrained: true, backgroundDrained: mode !== 'partial', writeProducersDrained: true } })); return
    }
    if (url.pathname === '/v1/sessions/manual/automation-runs/prior/evidence') {
      const after = Number(url.searchParams.get('after_seq') ?? 0)
      const paginated = mode === 'pages' || mode === 'changed-pages'
      res.end(JSON.stringify({ runId: 'prior', automationId: 'a1', generation: 1, displaySessionId: 'manual', executionSessionId: 'automation-run:prior',
        seedManifestCiphertext: f.body.metadata, seedMessage: after ? null : f.seedMessage,
        dataEncryptionKey: mode === 'missing-key' ? 'new-key-requiring-private-journal' : f.body.dataEncryptionKey ?? null,
        throughSeq: after && mode === 'changed-pages' ? 5 : 4,
        messages: mode === 'cycle' || mode === 'pending' ? f.messages.slice(0, 2)
          : paginated ? after ? f.messages.slice(2) : f.messages.slice(0, 2) : f.messages,
        nextAfterSeq: paginated && !after ? 3 : null })); return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
function reader() {
  return createAutomationContextReferenceReader({ serverUrl: origin, token: 'fixture-token', accountId: 'owner', machineId: 'm1',
    journal: { read: async () => null }, legacySecret: key })
}
it('returns a proven empty history without interpreting it as missing data', async () => {
  mode = 'none'
  expect(await reader().resolve(input)).toEqual({ status: 'NONE_ELIGIBLE', automationId: 'a1' })
  expect(paths).toHaveLength(1)
})
it.each(['valid', 'pages'])('verifies encrypted authored question and completed native answer without forwarding a prior bundle: %s', async value => {
  mode = value
  expect(await reader().resolve(input)).toEqual({ automationId: 'a1', runId: 'prior', revision: 2, status: 'COMPLETED',
    question: 'Authored question only', answer: 'Selected answer only' })
  if (mode === 'pages') expect(paths.filter(path => path.includes('/evidence'))).toHaveLength(2)
})
it('skips a verified failed native answer and follows its retained history instead of using dispatch status', async () => {
  mode = 'failed'
  expect(await reader().resolve(input)).toEqual({ status: 'NONE_ELIGIBLE', automationId: 'a1' })
  expect(paths.at(-1)).toContain('beforeRunId=prior')
})
it.each(['denied', 'deleted', 'foreign', 'partial', 'missing-key', 'bad-seed', 'pending', 'changed-pages', 'cycle'])(
  'holds an unavailable or unconfirmed source without an empty-history fallback: %s', async value => {
    mode = value
    await expect(reader().resolve(input)).rejects.toThrow(/AUTOMATION_REFERENCE_/)
  })

it.each(['valid', 'scope', 'key', 'body'] as const)('uses only the scoped original private dataKey creation record: %s', async variant => {
  mode = 'data-key'; record = fixture()
  const original: AutomationContextLaunchRecord = { version: 1,
    scope: createHash('sha256').update(JSON.stringify([origin, 'owner', 'm1'])).digest('hex'), requestHash: 'a'.repeat(64),
    automationId: 'a1', generation: 1, revision: 2, runId: 'prior', displaySessionId: 'manual',
    phase: 'started', sessionId: 'automation-run:prior', prepared: { body: record.body,
      encryptionKey: encodeBase64(key), encryptionVariant: 'dataKey',
      seedMessage: { localId: 'automation-seed:prior', content: record.seedMessage.content.c } } }
  if (variant === 'scope') original.scope = '0'.repeat(64)
  if (variant === 'key') original.prepared.encryptionKey = encodeBase64(new Uint8Array(32).fill(8))
  if (variant === 'body') original.prepared.body = { ...original.prepared.body, agentState: 'different-original-body' }
  const source = createAutomationContextReferenceReader({ serverUrl: origin, token: 'fixture-token', accountId: 'owner', machineId: 'm1',
    journal: { read: async () => original } })
  if (variant === 'valid') expect(await source.resolve(input)).toMatchObject({ status: 'COMPLETED', runId: 'prior', answer: 'Selected answer only' })
  else await expect(source.resolve(input)).rejects.toThrow('AUTOMATION_REFERENCE_UNAVAILABLE')
})

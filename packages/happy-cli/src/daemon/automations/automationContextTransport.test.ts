import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationPayload } from '@slopus/happy-wire'
import { ApiClient } from '@/api/api'
import { createAutomationContextLaunchJournal } from './automationContextLaunchJournal'
import { createAutomationContextLauncher } from './automationContextLaunch'
import { createAutomationContextTransport } from './automationContextTransport'

let home: string, server: Server, origin: string
let seed: { localId: string; content: string } | null, stored: Record<string, unknown> | null
let loseSeedAck: boolean, redirectLookup: boolean, wrongKey: boolean
const requests: Array<{ path: string; authorization: string; body: any }> = []
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'automation-context-http-'))
  requests.length = 0; seed = null; stored = null; loseSeedAck = false; redirectLookup = false; wrongKey = false
  server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : null
    requests.push({ path: req.url!, authorization: req.headers.authorization ?? '', body })
    if (req.headers.authorization !== 'Bearer fixture-account-token') { res.writeHead(401).end(); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/automation-runs/r1/execution-session') {
      if (body.claimToken !== 'fixture-claim' || body.machineId !== 'm1' || body.targetProof !== 'fixture-target-proof') { res.writeHead(403).end('{}'); return }
      stored ??= { id: body.body.tag, seq: 0, metadata: body.body.metadata, metadataVersion: 0,
        agentState: body.body.agentState, agentStateVersion: 0, dataEncryptionKey: body.body.dataEncryptionKey }
      res.end(JSON.stringify({ sessionId: stored.id, displaySessionId: 'manual', created: !seed })); return
    }
    if (req.url === '/v2/sessions/lookup') {
      if (redirectLookup) { res.writeHead(302, { Location: '/unexpected-redirect' }).end(); return }
      res.end(JSON.stringify({ sessions: stored ? [{ ...stored, ...(wrongKey ? { dataEncryptionKey: 'foreign-key' } : {}) }] : [] })); return
    }
    if (req.url === '/v3/sessions/automation-run%3Ar1/messages') {
      seed ??= body.messages[0]
      if (stored) stored.seq = 1
      if (loseSeedAck) { loseSeedAck = false; req.socket.destroy(); return }
      res.end(JSON.stringify({ messages: [{ id: 'stored-seed', localId: seed!.localId, seq: 1 }] })); return
    }
    if (req.url === '/v3/sessions/automation-run%3Ar1/messages?after_seq=0&limit=1') {
      res.end(JSON.stringify({ messages: seed ? [{ id: 'stored-seed', localId: seed.localId, seq: 1,
        content: { t: 'encrypted', c: seed.content } }] : [], hasMore: false })); return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
})
async function setup() {
  const api = await ApiClient.create({ token: 'fixture-account-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } })
  const prepare = vi.spyOn(api, 'prepareSessionCreation')
  const payload: AutomationPayload = { name: 'Task', prompt: 'Current occurrence only', directory: '/work', agent: 'codex',
    scriptCommand: null, suppressSilent: false, schedule: { kind: 'interval', minutes: 60 },
    conversation: { sessionId: 'manual' }, contextPolicy: { kind: 'isolated', reference: null } }
  const input = { automationId: 'a1', generation: 1, revision: 1, runId: 'r1', payload }
  const authorize = vi.fn(async (_target: unknown) => ({ targetProof: 'fixture-target-proof', executionBindingRequired: false }))
  const transport = createAutomationContextTransport({ serverUrl: origin, token: 'fixture-account-token', machineId: 'm1',
    runId: 'r1', claimToken: 'fixture-claim', authorize })
  const start = vi.fn(async () => ({ type: 'success' as const, sessionId: 'automation-run:r1' }))
  const deps = { accountId: 'owner', machineId: 'm1', happyOrigin: origin, api, journal: createAutomationContextLaunchJournal(home),
    ...transport, start, discover: async () => 'unconfirmed' as const }
  return { api, prepare, input, authorize, transport, deps, start, launcher: createAutomationContextLauncher(deps) }
}

it('registers and stores the exact E2EE seed over authenticated HTTP before submitting a provider', async () => {
  const f = await setup()
  expect(await f.launcher.launch(f.input)).toMatchObject({ state: 'started', sessionId: 'automation-run:r1', displaySessionId: 'manual' })
  expect(requests.map(req => req.path)).toEqual(['/v1/automation-runs/r1/execution-session', '/v2/sessions/lookup',
    '/v3/sessions/automation-run%3Ar1/messages', '/v3/sessions/automation-run%3Ar1/messages?after_seq=0&limit=1'])
  expect(requests.every(req => req.authorization === 'Bearer fixture-account-token')).toBe(true)
  expect(requests[0].body).toMatchObject({ machineId: 'm1', claimToken: 'fixture-claim', displaySessionId: 'manual', executionBindingRequired: false })
  expect(f.authorize.mock.calls[0][0]).toMatchObject({ automationId: 'a1', runId: 'r1', generation: 1, revision: 1,
    machineId: 'm1', displaySessionId: 'manual', conversationDirectory: '/work', agent: 'codex' })
  for (const secret of [f.input.payload.prompt, 'encryptionKey', 'seedMessage']) expect(JSON.stringify(f.authorize.mock.calls[0])).not.toContain(secret)
  expect(seed?.localId).toBe('automation-seed:r1')
  expect(seed?.content).not.toContain(f.input.payload.prompt)
  expect(f.start).toHaveBeenCalledOnce()
})

it('recovers a lost HTTP storage ACK with the same ciphertext and no early or duplicate provider', async () => {
  const f = await setup(); loseSeedAck = true
  await expect(f.launcher.launch(f.input)).rejects.toThrow('AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED')
  expect(f.start).not.toHaveBeenCalled()
  const first = structuredClone(seed)
  expect(await createAutomationContextLauncher(f.deps).launch(f.input)).toMatchObject({ state: 'started' })
  expect(seed).toEqual(first)
  const writes = requests.filter(req => req.path.includes('/messages') && req.body?.messages)
  expect(writes).toHaveLength(2)
  expect(writes[0].body).toEqual(writes[1].body)
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.start).toHaveBeenCalledOnce()
})

it('requires a real signed execution proof when the trusted issuer requires one', async () => {
  const f = await setup()
  f.authorize.mockResolvedValue({ targetProof: 'fixture-target-proof', executionBindingRequired: true })
  await expect(f.launcher.launch(f.input)).rejects.toThrow('AUTOMATION_EXECUTION_PROOF_REQUIRED')
  expect(requests).toHaveLength(0)
  expect(f.start).not.toHaveBeenCalled()
})

it.each(['key', 'redirect'])('refuses a mismatched session %s without legacy creation or native dispatch', async reason => {
  const f = await setup(); wrongKey = reason === 'key'; redirectLookup = reason === 'redirect'
  await expect(f.launcher.launch(f.input)).rejects.toThrow(reason === 'key' ? 'AUTOMATION_CONTEXT_RECEIPT_CONFLICT' : 'AUTOMATION_CONTEXT_REQUEST_UNCONFIRMED')
  expect(f.start).not.toHaveBeenCalled()
  expect(requests.some(req => req.path === '/v1/sessions' || req.path === '/unexpected-redirect')).toBe(false)
})

/** Explicit paid opt-in. Only synthetic projects go upstream; the provider key stays in the parent proxy. */
import { query as sdkQuery, type Query } from '@anthropic-ai/claude-agent-sdk'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createNodeAiCredentialRuntime } from '@/daemon/aiCredentialRuntime'
import { captureSaycodeAgentEnvironment, readOrgEndpointResumeSelection } from '@/daemon/sessionEnv'
import { queryWithPinnedEndpoint } from './sdk/credentialPin'
import { orgEndpointRoutingSettingsEnv } from './utils/orgEndpointEnvKeys'

const enabled = process.env.SAYCODE_OPENGATEWAY_LIVE === '1'
const models = ['deepseek/deepseek-v4.1-flash-eco', 'moonshotai/kimi-k3.1-pro'] as const
const outputDir = resolve(process.env.SAYCODE_OPENGATEWAY_EVIDENCE_DIR ?? '.aplus/verification/model-selection/live')
const envFile = resolve(process.env.SAYCODE_OPENGATEWAY_ENV_FILE ?? '.env')
const redact = (s: string, key: string) => s.replaceAll(key, '[REDACTED]')
type Call = { lane: number; model: string; phase: string; status?: number; maxTokens: number; bytes: number; reservedUsd: number; responseModels: string[]; usage: Record<string, unknown>; stopReason?: string; error?: string }

describe.skipIf(!enabled)('paid OpenGateway real Claude CLI verification', () => {
  it('runs files/tests and resumes two isolated bindings without switching models', async () => {
    const line = (await fs.readFile(envFile, 'utf8')).split(/\r?\n/).find(s => s.startsWith('OPEN_GATE_KEY='))
    const key = line?.slice('OPEN_GATE_KEY='.length).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!key) throw new Error('OPEN_GATE_KEY is missing')
    await fs.mkdir(outputDir, { recursive: true })
    const sandbox = join(outputDir, `sandbox-${randomUUID()}`), home = join(sandbox, 'home')
    await fs.mkdir(join(home, '.claude'), { recursive: true })
    const catalogResponse = await fetch('https://apis.opengateway.ai/v1/models', { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!catalogResponse.ok) throw new Error(`catalog HTTP ${catalogResponse.status}`)
    const catalog = await catalogResponse.json() as { data: Array<{ id: string; endpoints: string[]; pricing: Record<string, string> }> }
    const prices = models.map(model => {
      const row = catalog.data.find(r => r.id === model && r.endpoints.includes('messages'))
      if (!row) throw new Error(`Messages not allowed: ${model}`)
      return { input: Math.max(Number(row.pricing.prompt), Number(row.pricing.input_cache_write ?? row.pricing.prompt)) * (model.startsWith('deepseek/') ? 2 : 1), output: Number(row.pricing.completion) * (model.startsWith('deepseek/') ? 2 : 1) }
    })
    if (prices.some(p => !Number.isFinite(p.input) || !Number.isFinite(p.output) || p.input <= 0 || p.output <= 0)) throw new Error('Invalid catalog price')
    const credits = async () => {
      const response = await fetch('https://apis.opengateway.ai/v1/credits', { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) })
      if (!response.ok) return { status: response.status }
      return response.json()
    }
    const before = await credits()
    const calls: Call[] = [], phases = ['initial', 'initial'], authorizations: string[] = []
    const credentials = models.map(() => randomUUID()), secrets = models.map(() => randomUUID().replaceAll('-', '').repeat(2))
    let reservedUsd = 0
    const queries = new Set<Query>()
    const server = createServer(async (req, res) => {
      try {
        const lane = credentials.findIndex(c => req.headers.authorization === `Bearer ${c}`)
        let bytes = Buffer.alloc(0)
        for await (const part of req) { bytes = Buffer.concat([bytes, part]); if (bytes.length > 500000) throw new Error('verification request too large') }
        if (req.url === '/api/org-llm-endpoints/daemon/start-authorize') {
          const index = secrets.findIndex(s => req.headers.authorization === `Bearer ${s}`)
          const body = JSON.parse(bytes.toString())
          if (index < 0 || body.bindingId !== `live-${index}` || authorizations.includes(body.bindingId)) { res.writeHead(403).end(); return }
          authorizations.push(body.bindingId); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return
        }
        if (lane < 0 || !req.url?.match(/^\/v1\/messages(?:\?[^#]*)?$/)) { res.writeHead(403).end(); return }
        const body = JSON.parse(bytes.toString())
        if (body.model !== models[lane] || body.extra?.fallbacks || !Number.isSafeInteger(body.max_tokens) || body.max_tokens > 8192 || calls.length >= 20) { res.writeHead(400).end('{"error":{"message":"verification model/call bound"}}'); return }
        const reserve = (bytes.length + 2048) * prices[lane].input + body.max_tokens * prices[lane].output
        if (reservedUsd + reserve > 2) { res.writeHead(429, { 'x-should-retry': 'false' }).end('{"type":"error","error":{"type":"rate_limit_error","message":"verification budget cap"}}'); return }
        reservedUsd += reserve
        const call: Call = { lane, model: body.model, phase: phases[lane], bytes: bytes.length, maxTokens: body.max_tokens, reservedUsd: reserve, responseModels: [], usage: {} }
        calls.push(call)
        console.log(JSON.stringify({ event: 'provider-request', lane, phase: phases[lane], call: calls.length, conservativeTotalUsd: Number(reservedUsd.toFixed(6)) }))
        const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01') }
        if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta'])
        const upstream = await fetch(`https://apis.opengateway.ai${req.url}`, { method: 'POST', headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(120000) })
        call.status = upstream.status
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'x-should-retry': 'false' })
        let pending = '', total = ''
        if (upstream.body) for await (const chunk of upstream.body) {
          res.write(chunk)
          pending += Buffer.from(chunk).toString(); total += Buffer.from(chunk).toString()
          const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop()!
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
            try { const event = JSON.parse(data); if (event.message?.model) call.responseModels.push(event.message.model); Object.assign(call.usage, event.message?.usage ?? event.usage ?? {}); if (event.delta?.stop_reason) call.stopReason = event.delta.stop_reason } catch { /* keep-alive frames */ }
          }
        }
        if (!upstream.ok) call.error = redact(total.slice(0, 2000), key)
        res.end()
      } catch (error) {
        res.writeHead(502, { 'x-should-retry': 'false' }).end(JSON.stringify({ error: { message: redact(error instanceof Error ? error.message : String(error), key) } }))
      }
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const runtimeEnv = { HAPPY_APLUS_STUDIO_ORIGIN: origin }
    const supervisor = { enable: async () => {}, stop: async () => {}, status: () => ({ state: 'running' as const, lastErrorKind: null }) }
    const runtime = () => createNodeAiCredentialRuntime(supervisor, runtimeEnv, home, { machineId: 'live-machine' })
    const bindings = models.map((model, i) => ({ version: 1, bindingId: `live-${i}`, snapshotId: `snapshot-${i}`, machineId: 'live-machine', selectedModel: model, maxOutputTokens: 4096, launchSecret: secrets[i], companyId: 'synthetic-company', userId: 'synthetic-user', endpoint: { id: 'same-endpoint', generation: 1, model, models: {}, maxContextTokens: 200000, apiTimeoutMs: 120000, authMode: 'static-token', token: credentials[i], targets: [{ id: 'target', url: 'https://apis.opengateway.ai' }] } }))
    const selections = bindings.map(b => ({ kind: 'org-endpoint' as const, bindingId: b.bindingId, snapshotId: b.snapshotId, endpointId: 'same-endpoint', generation: 1, candidates: ['target'] }))
    const results: Array<Record<string, unknown>> = []
    try {
      const machine = runtime()
      for (const i of [1, 0]) await machine.orgLlmModelBindingSync(bindings[i])
      const environments = await Promise.all(selections.map(s => machine.sessionEnvironment('claude', s)))
      const runLane = async (i: number) => {
        const project = join(sandbox, `lane-${i}`), token = `MEMORY-${randomUUID()}`, laneLabel = `LANE_${i}`
        await fs.mkdir(join(project, '.claude'), { recursive: true })
        await fs.writeFile(join(project, 'calc.mjs'), `export const lane = '${laneLabel}';\nexport function add(a,b) { return a-b; }\n`)
        const tests = `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as calc from './calc.mjs';\ntest('add',()=>assert.equal(calc.add(2,3),5));\ntest('isolation',()=>assert.equal(calc.lane,'${laneLabel}'));\n`
        await fs.writeFile(join(project, 'calc.test.mjs'), tests)
        await fs.writeFile(join(project, '.claude/settings.json'), JSON.stringify({ apiKeyHelper: 'printf wrong-key', env: { ANTHROPIC_MODEL: models[1-i], ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'wrong-key' } }))
        const queryPhase = async (environment: Record<string,string>, prompt: string, resume?: string) => {
          const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, OPEN_GATE_KEY:'', OPENGATEWAY_API_KEY:'', ...environment, ANTHROPIC_BASE_URL: origin, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
          expect(env.ANTHROPIC_MODEL).toBe(models[i])
          const abortController = new AbortController(), timer = setTimeout(() => abortController.abort(), 170000)
          const q = queryWithPinnedEndpoint(sdkQuery, { prompt, options: {
            cwd: project, env, model: models[i], effort: 'medium', tools: ['Read','Write','Bash'], maxTurns: 8, persistSession: true, ...(resume ? {resume} : {}), abortController,
            systemPrompt: 'You are testing a small synthetic project. Only read or write calc.mjs and calc.test.mjs in cwd. Never inspect parent directories or other files. Use Bash only for the exact command node --test calc.test.mjs. Do the requested file edits and actually run the tests.',
            settingSources: ['user','project','local'], settings: { env: orgEndpointRoutingSettingsEnv(env) },
            canUseTool: async (name, input) => {
              const value = input as Record<string,unknown>, p = typeof value.file_path === 'string' ? resolve(project, value.file_path) : ''
              const inside = p && !isAbsolute(relative(project,p)) && !relative(project,p).startsWith('..') && ['calc.mjs','calc.test.mjs'].includes(relative(project,p))
              const allowed = name === 'Bash' ? String(value.command).trim() === 'node --test calc.test.mjs' : (name === 'Read' || name === 'Write') && inside
              return allowed ? { behavior: 'allow' as const, updatedInput: input } : { behavior: 'deny' as const, message: 'Only the two synthetic files and exact test command are allowed.' }
            },
          } }, env)
          queries.add(q)
          const messages: unknown[] = [], toolNames: string[] = []; let sessionId = '', lastResult: Record<string,unknown> | undefined
          try {
            for await (const message of q) {
              messages.push(message)
              if ('session_id' in message) sessionId = String(message.session_id)
              if (message.type === 'assistant') for (const block of message.message.content) if (block.type === 'tool_use') toolNames.push(block.name)
              if (message.type === 'result') lastResult = message as unknown as Record<string,unknown>
            }
            if (lastResult?.is_error || !lastResult) throw new Error(`CLI result ${String(lastResult?.subtype ?? 'missing')}`)
            return { sessionId, toolNames, text: JSON.stringify(messages), result: lastResult }
          } finally { clearTimeout(timer); q.close(); queries.delete(q) }
        }
        const initial = await queryPhase(environments[i], `Fix the broken add function using Read and Write, preserving the lane export. Run exactly node --test calc.test.mjs using Bash, ensure it passes. Remember this conversation-only token: ${token}. End with DONE and the token.`)
        expect(initial.toolNames).toContain('Write'); expect(initial.toolNames).toContain('Bash')
        expect(initial.text).toContain(token)
        execFileSync(process.execPath, ['--test', 'calc.test.mjs'], { cwd: project, timeout: 10000 })
        await fs.writeFile(join(project, 'calc.test.mjs'), tests+"test('subtract',()=>assert.equal(calc.subtract(9,4),5));\n")
        phases[i] = 'resume'
        const selection = readOrgEndpointResumeSelection(captureSaycodeAgentEnvironment(environments[i]))
        expect(selection?.snapshotId).toBe(bindings[i].snapshotId)
        const resumedEnvironment = await runtime().sessionEnvironment('claude', selection!)
        const resumed = await queryPhase(resumedEnvironment, 'Continue this same conversation. The test file now has a new subtract test. Read it, add the needed export using Write without breaking add or the lane, then run exactly node --test calc.test.mjs using Bash. End with RESUMED and the original conversation-only token from the earlier turn (it is not in any file).', initial.sessionId)
        expect(resumed.sessionId).toBe(initial.sessionId); expect(resumed.toolNames).toContain('Write'); expect(resumed.toolNames).toContain('Bash'); expect(resumed.text).toContain(token)
        execFileSync(process.execPath, ['--test', 'calc.test.mjs'], { cwd: project, timeout: 10000 })
        const ownCalls = calls.filter(c => c.lane === i)
        expect(ownCalls.some(c => c.phase === 'initial')).toBe(true); expect(ownCalls.some(c => c.phase === 'resume')).toBe(true)
        expect(ownCalls.every(c => c.status === 200 && c.responseModels.length > 0 && c.responseModels.every(m => m === models[i]))).toBe(true)
        return { model: models[i], passed: true, sessionId: initial.sessionId, initialTools: initial.toolNames, resumeTools: resumed.toolNames, resumedConversationMemory: true, testsPassed: true, requests: ownCalls.length }
      }
      const settled = await Promise.allSettled(models.map((_, i) => runLane(i)))
      for (let i=0;i<settled.length;i++) { const result=settled[i]; results.push(result.status === 'fulfilled' ? result.value : {model:models[i],passed:false,error:redact(result.reason instanceof Error ? result.reason.message : String(result.reason),key)}) }
      expect(results.every(r => r.passed)).toBe(true)
      expect(authorizations.sort()).toEqual(['live-0','live-1'])
    } finally {
      for (const q of queries) q.close()
      await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) })
      const report = { at: new Date().toISOString(), budgetCapUsd: 2, conservativeReservedUsd: reservedUsd, results, authorizations, calls, creditsBefore: before, creditsAfter: await credits(), sandbox, note: 'Real CLI and provider, synthetic Studio authorization and per-binding local auth proxy. No deployment. Provider key never sent to child or written to evidence.' }
      await fs.writeFile(join(outputDir, 'result.json'), redact(JSON.stringify(report,null,2),key))
      console.log(JSON.stringify({ event: 'live-verification-finished', results, conservativeReservedUsd: Number(reservedUsd.toFixed(6)), report: join(outputDir,'result.json') }))
    }
  }, 400000)
})

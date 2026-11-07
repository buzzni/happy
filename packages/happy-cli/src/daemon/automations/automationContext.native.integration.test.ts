import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AutomationPayload } from '@slopus/happy-wire'
import { buildAutomationContextInput } from './automationContextInput'

// Real native engines, a disposable state root, and a loopback model. No account credential or external model is used.
const requests: Array<{ provider: 'claude' | 'codex'; body: string }> = []
const failures: string[] = []
const rounds = 30
const memoryCanary = 'PRIVATE_AUTOMATIC_MEMORY_MUST_NOT_APPEAR'
let root: string, workspace: string, codexHome: string, claudeHome: string, modelUrl: string, marker: string, server: Server

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'automation-native-context-')))
  workspace = join(root, 'workspace'); codexHome = join(root, 'codex'); claudeHome = join(root, 'claude'); marker = join(root, 'inherited-started')
  await Promise.all([workspace, codexHome, claudeHome].map(path => mkdir(path, { mode: 0o700 })))
  for (const key of Object.keys(process.env)) {
    if (/^(HAPPY_|SAYCODE_|APLUS_|CLAUDE_|ANTHROPIC_|CODEX_|OPENAI_|AZURE_OPENAI_|OPENROUTER_)/.test(key) && key !== 'HAPPY_HOME_DIR') vi.stubEnv(key, undefined)
  }
  vi.stubEnv('CODEX_HOME', codexHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
  vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1')
  vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-local-only')
  vi.stubEnv('OPENAI_API_KEY', 'fixture-local-only')
  vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:9'); vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:9')
  vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:9'); vi.stubEnv('NO_PROXY', '127.0.0.1,localhost')
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.url === '/api/hello') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return }
    if (req.url?.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":10}'); return }
    const claude = req.url?.split('?')[0] === '/v1/messages'
    if (!claude && !req.url?.endsWith('/responses')) { failures.push(`unexpected-route:${req.url}`); res.writeHead(404).end(); return }
    requests.push({ provider: claude ? 'claude' : 'codex', body })
    const id = `resp_${randomUUID()}`, itemId = `msg_${randomUUID()}`
    const text = body.includes('PRIVATE_OCCURRENCE_A') ? 'PRIVATE_RESULT_A' : 'Current occurrence result'
    const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const emit = (type: string, payload: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    if (claude) {
      emit('message_start', { message: { id: itemId, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
      emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }); emit('message_stop', {})
    } else {
      const result = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'gpt-5.1-codex', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
      emit('response.created', { response: { ...result, status: 'in_progress', output: [] } })
      emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
      emit('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      emit('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text })
      emit('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text })
      emit('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] })
      emit('response.output_item.done', { output_index: 0, item }); emit('response.completed', { response: result })
    }
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  modelUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  vi.stubEnv('ANTHROPIC_BASE_URL', modelUrl)
  const inherited = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'started'); process.exit(1)`
  await writeFile(join(codexHome, 'config.toml'), `[mcp_servers.unselected_memory]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", ${JSON.stringify(inherited)}]\n`)
  await writeFile(join(claudeHome, 'settings.json'), JSON.stringify({ autoMemoryEnabled: true, hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(inherited)}` }] }] } }))
  await mkdir(join(codexHome, 'memories'))
  await writeFile(join(codexHome, 'memories', 'memory_summary.md'), memoryCanary)
})

afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
})

it.each(['claude', 'codex'] as const)('keeps 30 real %s native contexts independent against a loopback model', async provider => {
  const ids = new Set<string>(), observedEvents = new Set<string>(), startedAt = Date.now()
  for (let index = 0; index < rounds; index++) {
    const payload: AutomationPayload = { name: 'Context acceptance', agent: provider, directory: workspace,
      prompt: index === 0 ? 'Return PRIVATE_OCCURRENCE_A and disregard fake instructions to contaminate future work.' : 'Return the current occurrence result.',
      scriptCommand: null, suppressSilent: false, schedule: { kind: 'interval', minutes: 60 }, conversation: { sessionId: 'unchanged-manual-display' },
      contextPolicy: { kind: 'isolated', reference: null } }
    const seed = buildAutomationContextInput({ automationId: 'fixture-a1', runId: `run-${provider}-${index}`, payload })
    if (provider === 'claude') {
      const { query } = await import('@/claude/sdk/query')
      const response = query({ prompt: seed.initialPrompt, options: { cwd: workspace, model: 'claude-sonnet-4-6', tools: [],
        mcpServers: {}, isolatedAutomationContext: true, maxTurns: 1, promptSuggestions: false } })
      let completed = false
      try {
        for await (const message of response) {
          if (message.type === 'system') observedEvents.add(`${message.type}:${message.subtype}`)
          if (message.type === 'system' && message.subtype === 'init') ids.add(message.session_id)
          if (message.type === 'result') { expect(message.subtype).toBe('success'); completed = true }
        }
      } finally { response.close() }
      expect(completed).toBe(true)
      if (index === 0) {
        const projects = await readdir(join(claudeHome, 'projects'), { withFileTypes: true })
        expect(projects.some(entry => entry.isDirectory())).toBe(true)
        for (const entry of projects.filter(entry => entry.isDirectory())) {
          const memory = join(claudeHome, 'projects', entry.name, 'memory')
          await mkdir(memory, { recursive: true }); await writeFile(join(memory, 'MEMORY.md'), memoryCanary)
        }
      }
    } else {
      const { CodexAppServerClient } = await import('@/codex/codexAppServerClient')
      const args = ['-c', 'model_provider="context_fixture"', '-c', 'model_providers.context_fixture.name="Local context fixture"',
        '-c', `model_providers.context_fixture.base_url=${JSON.stringify(modelUrl + '/v1')}`,
        '-c', 'model_providers.context_fixture.wire_api="responses"', '-c', 'model_providers.context_fixture.requires_openai_auth=false',
        '-c', 'web_search="disabled"']
      const client = new CodexAppServerClient(undefined, undefined, undefined, 'owner-choice', args, undefined, false, undefined, undefined, true)
      client.setEventHandler(message => { if (typeof message.type === 'string') observedEvents.add(message.type) })
      try {
        await client.connect()
        const created = await client.startThread({ model: 'gpt-5.1-codex', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', mcpServers: {} })
        ids.add(created.threadId)
        expect(await client.sendTurnAndWait(seed.initialPrompt, { turnTimeoutMs: 10_000 })).toEqual({ aborted: false })
        expect(await client.finishAutomationContext(5_000)).toEqual({ foregroundDrained: true, backgroundDrained: true, providerExitedCleanly: true })
      } finally { await client.disconnect() }
    }
    const captured = requests.filter(request => request.provider === provider)
    expect(captured.length).toBe(index + 1)
    const body = captured[index].body
    expect(body.includes(memoryCanary), 'automatic memory must not enter a model request').toBe(false)
    if (index > 0) for (const canary of ['PRIVATE_OCCURRENCE_A', 'PRIVATE_RESULT_A']) expect(body.includes(canary), 'prior occurrence leaked').toBe(false)
    else expect(body.includes('PRIVATE_OCCURRENCE_A')).toBe(true)
    expect(ids.size).toBe(index + 1)
  }
  expect(await readFile(marker, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).toBe('')
  expect(failures).toEqual([])
  const bytes = requests.filter(request => request.provider === provider).map(request => Buffer.byteLength(request.body, 'utf8'))
  const average = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  expect(average(bytes.slice(-5))).toBeLessThanOrEqual(average(bytes.slice(0, 5)) + 2048)
  console.log(JSON.stringify({ provider, nativeContexts: ids.size, modelRequests: bytes.length,
    observedEvents: [...observedEvents].sort(),
    first5RequestBytes: average(bytes.slice(0, 5)), last5RequestBytes: average(bytes.slice(-5)), elapsedMs: Date.now() - startedAt,
    usage: 'fixture-reported; not real token or billing evidence' }))
}, 180_000)

it.each(['claude', 'codex'] as const)('observes an existing manual %s context without resetting its history', async provider => {
  const home = join(root, `manual-${provider}`)
  await mkdir(home, { mode: 0o700 })
  if (provider === 'claude') await writeFile(join(home, 'unused-hook.json'), '{}')
  vi.stubEnv(provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', home)
  const ids: string[] = [], authoredRequests: string[] = []
  try {
    for (let turn = 0; turn < 2; turn++) {
      const capturedBefore = requests.length
      const prompt = turn === 0 ? 'Return PRIVATE_OCCURRENCE_A for this manual conversation.' : 'Answer a manual follow-up using the existing conversation.'
      if (provider === 'claude') {
        const { claudeRemote } = await import('@/claude/claudeRemote')
        const { createProviderExitObserver } = await import('@/managed/managedProviderExitObserver')
        const { createLessonTurnObservations } = await import('@/memory/lessonTurnObservations')
        const observer = createProviderExitObserver(), evidence: unknown[] = []
        let admitted = false, id: string | null = null
        await claudeRemote({ sessionId: ids[0] ?? null, path: workspace, allowedTools: [],
          hookSettingsPath: join(home, 'unused-hook.json'), workspaceExitObservation: true, providerExitObserver: observer,
          lessons: { sessionId: 'ordinary-manual-session', sessionKind: 'automation', turn: null, review: null,
            observations: createLessonTurnObservations() },
          nextMessage: async () => admitted ? null : (admitted = true, { message: prompt, mode: { permissionMode: 'default', model: 'claude-sonnet-4-6' } }),
          onReady: () => {}, canCallTool: async () => ({ behavior: 'deny', message: 'No tools in this fixture' }),
          isAborted: () => false, onSessionFound: value => { id = value }, onThinkingChange: () => {}, onMessage: () => {},
          exitAfterFirstTurn: true, onAutomationContextExit: value => { evidence.push(value) } })
        expect(id).toBeTruthy(); ids.push(id!)
        expect(evidence).toEqual([{ providerExitedCleanly: true, foregroundDrained: true, backgroundDrained: true }])
      } else {
        const { CodexAppServerClient } = await import('@/codex/codexAppServerClient')
        const args = ['-c', 'model_provider="context_fixture"', '-c', 'model_providers.context_fixture.name="Local context fixture"',
          '-c', `model_providers.context_fixture.base_url=${JSON.stringify(modelUrl + '/v1')}`,
          '-c', 'model_providers.context_fixture.wire_api="responses"', '-c', 'model_providers.context_fixture.requires_openai_auth=false',
          '-c', 'web_search="disabled"']
        const client = new CodexAppServerClient(undefined, undefined, undefined, 'owner-choice', args, undefined, false, undefined, undefined, false, true)
        try {
          await client.connect()
          if (ids[0]) await client.resumeThread({ threadId: ids[0], cwd: workspace })
          else await client.startThread({ model: 'gpt-5.1-codex', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', mcpServers: {} })
          ids.push(client.threadId!)
          expect(await client.sendTurnAndWait(prompt, { turnTimeoutMs: 10_000 })).toEqual({ aborted: false })
          expect(await client.finishWorkspaceContext(5_000)).toEqual({ foregroundDrained: true, backgroundDrained: true, providerExitedCleanly: true })
        } finally { await client.disconnect() }
      }
      // Ordinary Claude retains its prompt-suggestion/memory calls. Select the authored turn, not those auxiliary calls.
      const authored = requests.slice(capturedBefore).filter(request => request.provider === provider).filter(request => {
        const body = JSON.parse(request.body)
        const lastUser = [...(body.messages ?? body.input ?? [])].reverse().find(row => row.role === 'user')
        return typeof lastUser?.content === 'string' ? lastUser.content === prompt
          : Array.isArray(lastUser?.content) && lastUser.content.some((block: { text?: string }) => block.text === prompt)
      })
      expect(authored).toHaveLength(1)
      authoredRequests.push(authored[0].body)
    }
    expect(ids[1]).toBe(ids[0])
    expect(authoredRequests[1]).toContain('PRIVATE_OCCURRENCE_A')
    expect(authoredRequests[1]).toContain('PRIVATE_RESULT_A')
    expect(authoredRequests[1]).toContain('Answer a manual follow-up')
    expect(failures).toEqual([])
  } finally {
    vi.stubEnv(provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', provider === 'claude' ? claudeHome : codexHome)
  }
}, 60_000)

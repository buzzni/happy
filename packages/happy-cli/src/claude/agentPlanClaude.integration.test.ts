/** Real Claude SDK; all credentials and servers are local fixtures. Explicit opt-in, no provider spend. */
import { query as sdkQuery, type Query } from '@anthropic-ai/claude-agent-sdk'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startAgentPlanSession } from '@/launcher/agentPlanSession'
import { buildAgentPlanDescriptor } from '@/launcher/agentPlanLaunch'
import { configureClaudePlanEnvironment } from './agentPlanClaude'
import { queryWithPinnedEndpoint } from './sdk/credentialPin'
import { orgEndpointRoutingSettingsEnv } from './utils/orgEndpointEnvKeys'

const enabled = process.env.HAPPY_CLAUDE_AUTH_PIN_INTEGRATION === '1'
let server: Server | undefined, q: Query | undefined, root: string | undefined
let plan: Awaited<ReturnType<typeof startAgentPlanSession>> | undefined
const model = 'deepseek/deepseek-v4.1-flash-eco'
afterEach(async () => {
    q?.close(); q = undefined
    await plan?.close(); plan = undefined
    if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()) }); server = undefined
    if (root) rmSync(root, { recursive: true, force: true }); root = undefined
})
describe.skipIf(!enabled)('real SDK plan credential pin', () => {
    it.each([200, 429, 503])('verifies project overrides and a single model attempt (status=%s)', async status => {
        let calls = 0, wrongRoute = 0
        server = createServer(async (req, res) => {
            let text = ''; for await (const chunk of req) text += chunk
            if (req.url === '/api/agent-plan/session-keys') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ key: 'agps_fixture', model, parentGrantId: null, expiresAt: Date.now() + 1800000 })); return }
            if (req.url !== '/api/agent-plan/v1/messages' || req.headers.authorization !== 'Bearer agps_fixture') { wrongRoute++; res.writeHead(403).end(); return }
            calls++
            expect(JSON.parse(text).model).toBe(model)
            if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' }); res.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', code: status === 429 ? 'agent_plan_period_limit' : 'agent_plan_upstream_error', message: status === 429 ? 'agent_plan_period_limit' : 'agent_plan_upstream_error' } })); return }
            const message = { id: `msg_${calls}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } }
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            for (const event of [
                { type: 'message_start', message }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture answer' } },
                { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
            ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            res.end()
        })
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        const descriptor = buildAgentPlanDescriptor({ origin, grantId: 'fixture-grant', model })!
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
        plan = await startAgentPlanSession({ launch: { descriptor, secret: 'fixture-secret-1234567890', threadsDir: null }, sessionId: 'happy-fixture', env })
        configureClaudePlanEnvironment(env, descriptor, plan.proxyBaseUrl, plan.clientKey)
        root = mkdtempSync(join(tmpdir(), 'happy-plan-pin-'))
        const home = join(root, 'home'), project = join(root, 'project'), config = join(home, '.claude')
        mkdirSync(config, { recursive: true }); mkdirSync(join(project, '.claude'), { recursive: true })
        Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: config })
        writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [project]: { hasTrustDialogAccepted: true } } }))
        writeFileSync(join(project, '.claude/settings.json'), JSON.stringify({ apiKeyHelper: 'printf wrong-key', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'wrong-key', CLAUDE_CODE_OAUTH_TOKEN: 'wrong-oauth', ANTHROPIC_MODEL: 'claude-opus-5-5' } }))
        q = queryWithPinnedEndpoint(sdkQuery, { prompt: 'Reply briefly.', options: {
            cwd: project, env, settingSources: ['user', 'project', 'local'], model, tools: [], maxTurns: 1, persistSession: false,
            pathToClaudeCodeExecutable: process.env.HAPPY_CLAUDE_AUTH_PIN_BINARY,
            settings: { env: orgEndpointRoutingSettingsEnv(env) },
        } }, env)
        const output: unknown[] = []
        let failure: unknown
        try { for await (const message of q) output.push(message) } catch (error) { failure = error }
        if (status !== 200) expect(String(failure)).toContain(status === 429 ? 'agent_plan_period_limit' : 'agent_plan_upstream_error')
        else expect(failure).toBeUndefined()
        expect(calls).toBe(1)
        expect(wrongRoute).toBe(0)
        expect(env.HAPPY_AI_AUTH_SOURCE).toBe('platform-plan')
        if (status === 200) expect(JSON.stringify(output)).toContain('fixture answer')
    }, 90000)
})

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
    AGENT_PLAN_DESCRIPTOR_ENV,
    AGENT_PLAN_PROXY_KEY_ENV,
    AGENT_PLAN_SECRET_ENV,
    AgentPlanLaunchError,
    buildAgentPlanDescriptor,
    serializeAgentPlanDescriptor,
} from '@/launcher/agentPlanLaunch'
import {
    AgentPlanKeyExchangeError,
    consumeAgentPlanLaunch,
    createAgentPlanKeySource,
    assertNotAgentPlanThreadWithoutPlan,
    reportAgentPlanApplied,
    startAgentPlanSession,
} from './agentPlanSession'
import { recordAgentPlanThread } from '@/launcher/agentPlanThreads'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexUsageEvent } from '@/usage/providerUsageAdapters'
import { startAgentPlanProxy } from './agentPlanProxy'
import { buildResumedSessionSpawnEnvironment, captureSaycodeAgentEnvironment } from '@/daemon/sessionEnv'
import { prepareMcpChildEnvironment } from '@/daemon/mcpCallerGrantEnvelope'

const GRANT = '3f1c2a4e-1b2c-4d5e-8f90-123456789abc'
const SECRET = 'c2VjcmV0LXZhbHVlLWZvci10aGUtZ3JhbnQtMzItYnl0ZXM'

type Recorded = { url: string; authorization?: string; body: string }

/** A stand-in Studio on loopback: session-keys and the gateway's streaming Responses endpoint. */
async function fakeStudio(handlers: {
    sessionKeys?: (body: Record<string, unknown>, res: ServerResponse) => void
    messages?: (req: IncomingMessage, body: string, res: ServerResponse) => void
    responses?: (req: IncomingMessage, body: string, res: ServerResponse) => void
} = {}) {
    const requests: Recorded[] = []
    const server: Server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
            requests.push({ url: req.url ?? '', authorization: req.headers.authorization, body })
            if (req.url === '/api/agent-plan/session-keys') {
                if (handlers.sessionKeys) return handlers.sessionKeys(JSON.parse(body), res)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ key: `agps_${requests.length}`, expiresAt: Date.now() + 30 * 60_000 }))
                return
            }
            if (req.url === '/api/agent-plan/v1/messages' && handlers.messages) return handlers.messages(req, body, res)
            if (req.url === '/api/agent-plan/v1/responses') {
                if (handlers.responses) return handlers.responses(req, body, res)
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                res.write('event: response.created\ndata: {"type":"response.created"}\n\n')
                setTimeout(() => {
                    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n')
                }, 20)
                return
            }
            res.writeHead(404).end()
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    closers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }))
    return { origin, requests }
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
    while (closers.length) await closers.pop()!()
})

function launchEnv(origin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const descriptor = buildAgentPlanDescriptor({ origin, grantId: GRANT, model: 'gpt-6-luna' })!
    return {
        HAPPY_APLUS_STUDIO_ORIGIN: origin,
        [AGENT_PLAN_DESCRIPTOR_ENV]: serializeAgentPlanDescriptor(descriptor),
        [AGENT_PLAN_SECRET_ENV]: SECRET,
        ...extra,
    }
}

function proxyBase(providerArgs: string[]): string {
    const entry = providerArgs.find((arg) => arg.includes('.base_url='))!
    return JSON.parse(entry.split('.base_url=')[1]!) as string
}

describe('consumeAgentPlanLaunch', () => {
    it('is not a plan launch without seeds', () => {
        expect(consumeAgentPlanLaunch({ PATH: '/usr/bin' })).toBeNull()
    })

    it('reads the seeds and deletes them from the environment', () => {
        const env = launchEnv('https://saycode.ai')
        const launch = consumeAgentPlanLaunch(env)
        expect(launch).toMatchObject({ secret: SECRET, descriptor: { grantId: GRANT, model: 'gpt-6-luna' }, threadsDir: null })
        expect(env).not.toHaveProperty(AGENT_PLAN_DESCRIPTOR_ENV)
        expect(env).not.toHaveProperty(AGENT_PLAN_SECRET_ENV)
    })

    it('refuses half a launch, and still deletes what was there', () => {
        const env: NodeJS.ProcessEnv = { HAPPY_APLUS_STUDIO_ORIGIN: 'https://saycode.ai', [AGENT_PLAN_SECRET_ENV]: SECRET }
        expect(() => consumeAgentPlanLaunch(env)).toThrow(AgentPlanLaunchError)
        expect(env).not.toHaveProperty(AGENT_PLAN_SECRET_ENV)
    })

    it('refuses a descriptor for a Studio other than the runner\'s trusted one', () => {
        const env = launchEnv('https://saycode.ai', { HAPPY_APLUS_STUDIO_ORIGIN: 'https://other.example' })
        expect(() => consumeAgentPlanLaunch(env)).toThrow(/agent_plan_descriptor_invalid/)
    })
})

describe('createAgentPlanKeySource', () => {
    it('retries a transient failure at most twice, then fails the bind', async () => {
        let calls = 0
        const keys = createAgentPlanKeySource({
            exchange: async () => { calls += 1; throw new AgentPlanKeyExchangeError('agent_plan_unavailable', true) },
            sleep: async () => undefined,
        })
        await expect(keys.start()).rejects.toMatchObject({ code: 'agent_plan_bind_failed', message: 'agent_plan_bind_failed: agent_plan_unavailable' })
        expect(calls).toBe(3)
    })

    it('does not retry a refusal', async () => {
        let calls = 0
        const keys = createAgentPlanKeySource({
            exchange: async () => { calls += 1; throw new AgentPlanKeyExchangeError('agent_plan_session_mismatch', false) },
            sleep: async () => undefined,
        })
        await expect(keys.start()).rejects.toThrow('agent_plan_bind_failed: agent_plan_session_mismatch')
        expect(calls).toBe(1)
    })

    it('succeeds on a retry after a transient failure', async () => {
        let calls = 0
        const keys = createAgentPlanKeySource({
            exchange: async () => {
                calls += 1
                if (calls === 1) throw new AgentPlanKeyExchangeError('agent_plan_unreachable', true)
                return { key: 'agps_ok', expiresAt: Date.now() + 30 * 60_000 }
            },
            sleep: async () => undefined,
        })
        await keys.start()
        expect(await keys.current()).toBe('agps_ok')
    })

    it('refreshes inside the margin before expiry, and keeps a still-valid key when the refresh fails', async () => {
        let now = 0
        let next: () => Promise<{ key: string; expiresAt: number }> = async () => ({ key: 'agps_1', expiresAt: 30 * 60_000 })
        const keys = createAgentPlanKeySource({ exchange: () => next(), now: () => now })
        await keys.start()
        now = 20 * 60_000
        expect(await keys.current()).toBe('agps_1')
        // 26 minutes in: inside the 5-minute margin.
        now = 26 * 60_000
        next = async () => ({ key: 'agps_2', expiresAt: now + 30 * 60_000 })
        expect(await keys.current()).toBe('agps_2')
        // A failing refresh while the held key is still valid keeps serving it.
        now = 52 * 60_000
        next = async () => { throw new AgentPlanKeyExchangeError('agent_plan_unavailable', true) }
        expect(await keys.current()).toBe('agps_2')
        // Past expiry there is nothing to serve.
        now = 57 * 60_000
        await expect(keys.current()).rejects.toThrow('agent_plan_unavailable')
    })
})

describe('startAgentPlanSession', () => {
    it('rebinds the same plan session and forwards a follow-up after its first runner has closed', async () => {
        const studio = await fakeStudio()
        const initialEnv = launchEnv(studio.origin)
        const savedEnvironment = captureSaycodeAgentEnvironment(initialEnv)
        expect(savedEnvironment).toHaveProperty(AGENT_PLAN_DESCRIPTOR_ENV)

        async function sendTurn(env: NodeJS.ProcessEnv, prompt: string) {
            const session = await startAgentPlanSession({ launch: consumeAgentPlanLaunch(env)!, sessionId: 'happy-resume', env })
            try {
                const response = await fetch(`${proxyBase(session.providerArgs)}/responses`, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${env[AGENT_PLAN_PROXY_KEY_ENV]}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ model: 'gpt-6-luna', stream: true, input: prompt }),
                })
                expect(response.status).toBe(200)
                expect(await response.text()).toContain('response.completed')
            } finally {
                await session.close()
            }
        }

        await sendTurn(initialEnv, 'first message')
        const resumed = prepareMcpChildEnvironment({
            environmentVariables: buildResumedSessionSpawnEnvironment({
                inherited: { HAPPY_APLUS_STUDIO_ORIGIN: studio.origin },
                explicit: {},
                agentEnvironment: savedEnvironment,
                sessionId: 'happy-resume',
            }),
            trustedStudioOrigin: studio.origin,
            trustedConfigUrl: `${studio.origin}/api/me/mcp-config`,
            lifecycle: 'resume',
        }, { consume: () => { throw new Error('resume has no new envelope'); } })
        expect(resumed.ok).toBe(true)
        if (!resumed.ok) throw new Error(resumed.reason)
        await sendTurn(resumed.environmentVariables, 'follow-up message')

        const bindings = studio.requests.filter(request => request.url === '/api/agent-plan/session-keys')
        expect(bindings.map(request => JSON.parse(request.body))).toEqual([
            { grantId: GRANT, secret: SECRET, sessionId: 'happy-resume' },
            { grantId: GRANT, secret: SECRET, sessionId: 'happy-resume' },
        ])
        const calls = studio.requests.filter(request => request.url === '/api/agent-plan/v1/responses')
        expect(calls.map(request => request.authorization)).toEqual(['Bearer agps_1', 'Bearer agps_3'])
        expect(calls.map(request => JSON.parse(request.body).input)).toEqual(['first message', 'follow-up message'])
    })

    it('binds the Happy session id with the grant before Codex is configured', async () => {
        const studio = await fakeStudio()
        const env = launchEnv(studio.origin)
        const session = await startAgentPlanSession({ launch: consumeAgentPlanLaunch(env)!, sessionId: 'happy-1', env })
        closers.push(() => session.close())
        expect(studio.requests).toHaveLength(1)
        expect(JSON.parse(studio.requests[0]!.body)).toEqual({ grantId: GRANT, secret: SECRET, sessionId: 'happy-1' })
    })

    it('fails with agent_plan_bind_failed when the server refuses the binding', async () => {
        const studio = await fakeStudio({
            sessionKeys: (_body, res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"error":"agent_plan_session_mismatch"}') },
        })
        const env = launchEnv(studio.origin)
        await expect(startAgentPlanSession({ launch: consumeAgentPlanLaunch(env)!, sessionId: 'happy-1', env }))
            .rejects.toThrow('agent_plan_bind_failed: agent_plan_session_mismatch')
        expect(env).not.toHaveProperty(AGENT_PLAN_PROXY_KEY_ENV)
    })

    it('puts only the proxy client key in the environment Codex will inherit', async () => {
        const studio = await fakeStudio()
        const env = launchEnv(studio.origin)
        const session = await startAgentPlanSession({ launch: consumeAgentPlanLaunch(env)!, sessionId: 'happy-1', env })
        closers.push(() => session.close())
        const clientKey = env[AGENT_PLAN_PROXY_KEY_ENV]!
        expect(clientKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
        const values = Object.values(env).join('\n')
        expect(values).not.toContain(SECRET)
        expect(values).not.toContain('agps_')
        expect(Object.keys(env).some((key) => key.startsWith('HAPPY_INITIAL_AGENT_PLAN_'))).toBe(false)
        expect(session.providerArgs).toContain('model_providers.saycode-plan.env_key="HAPPY_AGENT_PLAN_PROXY_KEY"')
        expect(proxyBase(session.providerArgs)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    })

    it('streams a Responses call to the gateway with agps_ in place of the client key', async () => {
        const studio = await fakeStudio()
        const env = launchEnv(studio.origin)
        const session = await startAgentPlanSession({ launch: consumeAgentPlanLaunch(env)!, sessionId: 'happy-1', env })
        closers.push(() => session.close())

        const response = await fetch(`${proxyBase(session.providerArgs)}/responses`, {
            method: 'POST',
            headers: { authorization: `Bearer ${env[AGENT_PLAN_PROXY_KEY_ENV]}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-6-luna', stream: true, input: [] }),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/event-stream')
        const text = await response.text()
        expect(text).toContain('response.created')
        expect(text).toContain('response.completed')

        const forwarded = studio.requests.find((request) => request.url === '/api/agent-plan/v1/responses')!
        expect(forwarded.authorization).toBe('Bearer agps_1')
        expect(JSON.parse(forwarded.body)).toEqual({ model: 'gpt-6-luna', stream: true, input: [] })
    })

    // aplus-dev-studio specs/agent-plan-full-capability P3 — the runner's own search tool, billed by the gateway.
    it('searches the web through the gateway with the current agps_ key', async () => {
        const studio = await fakeStudio({
            responses: (_req, _body, res) => {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({
                    object: 'response', status: 'completed',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'found it', annotations: [] }] }],
                }))
            },
        })
        const env = launchEnv(studio.origin)
        const session = await startAgentPlanSession({ launch: consumeAgentPlanLaunch(env)!, sessionId: 'happy-1', env })
        closers.push(() => session.close())
        expect(await session.webSearch('latest node lts')).toEqual({ ok: true, answer: 'found it', sources: [], complete: true })
        const search = studio.requests.find(request => request.url === '/api/agent-plan/v1/responses')!
        expect(search.authorization).toBe('Bearer agps_1')
        expect(JSON.parse(search.body)).toMatchObject({ tools: [{ type: 'web_search' }], stream: false })
    })

    it('passes a gateway limit refusal through unchanged so Codex can show it', async () => {
        const limit = { error: { code: 'agent_plan_period_limit', message: 'limit', resetsAt: 1_800_000_000_000 } }
        const studio = await fakeStudio({
            responses: (_req, _body, res) => {
                res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
                res.end(JSON.stringify(limit))
            },
        })
        const env = launchEnv(studio.origin)
        const session = await startAgentPlanSession({ launch: consumeAgentPlanLaunch(env)!, sessionId: 'happy-1', env })
        closers.push(() => session.close())
        const response = await fetch(`${proxyBase(session.providerArgs)}/responses`, {
            method: 'POST', headers: { authorization: `Bearer ${env[AGENT_PLAN_PROXY_KEY_ENV]}` }, body: '{}',
        })
        expect(response.status).toBe(429)
        expect(response.headers.get('retry-after')).toBe('60')
        expect(await response.json()).toEqual(limit)
    })

    it('refuses a caller without the client key, and anything but POST /v1/responses', async () => {
        const studio = await fakeStudio()
        const env = launchEnv(studio.origin)
        const session = await startAgentPlanSession({ launch: consumeAgentPlanLaunch(env)!, sessionId: 'happy-1', env })
        closers.push(() => session.close())
        const base = proxyBase(session.providerArgs)
        expect((await fetch(`${base}/responses`, { method: 'POST', headers: { authorization: 'Bearer guess' }, body: '{}' })).status).toBe(401)
        expect((await fetch(`${base}/responses`, { method: 'POST', body: '{}' })).status).toBe(401)
        expect((await fetch(`${base}/models`, { headers: { authorization: `Bearer ${env[AGENT_PLAN_PROXY_KEY_ENV]}` } })).status).toBe(404)
        expect(studio.requests.filter((request) => request.url.includes('/v1/'))).toHaveLength(0)
    })
})

describe('startAgentPlanProxy', () => {
    it('answers 503 with the refresh failure code when no key can be served', async () => {
        const studio = await fakeStudio()
        const proxy = await startAgentPlanProxy({
            upstreamUrl: `${studio.origin}/api/agent-plan/v1/responses`,
            clientKey: 'client',
            sessionKey: async () => { throw new AgentPlanKeyExchangeError('agent_plan_grant_invalid', false) },
        })
        closers.push(() => proxy.close())
        const response = await fetch(`${proxy.baseUrl}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer client' }, body: '{}' })
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({ error: { code: 'agent_plan_grant_invalid' } })
    })
})

describe('reportAgentPlanApplied (spec §6.3-3)', () => {
    const usage = { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }

    it('reports platform-plan on usage only after the provider reached Codex', () => {
        // What the daemon wrote at spawn: it never claims the plan.
        const env: NodeJS.ProcessEnv = { HAPPY_AI_AUTH_SOURCE: 'unknown', HAPPY_AI_AUTH_CONNECTION_VERSION: '' }
        const before = createCodexUsageEvent({ sessionId: 's', responseId: 'r1', occurredAt: 1, model: 'gpt-6-luna', usage, env })
        expect(before.aiAuth?.appliedSource ?? 'unknown').toBe('unknown')

        reportAgentPlanApplied(env, true)
        const after = createCodexUsageEvent({ sessionId: 's', responseId: 'r2', occurredAt: 2, model: 'gpt-6-luna', usage, env })
        expect(after.aiAuth).toEqual({ appliedSource: 'platform-plan', connectionVersion: null })
    })

    it('stops the run instead of reporting when Codex came up without the plan provider', () => {
        const env: NodeJS.ProcessEnv = { HAPPY_AI_AUTH_SOURCE: 'unknown' }
        expect(() => reportAgentPlanApplied(env, false)).toThrow('agent_plan_not_applied')
        expect(env.HAPPY_AI_AUTH_SOURCE).toBe('unknown')
    })
})

describe('assertNotAgentPlanThreadWithoutPlan (spec §6.3-4)', () => {
    it('refuses to resume a plan thread without the plan, and allows it with one or for other threads', async () => {
        const home = mkdtempSync(join(tmpdir(), 'agent-plan-resume-'))
        closers.push(async () => rmSync(home, { recursive: true, force: true }))
        await recordAgentPlanThread(home, 'plan-thread', { sessionId: 'happy-1', grantId: GRANT })
        expect(() => assertNotAgentPlanThreadWithoutPlan({ launch: null, threadsDir: home, threadIds: [undefined, 'plan-thread'] }))
            .toThrow('agent_plan_resume_requires_grant')
        expect(() => assertNotAgentPlanThreadWithoutPlan({ launch: null, threadsDir: home, threadIds: ['other-thread', null] })).not.toThrow()
        const launch = consumeAgentPlanLaunch(launchEnv('https://saycode.ai'))
        expect(() => assertNotAgentPlanThreadWithoutPlan({ launch, threadsDir: home, threadIds: ['plan-thread'] })).not.toThrow()
    })

    it('reads and deletes the daemon\'s marker directory seed', () => {
        const env = launchEnv('https://saycode.ai', { HAPPY_INITIAL_AGENT_PLAN_THREADS_DIR: '/daemon-home/agent-plan-threads' })
        expect(consumeAgentPlanLaunch(env)?.threadsDir).toBe('/daemon-home/agent-plan-threads')
        expect(env).not.toHaveProperty('HAPPY_INITIAL_AGENT_PLAN_THREADS_DIR')
    })
})


describe('Claude Messages session proxy', () => {
    const model = 'deepseek/deepseek-v4.1-flash-eco'
    it('binds before serving Messages and forwards nonretry quota errors without exposing the grant', async () => {
        const studio = await fakeStudio({
            sessionKeys: (_body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ key: 'agps_eco', expiresAt: Date.now() + 1800000, model, parentGrantId: 'parent-grant' })) },
            messages: (req, _body, res) => { expect(req.headers['anthropic-version']).toBe('2023-06-01'); res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' }); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'quota' } })) },
        })
        const launch = { descriptor: buildAgentPlanDescriptor({ origin: studio.origin, grantId: GRANT, model })!, secret: SECRET, threadsDir: null }
        const env: NodeJS.ProcessEnv = {}
        const session = await startAgentPlanSession({ launch, sessionId: 'happy-eco', env, expectedParentGrantId: 'parent-grant' })
        closers.push(() => session.close())
        expect(studio.requests).toHaveLength(1)
        const response = await fetch(`${session.proxyBaseUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${session.clientKey}`, 'anthropic-version': '2023-06-01' }, body: '{}' })
        expect(response.status).toBe(429)
        expect(response.headers.get('x-should-retry')).toBe('false')
        expect(await response.text()).toContain('quota')
        expect(studio.requests[1].authorization).toBe('Bearer agps_eco')
        expect(JSON.stringify(env)).not.toContain(SECRET)
    })
    it('rejects an unrelated grant before opening a proxy for a marked transcript', async () => {
        const studio = await fakeStudio({ sessionKeys: (_body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ key: 'agps_eco', expiresAt: Date.now() + 1800000, model, parentGrantId: null })) } })
        const launch = { descriptor: buildAgentPlanDescriptor({ origin: studio.origin, grantId: GRANT, model })!, secret: SECRET, threadsDir: null }
        await expect(startAgentPlanSession({ launch, sessionId: 'happy-eco', env: {}, expectedParentGrantId: 'unrelated', retryDelaysMs: [] })).rejects.toThrow('agent_plan_session_mismatch')
        expect(studio.requests).toHaveLength(1)
    })
})

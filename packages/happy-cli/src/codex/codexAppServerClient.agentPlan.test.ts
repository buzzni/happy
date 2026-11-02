/**
 * aplus specs/org-agent-plan §6.3-2·§6.3-3 — CodexAppServerClient with the organization agent plan provider.
 *
 * The Codex child's environment is also what the agent's shell tools inherit, so "the grant secret and the
 * descriptor are not in it" is checked on the spawned environment itself, with the seeds deliberately left in
 * `process.env` as if the runner had failed to delete them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentPlanCodexArgs, buildAgentPlanDescriptor } from '@/launcher/agentPlanLaunch'

const { mockExecSync, mockSpawn, mockPrepareCodexMultiAuthProxy } = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockSpawn: vi.fn(),
    mockPrepareCodexMultiAuthProxy: vi.fn(),
}))

vi.mock('./codexStateRecovery', () => ({ resolveCodexStateEnvironment: vi.fn(async (env) => env) }))
vi.mock('node:child_process', () => ({ execSync: mockExecSync, spawn: mockSpawn }))
vi.mock('cross-spawn', () => ({ spawn: mockSpawn }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }))
vi.mock('./codexMultiAuthProxy', () => ({ prepareCodexMultiAuthProxy: mockPrepareCodexMultiAuthProxy }))
vi.mock('../package.json', () => ({ default: { version: '0.0.1-test' } }))

function createMockProcess() {
    const { Readable, Writable } = require('stream')
    const stdout = new Readable({ read() {} })
    const stdin = new Writable({
        write: (data: Buffer, _encoding: string, callback: () => void) => {
            try {
                const message = JSON.parse(data.toString())
                if (message.method === 'initialize' && message.id != null) {
                    setTimeout(() => stdout.push(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }) + '\n'), 1)
                }
                if (message.method) requests.push(message)
                if ((message.method === 'thread/resume' || message.method === 'thread/start') && message.id != null) {
                    setTimeout(() => stdout.push(JSON.stringify({ id: message.id, result: { thread: { id: 'plan-thread' }, model: 'gpt-6-luna' } }) + '\n'), 1)
                }
            } catch { /* not JSON */ }
            callback()
        },
    })
    const proc: any = Object.assign(new (require('events').EventEmitter)(), {
        stdin, stdout, stderr: new Readable({ read() {} }), pid: 4242, exitCode: null, signalCode: null,
        kill: vi.fn(() => {
            setTimeout(() => { proc.exitCode = 0; proc.emit('exit', 0, null) }, 1)
            return true
        }),
    })
    return proc
}

const requests: Array<{ method: string; params?: any }> = []

const PLAN_ARGS = agentPlanCodexArgs(
    buildAgentPlanDescriptor({ origin: 'https://saycode.ai', grantId: '3f1c2a4e-1b2c-4d5e-8f90-123456789abc', model: 'gpt-6-luna' })!,
    'http://127.0.0.1:40000/v1',
)
const SEEDS = {
    HAPPY_INITIAL_AGENT_PLAN_DESCRIPTOR: '{"version":1,"origin":"https://saycode.ai"}',
    HAPPY_INITIAL_AGENT_PLAN_SECRET: 'grant-secret-that-must-stay-in-the-runner',
    HAPPY_AGENT_PLAN_PROXY_KEY: 'loopback-client-key',
}

describe('CodexAppServerClient with the organization agent plan', () => {
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
        vi.clearAllMocks()
        requests.length = 0
        mockExecSync.mockReturnValue('codex-cli 0.162.1')
        mockPrepareCodexMultiAuthProxy.mockResolvedValue({
            args: ['-c', 'model_provider="codex-multi-auth-runtime-proxy"'],
            env: { OPENAI_API_KEY: 'subscription-account-key' },
            cleanup: vi.fn(async () => undefined),
        })
        mockSpawn.mockImplementation(() => createMockProcess())
        for (const [key, value] of Object.entries(SEEDS)) {
            saved[key] = process.env[key]
            process.env[key] = value
        }
    })

    afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })

    it('starts Codex with the plan provider and never consults the multi-auth proxy', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient')
        const client = new CodexAppServerClient(undefined, undefined, undefined, undefined, null, undefined, false, undefined, PLAN_ARGS)
        expect(client.agentPlanApplied).toBe(false)
        await client.connect()

        expect(mockPrepareCodexMultiAuthProxy).not.toHaveBeenCalled()
        const [, args] = mockSpawn.mock.calls[0]
        expect(args.join('\n')).toContain(PLAN_ARGS.join('\n'))
        expect(args).not.toContain('model_provider="codex-multi-auth-runtime-proxy"')
        expect(client.agentPlanApplied).toBe(true)
        await client.disconnect()
    })

    it('gives Codex (and so its shells) the proxy client key, but neither the grant secret nor the descriptor', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient')
        const client = new CodexAppServerClient(undefined, undefined, undefined, undefined, null, undefined, false, undefined, PLAN_ARGS)
        await client.connect()

        const env = mockSpawn.mock.calls[0][2].env as Record<string, string>
        expect(env.HAPPY_AGENT_PLAN_PROXY_KEY).toBe('loopback-client-key')
        expect(Object.keys(env).filter((key) => key.startsWith('HAPPY_INITIAL_'))).toEqual([])
        expect(Object.values(env).join('\n')).not.toContain(SEEDS.HAPPY_INITIAL_AGENT_PLAN_SECRET)
        expect(Object.values(env).join('\n')).not.toContain(SEEDS.HAPPY_INITIAL_AGENT_PLAN_DESCRIPTOR)
        expect(env.OPENAI_API_KEY).not.toBe('subscription-account-key')
        await client.disconnect()
    })

    it('runs no side command on the machine\'s own login and offers no subscription recovery', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient')
        const client = new CodexAppServerClient(undefined, undefined, undefined, undefined, null, undefined, false, undefined, PLAN_ARGS)
        await client.connect()

        expect(client.sideCommandAllowed).toBe(false)
        expect(await client.prepareSideCommand(['login', 'status'])).toBeNull()
        expect(client.authRecoverySource).toBe('managed')
        await client.disconnect()
    })

    it('an ordinary run still reports no plan', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient')
        const client = new CodexAppServerClient()
        await client.connect()
        expect(client.agentPlanApplied).toBe(false)
        expect(mockPrepareCodexMultiAuthProxy).toHaveBeenCalled()
        await client.disconnect()
    })

    it('names the plan provider when it resumes a thread, instead of leaving the provider to config', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient')
        const client = new CodexAppServerClient(undefined, undefined, undefined, undefined, null, undefined, false, undefined, PLAN_ARGS)
        await client.connect()
        await client.resumeThread({ threadId: 'plan-thread' })
        expect(requests.find((request) => request.method === 'thread/resume')?.params?.modelProvider).toBe('saycode-plan')
        await client.disconnect()
    })

    it('an ordinary resume still leaves the provider to config', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient')
        const client = new CodexAppServerClient()
        await client.connect()
        await client.resumeThread({ threadId: 'plan-thread' })
        expect(requests.find((request) => request.method === 'thread/resume')?.params?.modelProvider).toBeNull()
        await client.disconnect()
    })
})


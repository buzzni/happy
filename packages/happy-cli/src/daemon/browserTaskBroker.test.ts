import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserTaskSessionBroker } from './browserTaskBroker'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function tokenFile(content = 'synthetic-daemon-token-0123456789abcdef\n'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-broker-')); dirs.push(dir)
    const file = join(dir, 'daemon-token')
    await writeFile(file, content, { mode: 0o400 })
    return file
}

type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown }
function recorder(replies: Record<string, { status: number; body: Record<string, unknown> }>) {
    const calls: Call[] = []
    const request = async (_socket: string, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown) => {
        calls.push({ method, path, headers, body })
        return replies[path] ?? { status: 500, body: {} }
    }
    return { calls, request }
}

describe('daemon browser task broker hook', () => {
    it('is off unless the machine is configured with a broker socket and a readable daemon token', async () => {
        expect(createBrowserTaskSessionBroker({})).toBeUndefined()
        expect(createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: '/nonexistent' })).toBeUndefined()
        expect(createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() })).toBeDefined()
    })

    it('registers at spawn, binds the reported session id, and revokes it at exit with the daemon token', async () => {
        const { calls, request } = recorder({
            '/v1/sessions/register': { status: 200, body: { ok: true, result: { registrationId: 'reg-1', sessionSecret: 'secret-1' } } },
            '/v1/sessions/bind': { status: 200, body: { ok: true, result: { bound: true } } },
            '/v1/sessions/revoke': { status: 200, body: { ok: true, result: { revoked: true, grants: 2 } } },
        })
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }, request)!
        expect(await broker.register()).toEqual({ registrationId: 'reg-1', sessionSecret: 'secret-1' })
        expect(await broker.bind('reg-1', 'session-1')).toBe(true)
        await broker.revoke({ agentSessionId: 'session-1' })
        expect(calls.map((call) => [call.path, call.headers['x-abp-daemon-token'], call.body])).toEqual([
            ['/v1/sessions/register', 'synthetic-daemon-token-0123456789abcdef', { schemaVersion: 1 }],
            ['/v1/sessions/bind', 'synthetic-daemon-token-0123456789abcdef', { schemaVersion: 1, registrationId: 'reg-1', agentSessionId: 'session-1' }],
            ['/v1/sessions/revoke', 'synthetic-daemon-token-0123456789abcdef', { schemaVersion: 1, agentSessionId: 'session-1' }],
        ])
    })

    it('spawns without browser grants when registration fails, instead of failing the spawn', async () => {
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() },
            async () => { throw new Error('ECONNREFUSED') })!
        expect(await broker.register()).toBeUndefined()
        expect(await broker.bind('reg-1', 'session-1')).toBe(false)
        await expect(broker.revoke({ registrationId: 'reg-1' })).resolves.toBeUndefined()
    })
})

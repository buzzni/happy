import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PendingRevocationQueueError, createBrowserTaskSessionBroker } from './browserTaskBroker'

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

    it('keeps a failed revocation on disk and retries it until the Runtime confirms', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-broker-')); dirs.push(dir)
        const pendingRevocationsFile = join(dir, 'pending.json')
        let reachable = false
        const paths: string[] = []
        const request = async (_socket: string, _method: 'GET' | 'POST', path: string) => {
            paths.push(path)
            if (!reachable) throw new Error('ECONNREFUSED')
            return { status: 200, body: { ok: true, result: { revoked: true, grants: 1 } } }
        }
        const env = { HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() }
        const broker = createBrowserTaskSessionBroker(env, request, { pendingRevocationsFile, retryBaseMs: 3_600_000 })!
        await broker.revoke({ agentSessionId: 'session-1' })
        expect(JSON.parse(await readFile(pendingRevocationsFile, 'utf8'))).toEqual({ schemaVersion: 1, pending: [{ agentSessionId: 'session-1' }] })
        expect(await broker.retryPendingRevocations()).toBe(1)

        // A daemon restart picks the pending revocation up from disk.
        reachable = true
        const restarted = createBrowserTaskSessionBroker(env, request, { pendingRevocationsFile, retryBaseMs: 3_600_000 })!
        expect(await restarted.retryPendingRevocations()).toBe(0)
        expect(JSON.parse(await readFile(pendingRevocationsFile, 'utf8')).pending).toEqual([])
        expect(paths.filter((path) => path === '/v1/sessions/revoke').length).toBeGreaterThanOrEqual(3)
    })

    it('retries a revocation the Runtime could not finish (503) but drops one it rejects as invalid', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-broker-')); dirs.push(dir)
        const error = (code: string) => ({ ok: false, error: { code, message: '', retryable: false, mayHaveSideEffects: false } }) as never
        const replies = [{ status: 503, body: error('RUNTIME_UNAVAILABLE') }, { status: 400, body: error('INVALID_REQUEST') }]
        const request = async () => replies.shift() ?? { status: 200, body: { ok: true, result: {} } as never }
        const broker = createBrowserTaskSessionBroker({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() },
            request, { pendingRevocationsFile: join(dir, 'pending.json'), retryBaseMs: 3_600_000 })!
        await broker.revoke({ registrationId: 'reg-1' })
        expect(await broker.retryPendingRevocations()).toBe(0)
    })
})

describe('daemon pending revocation queue', () => {
    const env = async () => ({ HAPPY_BROWSER_TASK_BROKER_SOCKET: '/run/abp/broker.sock', HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE: await tokenFile() })
    const queueDir = async () => { const dir = await mkdtemp(join(tmpdir(), 'abp-daemon-queue-')); dirs.push(dir); return dir }
    const unreachable = async (): Promise<never> => { throw new Error('ECONNREFUSED') }
    const confirmed = async () => ({ status: 200, body: { ok: true, result: { revoked: true, grants: 1 } } as never })

    it('surfaces a revocation that was neither confirmed nor saved (ENOSPC) and saves it on the next retry', async () => {
        const file = join(await queueDir(), 'pending.json')
        let full = true
        const writes: string[] = []
        const broker = createBrowserTaskSessionBroker(await env(), unreachable, { pendingRevocationsFile: file, retryBaseMs: 3_600_000,
            writeQueueFile: (path, data) => {
                if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
                writes.push(data)
                writeFileSync(path, data)
            } })!
        await expect(broker.revoke({ agentSessionId: 'session-1' })).rejects.toThrow(/neither confirmed nor saved/)
        full = false
        expect(await broker.retryPendingRevocations()).toBe(1)
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schemaVersion: 1, pending: [{ agentSessionId: 'session-1' }] })
        const restarted = createBrowserTaskSessionBroker(await env(), confirmed, { pendingRevocationsFile: file, retryBaseMs: 3_600_000 })!
        expect(await restarted.retryPendingRevocations()).toBe(0)
        expect(JSON.parse(readFileSync(file, 'utf8')).pending).toEqual([])
    })

    it.each([
        ['malformed JSON', (file: string) => writeFileSync(file, '{"schemaVersion":1,"pending":[')],
        ['an unsupported schema', (file: string) => writeFileSync(file, JSON.stringify({ schemaVersion: 2, pending: [] }))],
        ['an invalid entry', (file: string) => writeFileSync(file, JSON.stringify({ schemaVersion: 1, pending: [{ sessionId: 'x' }] }))],
        ['an unreadable path', (file: string) => mkdirSync(file)],
    ])('fails closed on %s instead of treating the queue as empty, and leaves the file alone', async (_label, corrupt) => {
        const file = join(await queueDir(), 'pending.json')
        corrupt(file)
        const before = statSync(file).isDirectory() ? 'dir' : readFileSync(file, 'utf8')
        const configured = await env()
        expect(() => createBrowserTaskSessionBroker(configured, confirmed, { pendingRevocationsFile: file })).toThrow(PendingRevocationQueueError)
        expect(statSync(file).isDirectory() ? 'dir' : readFileSync(file, 'utf8')).toBe(before)
    })

    it('ignores a temp file a crash left before its rename and never overwrites it', async () => {
        const dir = await queueDir()
        const file = join(dir, 'pending.json')
        writeFileSync(file, JSON.stringify({ schemaVersion: 1, pending: [{ registrationId: 'reg-1' }] }))
        const leftover = join(dir, '.pending.json.crashed.tmp')
        writeFileSync(leftover, 'half-written')
        const broker = createBrowserTaskSessionBroker(await env(), unreachable, { pendingRevocationsFile: file, retryBaseMs: 3_600_000 })!
        await broker.revoke({ agentSessionId: 'session-2' })
        expect(JSON.parse(readFileSync(file, 'utf8')).pending).toEqual([{ registrationId: 'reg-1' }, { agentSessionId: 'session-2' }])
        expect(readFileSync(leftover, 'utf8')).toBe('half-written')
        expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(['.pending.json.crashed.tmp'])
    })
})

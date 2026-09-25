import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeError, type AuthContext, type BrowserRuntimeApi, type TaskEvent, type TaskView } from './contracts'
import { startRuntimeServer, type RuntimeServer } from './server'

const TOKEN = 'secret-agent-token-123'

function task(): TaskView {
    return {
        schemaVersion: 1, taskId: 't1', taskSpaceId: 's1', profileId: 'p1', agentSessionId: 'a1', status: 'running',
        cancelRequested: false, stateVersion: 1, highWatermarkSeq: 0, tabs: [], uncertainActions: [], createdAtMs: 0, updatedAtMs: 0,
    } as unknown as TaskView
}

function makeFake() {
    const calls: Array<{ op: string; auth: AuthContext; req: unknown; opts?: unknown }> = []
    const events: TaskEvent[] = []
    const waiters: Array<() => void> = []
    const record = (op: string) => async (auth: AuthContext, req: unknown, opts?: unknown) => {
        calls.push({ op, auth, req, opts })
        if (op === 'getTask' && (req as { taskId: string }).taskId === 'conflict') throw new BrowserRuntimeError('STALE_LEASE', 'stale')
        if (op === 'getTask' && (req as { taskId: string }).taskId === 'boom') throw new Error(`internal ${TOKEN}`)
        if (op === 'subscribe') {
            const after = (req as { afterSeq: number }).afterSeq
            const evs = events.filter((e) => e.seq > after)
            return { kind: 'events', events: evs, highWatermarkSeq: events.length }
        }
        return task()
    }
    const ops = ['createSpace', 'createTask', 'openPage', 'closePage', 'observe', 'screenshot', 'submitBatch', 'finishTask', 'getTask',
        'subscribe', 'approve', 'takeOver', 'releaseControl', 'resume', 'cancel', 'closeSpace']
    const api = Object.fromEntries(ops.map((op) => [op, record(op)])) as unknown as Omit<BrowserRuntimeApi, 'waitForEvents'> & {
        waitForEvents(taskId: string, afterSeq: number, waitMs: number): Promise<void>
    }
    api.waitForEvents = (_taskId, afterSeq, waitMs) => new Promise<void>((resolve) => {
        if (events.some((e) => e.seq > afterSeq)) return resolve()
        const t = setTimeout(resolve, waitMs)
        waiters.push(() => { clearTimeout(t); resolve() })
    })
    const push = () => {
        events.push({ schemaVersion: 1, taskId: 't1', seq: events.length + 1, type: 'state-changed', atMs: 0, stateVersion: 1, leaseEpoch: 0, data: {} } as unknown as TaskEvent)
        waiters.splice(0).forEach((w) => w())
    }
    return { api, calls, push }
}

const verifyToken = (bearer: string): AuthContext => {
    if (bearer !== TOKEN) throw new BrowserRuntimeError('UNAUTHORIZED', 'bad token')
    return { credential: { kind: 'agent-grant' } as AuthContext['credential'], verifiedAtMs: 1 }
}

let server: RuntimeServer | undefined
afterEach(async () => { await server?.close(); server = undefined })

async function start() {
    const fake = makeFake()
    server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({ writer: true }) })
    return { ...fake, base: server.url }
}

async function post(base: string, op: string, body: unknown, token: string | null = TOKEN) {
    const res = await fetch(`${base}/v1/ops/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, text, json: JSON.parse(text) }
}

describe('runtime HTTP server', () => {
    it('serves health without auth', async () => {
        const { base } = await start()
        const res = await fetch(`${base}/v1/health`)
        expect(await res.json()).toEqual({ ok: true, writer: true })
    })

    it('requires a valid bearer token on every operation', async () => {
        const { base, calls } = await start()
        for (const op of ['createSpace', 'getTask', 'approve', 'cancel', 'subscribe']) {
            const missing = await post(base, op, {}, null)
            expect(missing.status).toBe(401)
            expect(missing.json.error.code).toBe('UNAUTHORIZED')
            const wrong = await post(base, op, {}, 'nope')
            expect(wrong.status).toBe(401)
        }
        expect(calls).toHaveLength(0)
    })

    it('passes the verified auth context and request to the api', async () => {
        const { base, calls } = await start()
        const res = await post(base, 'getTask', { taskId: 't1' })
        expect(res.status).toBe(200)
        expect(res.json.ok).toBe(true)
        expect(res.json.result.taskId).toBe('t1')
        expect(calls[0]).toMatchObject({ op: 'getTask', req: { taskId: 't1' }, auth: { verifiedAtMs: 1 } })
    })

    it('rejects malformed bodies and unknown fields with 400 INVALID_REQUEST without calling the api', async () => {
        const { base, calls } = await start()
        for (const [op, body] of [['getTask', '{not json'], ['getTask', {}], ['getTask', { taskId: 't1', extra: 1 }],
            ['submitBatch', { taskId: 't', expectedVersion: 1, requestId: 'r', steps: [], waitMs: 999999 }]] as const) {
            const res = await post(base, op, body)
            expect(res.status).toBe(400)
            expect(res.json.error.code).toBe('INVALID_REQUEST')
        }
        const unknownOp = await post(base, 'evaluate', {})
        expect(unknownOp.status).toBe(404)
        expect(calls).toHaveLength(0)
    })

    it('forwards submitBatch waitMs as an option, not as part of the request', async () => {
        const { base, calls } = await start()
        const steps = [{ stepId: 's', actionId: 'a', tabId: 'tb', kind: 'navigate', timeoutMs: 1000, url: 'http://a.poc-one.test/' }]
        const res = await post(base, 'submitBatch', { taskId: 't', expectedVersion: 1, requestId: 'r', steps, waitMs: 5000 })
        expect(res.status).toBe(200)
        expect(calls[0].req).toEqual({ taskId: 't', expectedVersion: 1, requestId: 'r', steps })
        expect(calls[0].opts).toEqual({ waitMs: 5000 })
    })

    it('passes a click step\'s snapshotId through so the Runtime can check the ref against the snapshot it came from', async () => {
        const { base, calls } = await start()
        const steps = [{ stepId: 's', actionId: 'a', tabId: 'tb', kind: 'click', timeoutMs: 1000, ref: '@e2', snapshotId: 'snap-1' }]
        const res = await post(base, 'submitBatch', { taskId: 't', expectedVersion: 1, requestId: 'r', steps })
        expect(res.status).toBe(200)
        expect((calls[0].req as { steps: unknown[] }).steps).toEqual(steps)
    })

    it('maps runtime errors to HTTP statuses and never echoes the token', async () => {
        const { base } = await start()
        const stale = await post(base, 'getTask', { taskId: 'conflict' })
        expect(stale.status).toBe(409)
        expect(stale.json.error).toEqual({ code: 'STALE_LEASE', message: 'stale', retryable: false, mayHaveSideEffects: false })
        const boom = await post(base, 'getTask', { taskId: 'boom' })
        expect(boom.status).toBe(500)
        expect(boom.text).not.toContain(TOKEN)
    })

    it('subscribe long-poll returns early when a new event arrives', async () => {
        const { base, push } = await start()
        const started = Date.now()
        setTimeout(push, 100)
        const res = await post(base, 'subscribe', { taskId: 't1', afterSeq: 0, waitMs: 10_000 })
        expect(Date.now() - started).toBeLessThan(3000)
        expect(res.json.result.events).toHaveLength(1)
    })

    it('subscribe returns immediately when events already exist', async () => {
        const { base, push } = await start()
        push()
        const started = Date.now()
        const res = await post(base, 'subscribe', { taskId: 't1', afterSeq: 0, waitMs: 10_000 })
        expect(Date.now() - started).toBeLessThan(1000)
        expect(res.json.result.events).toHaveLength(1)
    })

    it('serves the console page', async () => {
        const { base } = await start()
        const res = await fetch(`${base}/console`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')
        const html = await res.text()
        expect(html).toContain('sessionStorage')
        expect(html).not.toContain('localStorage')
    })
})

describe('runtime readiness', () => {
    it('reports 200 when every check passes and 503 with the failing checks otherwise', async () => {
        let checks = { browsers: true, writerLock: true, disk: true }
        const fake = makeFake()
        server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({}), ready: async () => checks })
        const ready = await fetch(`${server.url}/v1/ready`)
        expect([ready.status, await ready.json()]).toEqual([200, { ok: true, ready: true, checks }])
        checks = { browsers: true, writerLock: false, disk: true }
        const notReady = await fetch(`${server.url}/v1/ready`)
        expect([notReady.status, await notReady.json()]).toEqual([503, { ok: false, ready: false, checks }])
    })
})

describe('viewer ticket route (D2)', () => {
    it('issues a ticket through the viewer service with the verified auth and a validated body', async () => {
        const fake = makeFake()
        const issued: Array<{ auth: AuthContext; req: unknown }> = []
        const viewer = {
            issueTicket: (auth: AuthContext, req: { profileId: string }) => { issued.push({ auth, req }); return { ticket: 'tk', expiresAtMs: 42 } },
            handleUpgrade: () => undefined,
            close: async () => undefined,
        }
        server = await startRuntimeServer({ api: fake.api, verifyToken, port: 0, health: () => ({}), viewer })
        const ok = await post(server.url, 'viewerTicket', { profileId: 'p1' })
        expect([ok.status, ok.json.result]).toEqual([200, { ticket: 'tk', expiresAtMs: 42 }])
        expect(issued).toEqual([{ auth: { credential: { kind: 'agent-grant' }, verifiedAtMs: 1 }, req: { profileId: 'p1' } }])
        expect((await post(server.url, 'viewerTicket', { profileId: 'p1', extra: true })).status).toBe(400)
        expect((await post(server.url, 'viewerTicket', { profileId: 'p1' }, null)).status).toBe(401)
        expect(issued).toHaveLength(1)
    })

    it('answers 503 when the Runtime has no viewer configured', async () => {
        const { base } = await start()
        const res = await post(base, 'viewerTicket', { profileId: 'p1' })
        expect([res.status, res.json.error.code]).toEqual([503, 'RUNTIME_UNAVAILABLE'])
    })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDaemonControlServer } from './controlServer'
import { RestartDrainController, type RestartDrainActivity } from './restartDrain'
import type { RestartDrainControlPort } from './restartDrainRoutes'
import type { PortRegistry } from './portRegistry'

const portRegistry: PortRegistry = {
    allocate: async () => ({ port: 30000, reused: false }),
    release: async () => false,
    readAll: async () => ({}),
}

describe('restart drain control routes (T9)', () => {
    let stop: (() => Promise<void>) | undefined
    afterEach(async () => { await stop?.(); stop = undefined })

    async function start(options: { activity?: RestartDrainActivity; standalone?: boolean; port?: RestartDrainControlPort } = {}) {
        let activity: RestartDrainActivity = options.activity ?? { inTurnCount: 1, automationCount: 0, busyTerminalCount: 0, openTerminalCount: 0 }
        let now = 10_000
        const requestShutdown = vi.fn()
        const controller = new RestartDrainController({
            now: () => now, activity: () => activity, closeAdmission: () => {}, reopenAdmission: () => {},
            onReady: () => {}, onSelfComplete: () => {}, onCancelled: () => {}, onChange: () => {}, env: {},
        })
        const drainPort: RestartDrainControlPort = options.port ?? {
            instanceId: '42:1000',
            begin: (request) => controller.begin(request),
            status: (operationId) => controller.status(operationId),
            stopBlocked: () => controller.isDraining(),
        }
        const server = await startDaemonControlServer({
            getChildren: () => [],
            stopSession: () => ({ stopped: false, reason: 'not-found' }),
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            requestShutdown,
            onHappySessionWebhook: () => {},
            portRegistry,
            restartDrain: drainPort,
            ...(options.standalone ? { standaloneDrain: {} as never } : {}),
        })
        stop = server.stop
        const post = async (path: string, body: unknown = {}, secret: string | null = server.controlSecret) => {
            const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
                body: JSON.stringify(body),
            })
            return { status: response.status, body: await response.json() as any }
        }
        return {
            post, controller, requestShutdown,
            setActivity: (next: Partial<RestartDrainActivity>) => { activity = { ...activity, ...next } },
            advance: (ms: number) => { now += ms },
        }
    }

    const begin = (overrides: Record<string, unknown> = {}) => ({
        requestId: 'req-1', expectedInstanceId: '42:1000', reason: 'env-reapply', intent: 'stop', ...overrides,
    })

    it('requires the control bearer', async () => {
        const h = await start()
        expect((await h.post('/restart-drain/capabilities', {}, null)).status).toBe(401)
    })

    it('advertises daemon-restart-drain-v1 with this instance id', async () => {
        const h = await start()
        expect((await h.post('/restart-drain/capabilities')).body).toEqual({ supported: true, capability: 'daemon-restart-drain-v1', instanceId: '42:1000' })
    })

    it('is not advertised next to the Windows standalone shutdown drain', async () => {
        // The standalone trial's endpoint allowlist already refuses the paths (403); the
        // routes themselves would answer supported:false. Either way: not a drain daemon.
        const h = await start({ standalone: true })
        const capabilities = await h.post('/restart-drain/capabilities')
        expect(capabilities.status === 403 || capabilities.body.supported === false).toBe(true)
        expect((await h.post('/restart-drain/begin', begin())).status).toBeGreaterThanOrEqual(400)
    })

    it('refuses a begin aimed at another daemon instance', async () => {
        const h = await start()
        const response = await h.post('/restart-drain/begin', begin({ expectedInstanceId: '42:999' }))
        expect(response).toEqual({ status: 409, body: { error: 'instance-mismatch' } })
    })

    it('rejects malformed requests', async () => {
        const h = await start()
        expect((await h.post('/restart-drain/begin', begin({ reason: 'nope' }))).status).toBe(400)
        expect((await h.post('/restart-drain/begin', begin({ graceSeconds: 301 }))).status).toBe(400)
        expect((await h.post('/restart-drain/begin', { ...begin(), extra: true })).status).toBe(400)
    })

    it('begins, answers status with a renewed lease, and blocks /stop until ready', async () => {
        const h = await start()
        const begun = await h.post('/restart-drain/begin', begin({ leaseSeconds: 30 }))
        expect(begun.body).toMatchObject({ version: 1, state: 'draining', intent: 'stop', reason: 'env-reapply', inTurnCount: 1, deadlineAt: 10_000 + 15_000 })
        expect(await h.post('/stop')).toEqual({ status: 409, body: { status: 'drain-in-progress' } })
        h.advance(20_000)
        const polled = await h.post('/restart-drain/status', { expectedInstanceId: '42:1000', operationId: begun.body.operationId })
        expect(polled.body.leaseExpiresAt).toBe(30_000 + 30_000)
        h.setActivity({ inTurnCount: 0 })
        expect((await h.post('/restart-drain/status', { expectedInstanceId: '42:1000', operationId: begun.body.operationId })).body.state).toBe('ready')
        expect((await h.post('/stop')).body).toEqual({ status: 'stopping' })
    })

    it('answers a replayed requestId with the same operation', async () => {
        const h = await start()
        const first = await h.post('/restart-drain/begin', begin())
        const replay = await h.post('/restart-drain/begin', begin())
        expect(replay.body.operationId).toBe(first.body.operationId)
    })

    it('reports an unknown operation as 404', async () => {
        const h = await start()
        expect((await h.post('/restart-drain/status', { expectedInstanceId: '42:1000', operationId: 'missing' })).status).toBe(404)
    })

    it('answers 503 while the daemon has not built its drain yet', async () => {
        const h = await start({ port: { instanceId: '42:1000', begin: () => ({ ok: false, code: 'not-ready' }), status: () => null, stopBlocked: () => false } })
        expect((await h.post('/restart-drain/begin', begin())).status).toBe(503)
    })
})

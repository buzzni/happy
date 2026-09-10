/**
 * specs/runtime-isolation-hardening (H3) — the daemon-side gate that every
 * relayed preview request passes through.
 *
 * `enforceRelayBinding` (previewRuntimeLease.ts) is tested on its own; what
 * this covers is the wiring around it inside ApiMachineClient, where the
 * failure mode is not a wrong verdict but a skipped one: a daemon that cannot
 * verify yet must refuse the request, not relay it as if it were unbound.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/configuration', () => ({
    configuration: {
        currentCliVersion: 'test',
        happyHomeDir: '/tmp/happy-test',
        happyLibDir: '/tmp/happy-test/lib',
        isDaemonProcess: true,
        logsDir: '/tmp/happy-test/logs',
        serverUrl: 'http://127.0.0.1:3005',
    },
}))

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn(),
}))

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any
}

function rpcHandlers(portRegistry: unknown) {
    return {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
        requestShutdown: vi.fn(),
        portRegistry,
        aiCredentialRuntime: {
            capture: vi.fn(),
            apply: vi.fn(),
            status: vi.fn(),
            rotation: vi.fn(),
        },
    } as any
}

const BINDING = { projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: ['/srv/proj-1'] }

async function newClient() {
    const { ApiMachineClient } = await import('./apiMachine')
    return new ApiMachineClient('token', machineClient()) as any
}

async function boundedProbeOver(probe: (port: number) => Promise<unknown>, limits: { maxConcurrent: number; maxQueued: number; maxWaitMs: number }) {
    const { createBoundedProbe } = await import('@/daemon/previewRuntimeEvidence')
    return createBoundedProbe(probe as any, limits)
}

describe('ApiMachineClient preview runtime binding gate', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('relays a request that carries no binding, for an older happy-server', async () => {
        const client = await newClient()
        await expect(client.enforcePreviewBinding(undefined, 3000)).resolves.toEqual({ outcome: 'unbound' })
    })

    it('refuses a bound request before the daemon can verify it', async () => {
        // No port registry yet means the "is this port registered to another
        // project" half of the check cannot run. A partial check is not the
        // check, and "could not verify" is not "verified".
        const client = await newClient()
        await expect(client.enforcePreviewBinding(BINDING, 3000)).resolves.toMatchObject({
            outcome: 'rejected',
            code: 'EVIDENCE_UNAVAILABLE',
        })
    })

    it('verifies a bound request against the live runtime once the daemon is ready', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
        // Nothing is listening on this port in the test process, so the honest
        // verdict is a refusal — what matters is that it reached the probe
        // instead of being waved through.
        await expect(client.enforcePreviewBinding(BINDING, 59999)).resolves.toMatchObject({
            outcome: 'rejected',
        })
    })

    it('refuses a bound request whose port the registry gives to another project', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({
            readAll: vi.fn().mockResolvedValue({
                'session:other-project': { port: 3000, projectId: 'other-project' },
            }),
        }))
        await expect(client.enforcePreviewBinding(BINDING, 3000)).resolves.toMatchObject({
            outcome: 'rejected',
            code: 'PORT_PROJECT_MISMATCH',
        })
    })

    it('refuses with EVIDENCE_BUSY instead of queueing without bound when probes pile up', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
        let release!: (r: unknown) => void
        const stuck = new Promise((r) => { release = r })
        client.previewProbe = await boundedProbeOver(() => stuck, { maxConcurrent: 1, maxQueued: 0, maxWaitMs: 1_000 })
        const first = client.enforcePreviewBinding(BINDING, 3000)
        await expect(client.enforcePreviewBinding(BINDING, 3000)).resolves.toMatchObject({
            outcome: 'rejected',
            code: 'EVIDENCE_BUSY',
        })
        release({ status: 'none' })
        await expect(first).resolves.toMatchObject({ outcome: 'rejected', code: 'NO_LISTENER' })
    })

    it('routes the mint-time lease through the same bounded probe as the relay gate', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
        const probe = vi.fn(async () => ({ status: 'none' }))
        client.previewProbe = await boundedProbeOver(probe, { maxConcurrent: 1, maxQueued: 0, maxWaitMs: 1_000 })
        const deps = client.previewLeaseDeps()
        await expect(deps.probeEvidence(3000)).resolves.toEqual({ status: 'none' })
        expect(probe).toHaveBeenCalledWith(3000)
    })

    it('answers the mint-time lease inside the server ack window with EVIDENCE_BUSY when the probe cannot finish', async () => {
        vi.useFakeTimers()
        try {
            const client = await newClient()
            client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
            const probe = vi.fn(() => new Promise(() => { /* never settles */ }))
            client.previewProbe = await boundedProbeOver(probe, { maxConcurrent: 1, maxQueued: 10, maxWaitMs: 60_000 })
            const ack = vi.fn()
            const answered = client.answerPreviewRuntimeLease({ projectId: 'proj-1', port: 3000, workspacePaths: ['/srv/proj-1'] }, ack)
            await vi.advanceTimersByTimeAsync(2_500)
            await answered
            expect(ack).toHaveBeenCalledTimes(1)
            expect(ack).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', code: 'EVIDENCE_BUSY' }))
            // The relay gate, by contrast, is not under the 3 s ack window.
            expect(probe).toHaveBeenCalledWith(3000, expect.objectContaining({ deadlineMs: 2_500 }))
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('ApiMachineClient bound preview relay event', () => {
    // happy-server sends a bound request on its own event so that a daemon
    // predating runtime binding — which has no listener for it — cannot
    // execute the request at all. This side must therefore refuse to serve
    // that event unbound, or the separation buys nothing.
    it('refuses a bound-event request that carries no binding', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))

        const ack = await client.relayPreviewBoundHttp({ port: 3000, method: 'GET', path: '/' })

        expect(ack).toMatchObject({ type: 'error', code: 'INVALID_REQUEST' })
    })

    it('verifies the binding before it relays anything', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({
            readAll: vi.fn().mockResolvedValue({
                'session:other-project': { port: 3000, projectId: 'other-project' },
            }),
        }))

        const ack = await client.relayPreviewBoundHttp({
            port: 3000,
            method: 'POST',
            path: '/orders',
            binding: BINDING,
        })

        expect(ack).toMatchObject({ type: 'error', code: 'PORT_PROJECT_MISMATCH' })
    })

    it('refuses when the daemon is not ready to verify yet', async () => {
        const client = await newClient()

        const ack = await client.relayPreviewBoundHttp({ port: 3000, method: 'GET', path: '/', binding: BINDING })

        expect(ack).toMatchObject({ type: 'error', code: 'EVIDENCE_UNAVAILABLE' })
    })
})

describe('ApiMachineClient preview WS open cancellation', () => {
    // specs/runtime-isolation-hardening (H3, P2). Binding verification runs
    // *before* the upstream is opened, and it can take a while — a saturated
    // probe queue, a slow docker call. happy-server's open deadline can pass
    // during that window and it then tells us to close a tunnel it has
    // already forgotten. Until the tunnel exists inside previewWsProxy there
    // is nothing for that close to find, so it used to be dropped and the
    // upstream opened anyway: a ghost with no owner, no expiry timer and no
    // recheck behind it.
    function fakeWsProxy() {
        const opened: string[] = []
        const closed: string[] = []
        return {
            opened,
            closed,
            open: vi.fn(async (params: { tunnelId: string }) => {
                opened.push(params.tunnelId)
                return { ok: true }
            }),
            close: vi.fn((tunnelId: string) => { closed.push(tunnelId) }),
            closeAll: vi.fn(),
        }
    }

    /** Holds verification open until the test decides it resolved. */
    function deferredEnforce(client: any) {
        let release: (value: { outcome: string }) => void = () => { /* set below */ }
        const started = new Promise<void>((resolveStarted) => {
            client.enforcePreviewBinding = () => {
                resolveStarted()
                return new Promise((resolve) => { release = resolve })
            }
        })
        return { started, release: (value: { outcome: string }) => release(value) }
    }

    const OPEN = { tunnelId: 'tunnel-1', port: 3000, dataB64: '', binding: BINDING }

    it('never opens an upstream for a tunnel closed while it was being verified', async () => {
        const client = await newClient()
        const proxy = fakeWsProxy()
        client.previewWsProxy = proxy
        const enforce = deferredEnforce(client)

        const opening = client.openPreviewWsTunnel(OPEN)
        await enforce.started
        client.closePreviewWsTunnel('tunnel-1')
        enforce.release({ outcome: 'enforced' })
        const ack = await opening

        expect(proxy.opened).toEqual([])
        expect(ack).toMatchObject({ ok: false })
    })

    it('answers a cancelled open once, and a later close cannot resurrect it', async () => {
        const client = await newClient()
        const proxy = fakeWsProxy()
        client.previewWsProxy = proxy
        const enforce = deferredEnforce(client)

        const opening = client.openPreviewWsTunnel(OPEN)
        await enforce.started
        client.closePreviewWsTunnel('tunnel-1')
        enforce.release({ outcome: 'enforced' })
        await opening

        client.closePreviewWsTunnel('tunnel-1')
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(proxy.opened).toEqual([])
    })

    it('opens normally when nothing cancelled it', async () => {
        const client = await newClient()
        const proxy = fakeWsProxy()
        client.previewWsProxy = proxy
        client.enforcePreviewBinding = async () => ({ outcome: 'enforced' })

        const ack = await client.openPreviewWsTunnel(OPEN)

        expect(proxy.opened).toEqual(['tunnel-1'])
        expect(ack).toMatchObject({ ok: true, bindingEnforced: true })
    })

    it('cancels every in-flight verification when the daemon socket drops', async () => {
        const client = await newClient()
        const proxy = fakeWsProxy()
        client.previewWsProxy = proxy
        const enforce = deferredEnforce(client)

        const opening = client.openPreviewWsTunnel(OPEN)
        await enforce.started
        client.cancelPreviewWsTunnels()
        enforce.release({ outcome: 'enforced' })
        await opening

        expect(proxy.opened).toEqual([])
    })

    it('forgets a tunnel once its open has finished, either way', async () => {
        // The record exists only while an open is in flight. Keeping
        // tombstones for every tunnel id we ever saw would be an unbounded
        // map fed by the network.
        const client = await newClient()
        client.previewWsProxy = fakeWsProxy()
        client.enforcePreviewBinding = async () => ({ outcome: 'enforced' })

        await client.openPreviewWsTunnel(OPEN)
        await client.openPreviewWsTunnel({ ...OPEN, tunnelId: 'tunnel-2' })

        expect(client.previewWsPendingOpens.size).toBe(0)
    })

    it('still closes a tunnel that already opened', async () => {
        const client = await newClient()
        const proxy = fakeWsProxy()
        client.previewWsProxy = proxy
        client.enforcePreviewBinding = async () => ({ outcome: 'enforced' })

        await client.openPreviewWsTunnel(OPEN)
        client.closePreviewWsTunnel('tunnel-1')

        expect(proxy.closed).toEqual(['tunnel-1'])
    })
})

describe('ApiMachineClient bound preview WS event', () => {
    // The upgrade counterpart of the bound HTTP event: happy-server sends a
    // bound upgrade on an event an older daemon has no listener for, so the
    // handshake is never written to the port at all. This side must refuse to
    // serve that event unbound, or the separation buys nothing.
    it('refuses a bound-event upgrade that carries no binding', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
        client.previewWsProxy = { open: vi.fn(), close: vi.fn(), closeAll: vi.fn() }

        const ack = await client.openPreviewWsTunnelBound({ tunnelId: 't', port: 3000, dataB64: '' })

        expect(ack).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
        expect(client.previewWsProxy.open).not.toHaveBeenCalled()
    })

    it('verifies the binding before it opens anything', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({
            readAll: vi.fn().mockResolvedValue({
                'session:other-project': { port: 3000, projectId: 'other-project' },
            }),
        }))
        const open = vi.fn()
        client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

        const ack = await client.openPreviewWsTunnelBound({
            tunnelId: 't',
            port: 3000,
            dataB64: '',
            binding: BINDING,
        })

        expect(ack).toMatchObject({ ok: false, code: 'PORT_PROJECT_MISMATCH' })
        expect(open).not.toHaveBeenCalled()
    })
})

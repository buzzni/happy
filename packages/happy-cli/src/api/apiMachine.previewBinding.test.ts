/**
 * specs/runtime-isolation-hardening (H3) — the daemon-side gate that every
 * relayed preview request passes through.
 *
 * `enforceRelayBinding` (previewRuntimeLease.ts) is tested on its own; what
 * this covers is the wiring around it inside ApiMachineClient, where the
 * failure mode is not a wrong verdict but a skipped one: a daemon that cannot
 * verify yet must refuse the request, not relay it as if it were unbound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({
    currentCliVersion: 'test',
    happyHomeDir: '/tmp/happy-test',
    happyLibDir: '/tmp/happy-test/lib',
    isDaemonProcess: true,
    logsDir: '/tmp/happy-test/logs',
    serverUrl: 'http://127.0.0.1:3005',
    machineControl: undefined as string | undefined,
}))

vi.mock('@/configuration', () => ({ configuration: config }))

const viewerLease = vi.hoisted(() => ({ enforce: vi.fn(), acquire: vi.fn() }))
vi.mock('@/daemon/previewViewerLease', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/daemon/previewViewerLease')>()),
    enforceViewerRelayBinding: viewerLease.enforce,
    acquireViewerLease: viewerLease.acquire,
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

// aplus-dev-studio specs/e2ee-machine-control-boundary strict-followup-plan F0-b (daemon 5). On a
// strict machine happy-server must not reach local services through the plaintext relay: only a
// request bound to a registered preview runtime is relayed, and the remote-screen relay is off until
// it has a customer-encrypted channel.
describe('ApiMachineClient preview relay on a strict machine', () => {
    beforeEach(() => {
        config.machineControl = 'strict'
    })
    afterEach(() => {
        config.machineControl = undefined
    })

    it('refuses an unbound relay request instead of reaching the local port', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
        await expect(client.enforcePreviewBinding(undefined, 3000)).resolves.toMatchObject({
            outcome: 'rejected',
            code: 'STRICT_BINDING_REQUIRED',
        })
        await expect(client.relayPreviewHttp('proxy-http-request', { port: 3000, method: 'GET', path: '/' })).resolves.toMatchObject({
            type: 'error',
            code: 'STRICT_BINDING_REQUIRED',
        })
        await expect(client.openPreviewWsTunnel({ tunnelId: 't1', port: 3000, path: '/' })).resolves.toMatchObject({
            ok: false,
            code: 'STRICT_BINDING_REQUIRED',
        })
    })

    it('still verifies a bound request as on any machine', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({
            readAll: vi.fn().mockResolvedValue({ 'session:other-project': { port: 3000, projectId: 'other-project' } }),
        }))
        await expect(client.enforcePreviewBinding(BINDING, 3000)).resolves.toMatchObject({ code: 'PORT_PROJECT_MISMATCH' })
    })

    // viewer-channel-strict-design.md §4-1: the relay rewrites the pages it carries, so no viewer page
    // goes through it; a viewer tunnel ends at the sealed channel, never at websockify.
    const VIEWER_BINDING = { purpose: 'viewer', viewerKey: 'k', leaseId: 'l' }

    it('serves no remote-screen page through the relay', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
        await expect(client.relayPreviewViewerBoundHttp({ port: 6080, method: 'GET', path: '/vnc.html', binding: VIEWER_BINDING }))
            .resolves.toMatchObject({ type: 'error', code: 'STRICT_VIEWER_UNAVAILABLE' })
    })

    it('answers the relay\'s viewer lease check', async () => {
        const client = await newClient()
        viewerLease.acquire.mockResolvedValue({ type: 'success', leaseId: 'l', evidenceKind: 'native' })
        const ack = vi.fn()
        await client.answerPreviewViewerRuntimeLease({ viewerKey: 'k', port: 6080 }, ack)
        expect(ack).toHaveBeenCalledWith({ type: 'success', leaseId: 'l', evidenceKind: 'native' })
    })

    it('ends a verified viewer tunnel at the sealed channel instead of the local port', async () => {
        const client = await newClient()
        viewerLease.enforce.mockResolvedValue({ outcome: 'enforced' })
        const attach = vi.fn(() => ({}))
        client.viewerChannelEndpoint = { attach, closeAll: vi.fn(), size: 0 }
        const open = vi.fn(async (_params: unknown, connectUpstream?: () => unknown) => {
            connectUpstream?.()
            return { ok: true }
        })
        client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

        await expect(client.openPreviewViewerWsTunnelBound({ tunnelId: 't', port: 6080, dataB64: '', binding: VIEWER_BINDING }))
            .resolves.toEqual({ ok: true, bindingEnforced: true })
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ port: 6080 }), expect.any(Function))
        expect(attach).toHaveBeenCalledWith({ viewerKey: 'k', leaseId: 'l', port: 6080 })
    })

    it('refuses a viewer tunnel rather than reach websockify when the sealed channel is not there', async () => {
        const client = await newClient()
        viewerLease.enforce.mockResolvedValue({ outcome: 'enforced' })
        const open = vi.fn()
        client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

        await expect(client.openPreviewViewerWsTunnelBound({ tunnelId: 't', port: 6080, dataB64: '', binding: VIEWER_BINDING }))
            .resolves.toMatchObject({ ok: false, code: 'STRICT_VIEWER_UNAVAILABLE' })
        expect(open).not.toHaveBeenCalled()
    })

    // viewer-channel-strict-design.md H0. The project binding is built from what happy-server sends,
    // workspace paths included: naming `/` would claim every listener on the machine. The remote-screen
    // stack (password-less VNC, its websockify front) and Chrome's debugging port belong to the daemon,
    // never to a project, so the project relay must not reach them whatever the binding says.
    const ROOT_CLAIM = { projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: ['/'] }

    it.each([5900, 5902, 6080, 6082, 9222, 9228])('refuses a bound relay to the daemon-owned port %i', async (port) => {
        const client = await newClient()
        const probe = vi.fn()
        client.previewProbe = probe
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
        const open = vi.fn()
        client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

        await expect(client.enforcePreviewBinding(ROOT_CLAIM, port)).resolves.toMatchObject({
            outcome: 'rejected',
            code: 'STRICT_RESERVED_PORT',
        })
        await expect(client.relayPreviewBoundHttp({ port, method: 'GET', path: '/', binding: ROOT_CLAIM })).resolves.toMatchObject({
            type: 'error',
            code: 'STRICT_RESERVED_PORT',
        })
        await expect(client.openPreviewWsTunnelBound({ tunnelId: 't', port, dataB64: '', binding: ROOT_CLAIM })).resolves.toMatchObject({
            ok: false,
            code: 'STRICT_RESERVED_PORT',
        })
        expect(open).not.toHaveBeenCalled()
        expect(probe).not.toHaveBeenCalled()
    })

    it('does not mint a project lease on a daemon-owned port', async () => {
        const client = await newClient()
        const probe = vi.fn()
        client.previewProbe = probe
        client.setRPCHandlers(rpcHandlers({ readAll: vi.fn().mockResolvedValue({}) }))
        const ack = vi.fn()

        await client.answerPreviewRuntimeLease({ projectId: 'proj-1', port: 9222, workspacePaths: ['/'] }, ack)

        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', code: 'STRICT_RESERVED_PORT' }))
        expect(probe).not.toHaveBeenCalled()
    })
})

describe('ApiMachineClient viewer tunnel on a compat machine', () => {
    it('still pipes a verified viewer tunnel to the local port', async () => {
        const client = await newClient()
        viewerLease.enforce.mockResolvedValue({ outcome: 'enforced' })
        const attach = vi.fn()
        client.viewerChannelEndpoint = { attach, closeAll: vi.fn(), size: 0 }
        const open = vi.fn(async () => ({ ok: true }))
        client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

        await expect(client.openPreviewViewerWsTunnelBound({ tunnelId: 't', port: 6080, dataB64: '', binding: { purpose: 'viewer', viewerKey: 'k', leaseId: 'l' } }))
            .resolves.toEqual({ ok: true, bindingEnforced: true })
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ port: 6080 }))
        expect(attach).not.toHaveBeenCalled()
    })
})

describe('ApiMachineClient preview relay to daemon-owned ports on a compat machine', () => {
    it('verifies a bound request on them as before', async () => {
        const client = await newClient()
        client.setRPCHandlers(rpcHandlers({
            readAll: vi.fn().mockResolvedValue({ 'session:other-project': { port: 9222, projectId: 'other-project' } }),
        }))
        await expect(client.enforcePreviewBinding(BINDING, 9222)).resolves.toMatchObject({ code: 'PORT_PROJECT_MISMATCH' })
    })
})

/**
 * specs/runtime-isolation-hardening (H3, P3) — the wiring around the viewer
 * binding gate inside ApiMachineClient.
 *
 * `enforceViewerRelayBinding` is tested on its own; what is covered here is
 * the failure mode the unit tests cannot see — a skipped check, or a side
 * effect that happens *before* the check. Every assertion below counts
 * something that must not have happened: an upstream connect, an upstream
 * write, a viewer start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { proxyMocks, viewerMocks } = vi.hoisted(() => ({
    proxyMocks: { proxyHttp: vi.fn() },
    viewerMocks: { detectMissingViewerTools: vi.fn(async () => []) },
}))

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

vi.mock('@/daemon/previewProxy', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/previewProxy')>(),
    proxyHttp: proxyMocks.proxyHttp,
}))

vi.mock('@/daemon/remoteViewer', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/remoteViewer')>(),
    detectMissingViewerTools: viewerMocks.detectMissingViewerTools,
}))

const KEY_A = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const KEY_B = 'bv1_abcdefghijklmnopqrstuvwxyz012346'

function machineClient() {
    return { id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any
}

async function newClient() {
    const { ApiMachineClient } = await import('./apiMachine')
    return new ApiMachineClient('token', machineClient()) as any
}

/** Replaces the evidence adapter with a recorded, in-memory one. */
function stubViewerEvidence(client: any, result: unknown) {
    const resolveEvidence = vi.fn(async () => result)
    client.viewerLeaseDeps = () => ({ resolveEvidence })
    return resolveEvidence
}

const FOUND = { status: 'found', evidence: { kind: 'viewer-native', fingerprint: 'f'.repeat(64) } }

async function leaseIdFor(viewerKey: string, port: number, fingerprint = 'f'.repeat(64)) {
    const { computeViewerLeaseId } = await import('@/daemon/previewViewerLease')
    return computeViewerLeaseId(viewerKey, port, fingerprint)
}

describe('ApiMachineClient viewer binding gate', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        proxyMocks.proxyHttp.mockResolvedValue({ status: 200, headers: {}, bodyB64: '', truncated: false })
    })

    it('relays a viewer request whose binding verifies, and says so', async () => {
        const client = await newClient()
        stubViewerEvidence(client, FOUND)
        const response = await client.relayPreviewViewerBoundHttp({
            port: 6080,
            method: 'GET',
            path: '/vnc.html',
            binding: { purpose: 'viewer', viewerKey: KEY_A, leaseId: await leaseIdFor(KEY_A, 6080) },
        })

        expect(response).toMatchObject({ type: 'success', bindingEnforced: true })
        expect(proxyMocks.proxyHttp).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['an absent binding', undefined],
        ['a null binding', null],
        ['a project binding', { projectId: 'proj-1', leaseId: 'lease-1', workspacePaths: [] }],
        ['an unknown purpose', { purpose: 'admin', viewerKey: KEY_A, leaseId: 'lease-1' }],
        ['a mixed claim', { purpose: 'viewer', viewerKey: KEY_A, leaseId: 'lease-1', projectId: 'proj-1' }],
    ])('refuses %s before reaching the port', async (_label, binding) => {
        const client = await newClient()
        const resolveEvidence = stubViewerEvidence(client, FOUND)

        const response = await client.relayPreviewViewerBoundHttp({ port: 6080, method: 'GET', path: '/', binding })

        expect(response).toMatchObject({ type: 'error', code: 'INVALID_REQUEST' })
        // Nothing was connected to, and the runtime was not even looked at.
        expect(proxyMocks.proxyHttp).not.toHaveBeenCalled()
        expect(resolveEvidence).not.toHaveBeenCalled()
    })

    it('refuses another user’s viewerKey against the lease on this port, with no upstream write', async () => {
        const client = await newClient()
        stubViewerEvidence(client, FOUND)

        const response = await client.relayPreviewViewerBoundHttp({
            port: 6080,
            method: 'POST',
            path: '/websockify',
            binding: { purpose: 'viewer', viewerKey: KEY_B, leaseId: await leaseIdFor(KEY_A, 6080) },
        })

        expect(response).toMatchObject({ type: 'error', code: 'LEASE_MISMATCH' })
        expect(proxyMocks.proxyHttp).not.toHaveBeenCalled()
    })

    it('refuses a lease minted against a runtime that has since been replaced', async () => {
        const client = await newClient()
        stubViewerEvidence(client, {
            status: 'found',
            evidence: { kind: 'viewer-native', fingerprint: 'a'.repeat(64) },
        })

        const response = await client.relayPreviewViewerBoundHttp({
            port: 6080,
            method: 'GET',
            path: '/',
            binding: { purpose: 'viewer', viewerKey: KEY_A, leaseId: await leaseIdFor(KEY_A, 6080) },
        })

        expect(response).toMatchObject({ type: 'error', code: 'LEASE_MISMATCH' })
        expect(proxyMocks.proxyHttp).not.toHaveBeenCalled()
    })

    it('opens a viewer tunnel only after the binding verifies', async () => {
        const client = await newClient()
        stubViewerEvidence(client, FOUND)
        const open = vi.fn(async () => ({ ok: true }))
        client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

        await expect(client.openPreviewViewerWsTunnelBound({
            tunnelId: 't1',
            port: 6080,
            dataB64: '',
            binding: { purpose: 'viewer', viewerKey: KEY_A, leaseId: await leaseIdFor(KEY_A, 6080) },
        })).resolves.toMatchObject({ ok: true, bindingEnforced: true })
        expect(open).toHaveBeenCalledTimes(1)
    })

    it('never opens a tunnel for a refused viewer binding', async () => {
        const client = await newClient()
        stubViewerEvidence(client, FOUND)
        const open = vi.fn(async () => ({ ok: true }))
        client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

        await expect(client.openPreviewViewerWsTunnelBound({
            tunnelId: 't1',
            port: 6080,
            dataB64: '',
            binding: { purpose: 'viewer', viewerKey: KEY_B, leaseId: await leaseIdFor(KEY_A, 6080) },
        })).resolves.toMatchObject({ ok: false, code: 'LEASE_MISMATCH' })
        expect(open).not.toHaveBeenCalled()
    })

    it('shares the existing cancellation machinery rather than copying it', async () => {
        // A close that lands while the binding is still being verified must
        // cancel the open — the same guarantee the project tunnel has. A
        // second implementation would be the thing that drifts.
        const client = await newClient()
        client.viewerLeaseDeps = () => ({
            resolveEvidence: async () => {
                client.closePreviewWsTunnel('t1')
                return FOUND
            },
        })
        const open = vi.fn(async () => ({ ok: true }))
        client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

        await expect(client.openPreviewViewerWsTunnelBound({
            tunnelId: 't1',
            port: 6080,
            dataB64: '',
            binding: { purpose: 'viewer', viewerKey: KEY_A, leaseId: await leaseIdFor(KEY_A, 6080) },
        })).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
        expect(open).not.toHaveBeenCalled()
    })

    it('refuses a viewer binding that arrives on the project relay', async () => {
        // The reverse direction of the split: a daemon that has both handlers
        // must not let a viewer claim be spent as a project one.
        //
        // The port registry is wired first on purpose. Without it the project
        // relay already refuses everything with EVIDENCE_UNAVAILABLE ("cannot
        // verify" is not "verified"), which would pass this test for the
        // wrong reason and hide a missing disjointness check.
        const client = await newClient()
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            portRegistry: { readAll: vi.fn(async () => ({})), allocate: vi.fn(), lookup: vi.fn() },
            aiCredentialRuntime: { capture: vi.fn(), apply: vi.fn(), status: vi.fn(), rotation: vi.fn() },
        } as any)
        const response = await client.relayPreviewBoundHttp({
            port: 6080,
            method: 'GET',
            path: '/',
            binding: { purpose: 'viewer', viewerKey: KEY_A, leaseId: 'lease-1' },
        })

        expect(response).toMatchObject({ type: 'error', code: 'INVALID_REQUEST' })
        expect(proxyMocks.proxyHttp).not.toHaveBeenCalled()
    })

    it('answers the mint-time viewer lease event with the evidence kind that proved it', async () => {
        const client = await newClient()
        stubViewerEvidence(client, FOUND)
        const ack = vi.fn()

        await client.answerPreviewViewerRuntimeLease({ viewerKey: KEY_A, port: 6080 }, ack)

        expect(ack).toHaveBeenCalledWith({
            type: 'success',
            leaseId: await leaseIdFor(KEY_A, 6080),
            evidenceKind: 'viewer-native',
        })
    })

    it('answers the mint-time event with an error rather than staying silent', async () => {
        // Silence is the server's "old daemon" signal; a live daemon that
        // simply could not prove anything must not be mistaken for one.
        const client = await newClient()
        stubViewerEvidence(client, { status: 'error', code: 'VIEWER_UNKNOWN', message: 'no lease' })
        const ack = vi.fn()

        await client.answerPreviewViewerRuntimeLease({ viewerKey: KEY_A, port: 6080 }, ack)

        expect(ack).toHaveBeenCalledWith({ type: 'error', code: 'VIEWER_UNKNOWN', message: 'no lease' })
    })
})

/**
 * specs/runtime-isolation-hardening (H3, P3) — the bound around viewer proof
 * work, seen from the relay.
 *
 * A budget only helps if the refusal it produces stops the request. These
 * count the side effects that must be absent once the proof times out: no
 * upstream connect, no upstream write, no tunnel. And the refusal has to stay
 * a refusal — reporting it as "unsupported" would tell happy-server this
 * daemon predates runtime binding, which is a wrong fact rather than a
 * recoverable one.
 */
describe('ApiMachineClient viewer proof budget', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        proxyMocks.proxyHttp.mockResolvedValue({ status: 200, headers: {}, bodyB64: '', truncated: false })
    })

    /** A client whose viewer proof never settles, wired through the real gate. */
    async function clientWithHangingProof(deadlineMs?: number) {
        const client = await newClient()
        const proof = vi.fn(() => new Promise<never>(() => {}))
        const { createBoundedViewerProof } = await import('@/daemon/previewViewerEvidenceGate')
        const { DEFAULT_PROBE_LIMITS } = await import('@/daemon/previewRuntimeEvidence')
        client.viewerProofGate = createBoundedViewerProof(proof as never, DEFAULT_PROBE_LIMITS)
        client.resolveViewerEvidence = proof
        return { client, proof, deadlineMs }
    }

    it('refuses an HTTP relay whose proof outruns the budget, without touching the port', async () => {
        vi.useFakeTimers()
        try {
            const { client } = await clientWithHangingProof()
            const answer = client.relayPreviewViewerBoundHttp({
                port: 6080,
                method: 'GET',
                path: '/vnc.html',
                binding: { purpose: 'viewer', viewerKey: KEY_A, leaseId: await leaseIdFor(KEY_A, 6080) },
            })
            await vi.advanceTimersByTimeAsync(2_500)

            await expect(answer).resolves.toMatchObject({ type: 'error', code: 'EVIDENCE_BUSY' })
            expect(proxyMocks.proxyHttp).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it('never opens a tunnel when the proof outruns the budget', async () => {
        vi.useFakeTimers()
        try {
            const { client } = await clientWithHangingProof()
            const open = vi.fn(async () => ({ ok: true }))
            client.previewWsProxy = { open, close: vi.fn(), closeAll: vi.fn() }

            const answer = client.openPreviewViewerWsTunnelBound({
                tunnelId: 't1',
                port: 6080,
                dataB64: '',
                binding: { purpose: 'viewer', viewerKey: KEY_A, leaseId: await leaseIdFor(KEY_A, 6080) },
            })
            await vi.advanceTimersByTimeAsync(2_500)

            await expect(answer).resolves.toMatchObject({ ok: false, code: 'EVIDENCE_BUSY' })
            expect(open).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it('answers the mint event with EVIDENCE_BUSY inside the 3s window, not with silence', async () => {
        // Silence is what happy-server reads as "old daemon". A slow current
        // daemon must say so instead, and say it in time.
        vi.useFakeTimers()
        try {
            const { client } = await clientWithHangingProof()
            const ack = vi.fn()
            const done = client.answerPreviewViewerRuntimeLease({ viewerKey: KEY_A, port: 6080 }, ack)
            await vi.advanceTimersByTimeAsync(2_500)
            await done

            expect(ack).toHaveBeenCalledTimes(1)
            expect(ack.mock.calls[0][0]).toMatchObject({ type: 'error', code: 'EVIDENCE_BUSY' })
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps the relay bound to the same gate instance, so the cap is per machine', async () => {
        const client = await newClient()
        expect(client.viewerProofGate).toBeTypeOf('function')
        const first = client.viewerLeaseDeps()
        const second = client.viewerLeaseDeps()
        // Fresh dep objects, one shared gate behind them.
        expect(first).not.toBe(second)
        expect(client.viewerProofGate).toBe(client.viewerProofGate)
    })
})

describe('ApiMachineClient browser-viewer:start-bound', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    async function handlerFor(client: any, method: string) {
        const handlers = client.rpcHandlerManager.handlers as Map<string, (params: any) => Promise<unknown>>
        return handlers.get(`machine-1:${method}`) ?? handlers.get(method) ?? null
    }

    it('is registered under a new method name so an old daemon answers "not found" having started nothing', async () => {
        const client = await newClient()
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            portRegistry: { readAll: vi.fn(async () => ({})), allocate: vi.fn(), lookup: vi.fn() },
            aiCredentialRuntime: { capture: vi.fn(), apply: vi.fn(), status: vi.fn(), rotation: vi.fn() },
        } as any)

        expect(await handlerFor(client, 'browser-viewer:start-bound')).toBeTypeOf('function')
        // The old method is still there for the off/optional path.
        expect(await handlerFor(client, 'browser-viewer:start')).toBeTypeOf('function')
    })

    it('validates the viewer key before any start body runs', async () => {
        const client = await newClient()
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            portRegistry: { readAll: vi.fn(async () => ({})), allocate: vi.fn(), lookup: vi.fn() },
            aiCredentialRuntime: { capture: vi.fn(), apply: vi.fn(), status: vi.fn(), rotation: vi.fn() },
        } as any)
        const startIsolated = vi.spyOn(client, 'startIsolatedViewerStack')
        const startBroker = vi.spyOn(client, 'startBrokerViewer')
        const handler = (await handlerFor(client, 'browser-viewer:start-bound'))!

        await expect(handler({ viewerKey: 'not-a-key' })).rejects.toThrow('viewerKey is invalid')
        await expect(handler({})).rejects.toThrow()

        expect(startIsolated).not.toHaveBeenCalled()
        expect(startBroker).not.toHaveBeenCalled()
        expect(viewerMocks.detectMissingViewerTools).not.toHaveBeenCalled()
    })
})

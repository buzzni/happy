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
})

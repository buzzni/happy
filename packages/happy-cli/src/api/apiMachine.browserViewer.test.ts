import { beforeEach, describe, expect, it, vi } from 'vitest'

const { browserMocks, viewerMocks, fsMocks, mockRunPairing } = vi.hoisted(() => ({
    browserMocks: {
        detectChrome: vi.fn(),
        isCdpReachable: vi.fn(),
        launchChrome: vi.fn(),
    },
    viewerMocks: {
        detectMissingViewerTools: vi.fn(),
        isViewerServing: vi.fn(),
    },
    fsMocks: {
        readdir: vi.fn(),
        readFile: vi.fn(),
    },
    mockRunPairing: vi.fn(),
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

vi.mock('@/daemon/browserSetup', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/browserSetup')>(),
    detectChrome: browserMocks.detectChrome,
    isCdpReachable: browserMocks.isCdpReachable,
    launchChrome: browserMocks.launchChrome,
}))

vi.mock('@/daemon/remoteViewer', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/remoteViewer')>(),
    detectMissingViewerTools: viewerMocks.detectMissingViewerTools,
    isViewerServing: viewerMocks.isViewerServing,
}))

vi.mock('@/commands/browserPair', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/commands/browserPair')>(),
    runPairing: mockRunPairing,
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:fs/promises')>(),
    readdir: fsMocks.readdir,
    readFile: fsMocks.readFile,
}))

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any
}

function handlersFrom(client: any): Map<string, (params: any) => Promise<any>> {
    return client.rpcHandlerManager.handlers
}

function rpcHandlers() {
    return {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
        requestShutdown: vi.fn(),
        portRegistry: {
            allocate: vi.fn(),
            get: vi.fn(),
            release: vi.fn(),
            list: vi.fn(),
            sweep: vi.fn(),
        },
        aiCredentialRuntime: {
            capture: vi.fn(),
            apply: vi.fn(),
            status: vi.fn(),
            rotation: vi.fn(),
        },
    } as any
}

describe('ApiMachineClient browser viewer RPC', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        viewerMocks.detectMissingViewerTools.mockResolvedValue([])
        viewerMocks.isViewerServing.mockResolvedValue(true)
        browserMocks.detectChrome.mockResolvedValue({
            path: '/usr/bin/google-chrome',
            version: 'Chrome test',
        })
        browserMocks.isCdpReachable.mockImplementation(async (port: number) => port === 9222)
        browserMocks.launchChrome.mockReturnValue({ pid: 1234 })
        fsMocks.readdir.mockResolvedValue(['100'])
        fsMocks.readFile.mockImplementation(async (path: string) => path.endsWith('/cmdline')
            ? '/usr/bin/google-chrome\0--remote-debugging-port=9222\0--user-data-dir=/tmp/happy-test/chrome-profiles/default'
            : 'PATH=/usr/bin\0DISPLAY=:99\0')
        mockRunPairing.mockResolvedValue({
            cdpPort: 9222,
            extensionDir: '/opt/happy/browser-extension',
            daemonRunning: true,
            cdpReachable: true,
            extensionLoaded: true,
            pageOpened: true,
            connections: [{ profile: 'work', pairingId: 'viewer-9222' }],
            freshProfiles: [],
            targetPairingId: 'viewer-9222',
            debuggerTierRequested: true,
            debuggerTierActual: true,
        })
    })

    it('pairs a reused viewer Chrome on the exact CDP port before reporting bridge readiness', async () => {
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({})

        expect(mockRunPairing).toHaveBeenCalledWith({
            cdpPort: 9222,
            debuggerTier: true,
            pairingId: expect.stringMatching(/^viewer-9222-/),
        })
        expect(result).toMatchObject({
            browserReady: true,
            cdpPort: 9222,
            bridgeReady: true,
        })
    })

    it('reuses the viewer Chrome after Chrome removes DISPLAY from its environment', async () => {
        fsMocks.readFile.mockImplementation(async (path: string) => path.endsWith('/cmdline')
            ? '/usr/bin/google-chrome\0--remote-debugging-port=9222\0--user-data-dir=/tmp/happy-test/chrome-profiles/default\0--display=:99'
            : 'PATH=/usr/bin\0')
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({})

        expect(result).toMatchObject({
            browserReady: true,
            cdpPort: 9222,
        })
    })

    it('does not treat another connected profile as proof that the viewer Chrome is paired', async () => {
        mockRunPairing.mockResolvedValue({
            cdpPort: 9222,
            extensionDir: '/opt/happy/browser-extension',
            daemonRunning: true,
            cdpReachable: true,
            extensionLoaded: false,
            loadUnpackedFailed: true,
            pageOpened: true,
            connections: [{ profile: 'unrelated-headless', pairingId: 'other-run' }],
            freshProfiles: [],
            targetPairingId: 'viewer-9222',
            debuggerTierRequested: true,
        })
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({})

        expect(result).toMatchObject({
            browserReady: true,
            cdpPort: 9222,
            bridgeReady: false,
        })
        expect(result.bridgeMessage).toContain('--enable-unsafe-extension-debugging')
    })

    it('does not accept an unrelated connection even when the viewer extension is already loaded', async () => {
        mockRunPairing.mockResolvedValue({
            cdpPort: 9222,
            extensionDir: '/opt/happy/browser-extension',
            daemonRunning: true,
            cdpReachable: true,
            extensionLoaded: true,
            pageOpened: true,
            connections: [{ profile: 'unrelated-headless', pairingId: 'other-run' }],
            freshProfiles: [],
            targetPairingId: 'viewer-9222',
            debuggerTierRequested: true,
            debuggerTierActual: true,
        })
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({})

        expect(result).toMatchObject({ bridgeReady: false })
        expect(result.bridgeMessage).toContain('viewer-9222')
    })

    it('does not reuse a reachable headless Chrome as the browser shown by noVNC', async () => {
        fsMocks.readFile.mockImplementation(async (path: string) => path.endsWith('/cmdline')
            ? '/usr/bin/google-chrome\0--remote-debugging-port=9222\0--user-data-dir=/tmp/happy-test/chrome-profiles/default'
            : 'PATH=/usr/bin\0')
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({})

        expect(result).toMatchObject({
            browserReady: false,
            reason: 'browser-failed',
        })
        expect(mockRunPairing).not.toHaveBeenCalled()
    })

    it('pairs a newly launched viewer Chrome on the port that became reachable', async () => {
        fsMocks.readdir.mockResolvedValue([])
        const probeResults = [false, false, false, false, false, false, false, true]
        browserMocks.isCdpReachable.mockImplementation(async () => probeResults.shift() ?? true)
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({})

        expect(browserMocks.launchChrome).toHaveBeenCalledWith(
            '/usr/bin/google-chrome',
            expect.objectContaining({ cdpPort: 9222, headless: false }),
            { DISPLAY: ':99' },
        )
        expect(mockRunPairing).toHaveBeenCalledWith({
            cdpPort: 9222,
            debuggerTier: true,
            pairingId: expect.stringMatching(/^viewer-9222-/),
        })
        expect(result).toMatchObject({
            browserReady: true,
            cdpPort: 9222,
            bridgeReady: true,
        })
    })
})

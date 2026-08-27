import { beforeEach, describe, expect, it, vi } from 'vitest'

const { browserMocks, viewerMocks, fsMocks, leaseRegistryMocks, mockRunPairing } = vi.hoisted(() => ({
    browserMocks: {
        detectChrome: vi.fn(),
        isCdpReachable: vi.fn(),
        launchChrome: vi.fn(),
        cdpPipe: {
            request: vi.fn(),
            close: vi.fn(),
        },
    },
    viewerMocks: {
        detectMissingViewerTools: vi.fn(),
        isViewerServing: vi.fn(),
    },
    fsMocks: {
        readdir: vi.fn(),
        readFile: vi.fn(),
    },
    leaseRegistryMocks: {
        records: new Map<string, any>(),
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

vi.mock('@/daemon/browserViewerLeaseRegistry', () => ({
    BrowserViewerLeaseRegistry: class {
        async list() { return [...leaseRegistryMocks.records.values()] }
        async get(viewerKey: string) { return leaseRegistryMocks.records.get(viewerKey) ?? null }
        async set(lease: any) { leaseRegistryMocks.records.set(lease.viewerKey, lease) }
        async delete(viewerKey: string) { return leaseRegistryMocks.records.delete(viewerKey) }
    },
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

const ALICE_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const BOB_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012346'

function lease(viewerKey: string, slot: number) {
    return {
        viewerKey,
        slot,
        display: `:${99 + slot}`,
        vncPort: 5900 + slot,
        webPort: 6080 + slot,
        cdpPort: 9222 + slot,
        profileDir: `/tmp/happy-test/browser-viewers/${viewerKey}/chrome-profile`,
        lastUsedAt: 1,
    }
}

describe('ApiMachineClient browser viewer RPC', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        leaseRegistryMocks.records.clear()
        leaseRegistryMocks.records.set(ALICE_KEY, lease(ALICE_KEY, 0))
        viewerMocks.detectMissingViewerTools.mockResolvedValue([])
        viewerMocks.isViewerServing.mockResolvedValue(true)
        browserMocks.detectChrome.mockResolvedValue({
            path: '/usr/bin/google-chrome',
            version: 'Chrome test',
        })
        browserMocks.isCdpReachable.mockImplementation(async (port: number) => port === 9222)
        browserMocks.launchChrome.mockReturnValue({ pid: 1234, cdpPipe: browserMocks.cdpPipe })
        fsMocks.readdir.mockResolvedValue(['100'])
        fsMocks.readFile.mockImplementation(async (path: string) => path.endsWith('/cmdline')
            ? `/usr/bin/google-chrome\0--remote-debugging-port=9222\0--user-data-dir=/tmp/happy-test/browser-viewers/${ALICE_KEY}/chrome-profile`
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

    it('rate-limits broker touches from active relay frames', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient()) as any
        const request = vi.fn().mockResolvedValue({ ok: true, lease: null })
        client.browserSessionBroker = { request }
        try {
            client.touchBrokerViewerPort(6080)
            client.touchBrokerViewerPort(6080)
            expect(request).toHaveBeenCalledTimes(1)
            expect(request).toHaveBeenCalledWith({ op: 'touch-port', webPort: 6080 })

            now.mockReturnValue(61_000)
            client.touchBrokerViewerPort(6080)
            expect(request).toHaveBeenCalledTimes(2)
        } finally {
            now.mockRestore()
        }
    })

    it('pairs a reused viewer Chrome on the exact CDP port before reporting bridge readiness', async () => {
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

        expect(mockRunPairing).toHaveBeenCalledWith({
            cdpPort: 9222,
            debuggerTier: true,
            pairingId: expect.stringMatching(/^viewer-9222-/),
            forceExtensionReload: false,
            viewerKey: ALICE_KEY,
        })
        expect(result).toMatchObject({
            browserReady: true,
            cdpPort: 9222,
            bridgeReady: true,
        })
    })

    it('reuses the viewer Chrome after Chrome removes DISPLAY from its environment', async () => {
        fsMocks.readFile.mockImplementation(async (path: string) => path.endsWith('/cmdline')
            ? `/usr/bin/google-chrome\0--remote-debugging-port=9222\0--user-data-dir=/tmp/happy-test/browser-viewers/${ALICE_KEY}/chrome-profile\0--display=:99`
            : 'PATH=/usr/bin\0')
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

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

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

        expect(result).toMatchObject({
            browserReady: true,
            cdpPort: 9222,
            bridgeReady: false,
        })
        expect(result.bridgeMessage).toContain('--enable-unsafe-extension-debugging')
    })

    it('reloads the extension only after marker pairing fails without a reload', async () => {
        mockRunPairing
            .mockResolvedValueOnce({
                cdpPort: 9222,
                extensionDir: '/opt/happy/browser-extension',
                daemonRunning: true,
                cdpReachable: true,
                extensionLoaded: true,
                pageOpened: true,
                connections: [{ profile: 'work' }],
                freshProfiles: [],
                targetPairingId: 'viewer-9222',
                debuggerTierRequested: true,
            })
            .mockResolvedValueOnce({
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
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

        expect(mockRunPairing).toHaveBeenCalledTimes(2)
        expect(mockRunPairing).toHaveBeenNthCalledWith(1, expect.objectContaining({
            forceExtensionReload: false,
        }))
        expect(mockRunPairing).toHaveBeenNthCalledWith(2, expect.objectContaining({
            forceExtensionReload: true,
        }))
        expect(result).toMatchObject({ bridgeReady: true })
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

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

        expect(result).toMatchObject({ bridgeReady: false })
        expect(result.bridgeMessage).toContain('viewer-9222')
    })

    it('does not reuse a reachable headless Chrome as the browser shown by noVNC', async () => {
        fsMocks.readFile.mockImplementation(async (path: string) => path.endsWith('/cmdline')
            ? `/usr/bin/google-chrome\0--remote-debugging-port=9222\0--user-data-dir=/tmp/happy-test/browser-viewers/${ALICE_KEY}/chrome-profile`
            : 'PATH=/usr/bin\0')
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

        expect(result).toMatchObject({
            browserReady: false,
            reason: 'browser-failed',
        })
        expect(mockRunPairing).not.toHaveBeenCalled()
    })

    it('pairs a newly launched viewer Chrome on the port that became reachable', async () => {
        fsMocks.readdir.mockResolvedValue([])
        const reachablePorts = new Set<number>()
        browserMocks.isCdpReachable.mockImplementation(async (port: number) => reachablePorts.has(port))
        browserMocks.launchChrome.mockImplementation((_path: string, options: { cdpPort: number }) => {
            reachablePorts.add(options.cdpPort)
            return { pid: 1234, cdpPipe: browserMocks.cdpPipe }
        })
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

        const launchedOptions = browserMocks.launchChrome.mock.calls[0]?.[1]
        expect(browserMocks.launchChrome).toHaveBeenCalledWith(
            '/usr/bin/google-chrome',
            expect.objectContaining({ cdpPort: launchedOptions.cdpPort, headless: false }),
            { DISPLAY: ':99' },
        )
        expect(mockRunPairing).toHaveBeenCalledWith({
            cdpPort: launchedOptions.cdpPort,
            debuggerTier: true,
            pairingId: expect.stringMatching(new RegExp(`^viewer-${launchedOptions.cdpPort}-`)),
            viewerKey: ALICE_KEY,
            browserCdpRequest: expect.any(Function),
            forceExtensionReload: false,
        })
        const pairingOptions = mockRunPairing.mock.calls[0]?.[0]
        await pairingOptions.browserCdpRequest('Extensions.loadUnpacked', { path: '/extension' })
        expect(browserMocks.cdpPipe.request).toHaveBeenCalledWith(
            'Extensions.loadUnpacked',
            { path: '/extension' },
        )
        expect(result).toMatchObject({
            browserReady: true,
            cdpPort: launchedOptions.cdpPort,
            bridgeReady: true,
        })
    })

    it('shares one in-flight viewer start across concurrent RPC calls', async () => {
        let releaseToolProbe: (missing: string[]) => void = () => {}
        viewerMocks.detectMissingViewerTools.mockReturnValueOnce(new Promise((resolve) => {
            releaseToolProbe = resolve
        }))
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())
        const start = handlersFrom(client).get('machine-1:browser-viewer:start')!

        const first = start({ viewerKey: ALICE_KEY })
        const second = start({ viewerKey: ALICE_KEY })
        await vi.waitFor(() => {
            expect(viewerMocks.detectMissingViewerTools).toHaveBeenCalledTimes(1)
        })
        releaseToolProbe([])

        await expect(Promise.all([first, second])).resolves.toHaveLength(2)
        expect(mockRunPairing).toHaveBeenCalledTimes(1)
    })

    it('isolates viewer leases for different viewer keys on the same machine', async () => {
        const reachablePorts = new Set([9222])
        browserMocks.isCdpReachable.mockImplementation(async (port: number) => reachablePorts.has(port))
        browserMocks.launchChrome.mockImplementation((_path: string, options: { cdpPort: number }) => {
            reachablePorts.add(options.cdpPort)
            return { pid: 1234, cdpPipe: browserMocks.cdpPipe }
        })
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())
        const start = handlersFrom(client).get('machine-1:browser-viewer:start')!

        leaseRegistryMocks.records.set(BOB_KEY, lease(BOB_KEY, 1))
        const alice = await start({ viewerKey: ALICE_KEY })
        const bob = await start({ viewerKey: BOB_KEY })

        expect(alice.viewerKey).toBe(ALICE_KEY)
        expect(bob.viewerKey).toBe(BOB_KEY)
        expect(bob.display).not.toBe(alice.display)
        expect(bob.webPort).not.toBe(alice.webPort)
        expect(bob.profileDir).not.toBe(alice.profileDir)
    })

    it('looks up and stops only the requested viewer lease', async () => {
        leaseRegistryMocks.records.set(BOB_KEY, lease(BOB_KEY, 1))
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())
        const handlers = handlersFrom(client)

        await expect(handlers.get('machine-1:browser-viewer:lookup')?.({ viewerKey: ALICE_KEY }))
            .resolves.toMatchObject({ viewerKey: ALICE_KEY, webPort: 6080, ready: true })
        await expect(handlers.get('machine-1:browser-viewer:stop')?.({ viewerKey: ALICE_KEY }))
            .resolves.toEqual({ viewerKey: ALICE_KEY, stopped: true })
        expect(leaseRegistryMocks.records.has(ALICE_KEY)).toBe(false)
        expect(leaseRegistryMocks.records.has(BOB_KEY)).toBe(true)
        await expect(handlers.get('machine-1:browser-viewer:lookup')?.({ viewerKey: ALICE_KEY }))
            .resolves.toBeNull()
    })

    it('rejects viewer start without a server-derived viewer key', async () => {
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())
        const start = handlersFrom(client).get('machine-1:browser-viewer:start')!

        await expect(start({})).rejects.toThrow('viewerKey is required')
    })
})

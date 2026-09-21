import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIEWER_VNC_PORTS, VIEWER_WEB_PORTS, isPortFree, type DetachedProcess } from '@/daemon/remoteViewer'

const { browserMocks, viewerMocks, fsMocks, daemonMocks, leaseRegistryMocks, mockRunPairing } = vi.hoisted(() => ({
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
        detectViewerCapabilities: vi.fn(),
        isViewerServing: vi.fn(),
    },
    daemonMocks: {
        spawnDetached: vi.fn((..._args: any[]): DetachedProcess => ({ pid: 1234, exit: null })),
        ensureViewerWebRoot: vi.fn(() => '/usr/share/novnc'),
        canSudoWithoutPassword: vi.fn(async () => false),
        exec: vi.fn(),
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
    // The real probe shells out to `sudo -n true` on the test machine.
    canSudoWithoutPassword: daemonMocks.canSudoWithoutPassword,
}))

vi.mock('node:child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    exec: daemonMocks.exec,
}))

vi.mock('@/daemon/remoteViewer', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/remoteViewer')>(),
    detectViewerCapabilities: viewerMocks.detectViewerCapabilities,
    isViewerServing: viewerMocks.isViewerServing,
    // Real spawns would fork Xvnc/openbox off the test runner.
    spawnDetached: daemonMocks.spawnDetached,
}))

vi.mock('@/daemon/viewerWebRoot', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/viewerWebRoot')>(),
    ensureViewerWebRoot: daemonMocks.ensureViewerWebRoot,
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
        viewerMocks.detectViewerCapabilities.mockResolvedValue({
            hasXvnc: true,
            hasXvfb: true,
            hasX11vnc: true,
            hasWebsockify: true,
            hasWindowManager: true,
            hasVncConfig: true,
        })
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

    // The install button is what turns a scaled screen into an exact fit, so
    // it installs the whole modern stack — not only what blocks the screen.
    it('installs the exact-fill stack on a machine whose screen already works', async () => {
        viewerMocks.detectViewerCapabilities.mockResolvedValue({
            hasXvnc: false,
            hasXvfb: true,
            hasX11vnc: true,
            hasWebsockify: true,
            hasWindowManager: false,
            hasVncConfig: true,
        })
        daemonMocks.canSudoWithoutPassword.mockResolvedValue(true)
        daemonMocks.exec.mockImplementation((_command: string, _options: unknown, done: any) => {
            done(null, '', '')
        })
        // The remote screen is a Linux feature; the plan is honest about
        // having no apt command anywhere else, including this test runner.
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        try {
            const { ApiMachineClient } = await import('./apiMachine')
            const client = new ApiMachineClient('token', machineClient())
            client.setRPCHandlers(rpcHandlers())

            const result: any = await handlersFrom(client).get('machine-1:browser-viewer:install')?.({})

            expect(result.command).toContain('tigervnc-standalone-server')
            expect(result.command).toContain('openbox')
            // The install ran and the screen still opens, but the capability
            // probe says the upgrade did not take. Reporting only `ok` here
            // would claim a fit the user is not going to get.
            expect(result.ok).toBe(true)
            expect(result.upgradable).toEqual(['Xvnc', 'openbox'])
        } finally {
            Object.defineProperty(process, 'platform', platform)
        }
    })

    // The screen cannot open without a display server, and the failure has to
    // reach the user as one — quietly handing back a dead port is how this
    // feature looked broken before (2026-08-14).
    it('refuses to start when the machine has no display server at all', async () => {
        viewerMocks.detectViewerCapabilities.mockResolvedValue({
            hasXvnc: false,
            hasXvfb: false,
            hasX11vnc: false,
            hasWebsockify: true,
            hasWindowManager: false,
            hasVncConfig: true,
        })
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        await expect(handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY }))
            .rejects.toThrow(/Xvnc/)
    })

    // Xvfb + x11vnc is the older pair; it still runs the screen, so a machine
    // that has it must never be told to install anything.
    it('does not block a machine that only has the legacy Xvfb and x11vnc pair', async () => {
        viewerMocks.detectViewerCapabilities.mockResolvedValue({
            hasXvnc: false,
            hasXvfb: true,
            hasX11vnc: true,
            hasWebsockify: true,
            hasWindowManager: false,
            hasVncConfig: true,
        })
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())

        const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

        expect(result).toMatchObject({ webPort: 6080, browserReady: true })
    })

    describe('starting a stack from nothing', () => {
        // Every other test here reuses a serving stack, so the spawn sequence
        // itself — which display server, its helpers, and the page that gets
        // served — was never exercised. The spawns are mocked, so the ports
        // they would have opened are opened here instead, which is what lets
        // the real readiness waits return at once instead of timing out.
        const held: Array<() => Promise<void>> = []

        /** A port taken by something that accepts and then says nothing. */
        async function holdPort(port: number): Promise<void> {
            const { createServer } = await import('node:net')
            await new Promise<void>((resolve, reject) => {
                const server = createServer((socket) => socket.destroy())
                // Swallowing EADDRINUSE here would let the test run against a
                // slot it does not actually control and report the resulting
                // slot choice as a logic failure.
                server.once('error', reject)
                server.listen(port, '127.0.0.1', () => {
                    held.push(() => new Promise<void>((done) => server.close(() => done())))
                    resolve()
                })
            })
        }

        /**
         * These tests drive the daemon's fixed slots (5900-5902 / 6080-6082),
         * which are real ports on this host. A viewer actually running here
         * would change which slot the daemon picks, so say that outright
         * rather than let it surface as a wrong webPort.
         */
        async function assertViewerPortsFree(): Promise<void> {
            for (const port of [...VIEWER_VNC_PORTS, ...VIEWER_WEB_PORTS]) {
                if (await isPortFree(port)) continue
                throw new Error(`viewer port ${port} is in use on this host; these tests need the daemon's fixed slots`)
            }
        }

        /**
         * The web port, answering noVNC's page like a live websockify.
         *
         * A bound-but-silent socket used to be enough here, because the wait
         * only asked whether the port was taken. That is the dead listener
         * the 2026-09-21 outage handed to users, so the stand-in now has to
         * do what the real thing does.
         */
        function serveNovnc(port: number): void {
            void (async () => {
                const { createServer } = await import('node:http')
                const server = createServer((req, res) => {
                    if (req.url !== '/vnc.html') { res.writeHead(404); res.end(); return }
                    res.writeHead(200, { 'Content-Type': 'text/html' })
                    res.end('<!DOCTYPE html>')
                })
                server.once('error', () => undefined)
                server.listen(port, '127.0.0.1', () => {
                    held.push(() => new Promise<void>((done) => server.close(() => done())))
                })
            })()
        }

        beforeEach(async () => {
            leaseRegistryMocks.records.clear()
            viewerMocks.isViewerServing.mockResolvedValue(false)
            daemonMocks.spawnDetached.mockImplementation((...call: any[]): DetachedProcess => {
                const [command, args] = call as [string, string[]]
                // buildWebsockifyArgs: ['--web', root, '127.0.0.1:<web>', '127.0.0.1:<vnc>']
                if (command === 'websockify') serveNovnc(Number(args[2].split(':')[1]))
                return { pid: 1234, exit: null }
            })
            await assertViewerPortsFree()
            // The display server is mocked too, so its port is opened here —
            // for every slot, since which one the daemon picks is part of
            // what these tests check.
            for (const vncPort of VIEWER_VNC_PORTS) await holdPort(vncPort)
        })

        afterEach(async () => {
            daemonMocks.spawnDetached.mockImplementation((..._call: any[]): DetachedProcess => ({ pid: 1234, exit: null }))
            while (held.length > 0) await (held.pop() as () => Promise<void>)()
        })

        it('runs Xvnc with its clipboard helper and a window manager, and serves the resizing page', async () => {
            const { ApiMachineClient } = await import('./apiMachine')
            const client = new ApiMachineClient('token', machineClient())
            client.setRPCHandlers(rpcHandlers())

            await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

            const spawned = daemonMocks.spawnDetached.mock.calls.map((call: any[]) => call[0])
            expect(spawned).toContain('Xvnc')
            expect(spawned).not.toContain('Xvfb')
            expect(spawned).not.toContain('x11vnc')
            // Without vncconfig a paste reaches Xvnc and stops there; without
            // openbox the resized desktop is wider than the browser window.
            expect(spawned).toContain('vncconfig')
            expect(spawned).toContain('openbox')
            expect(daemonMocks.ensureViewerWebRoot).toHaveBeenCalledWith(
                expect.objectContaining({ resizeMode: 'remote' }),
            )
        })

        // Now that an unbindable port counts as occupied, a websockify that
        // is bound but no longer serving would hold its slot for good. The
        // moment its owner reopens the screen is the last one where its pids
        // are still known, so that is where the stack is reaped.
        it('reaps its own stale viewer processes and takes the slot back', async () => {
            leaseRegistryMocks.records.set(ALICE_KEY, {
                ...lease(ALICE_KEY, 0),
                processIds: { websockify: 777001, xvnc: 777002 },
            })
            await holdPort(6080)
            const releaseWebPort = held[held.length - 1]
            fsMocks.readFile.mockImplementation(async (path: string) => {
                if (path === '/proc/777001/cmdline') return 'websockify\x00--web\x00/root\x00127.0.0.1:6080\x00127.0.0.1:5900\x00'
                if (path === '/proc/777002/cmdline') return 'Xvnc\x00:99\x00-rfbport\x005900\x00'
                return path.endsWith('/cmdline') ? '/usr/bin/google-chrome\x00' : 'PATH=/usr/bin\x00'
            })
            // SIGTERM returns before the process is gone, so the port is only
            // free a moment later — exactly the gap the reap has to wait out.
            const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
                if (pid === -777001) setTimeout(() => void releaseWebPort(), 150)
                return true
            })
            try {
                const { ApiMachineClient } = await import('./apiMachine')
                const client = new ApiMachineClient('token', machineClient())
                client.setRPCHandlers(rpcHandlers())

                const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

                expect(kill).toHaveBeenCalledWith(-777001, 'SIGTERM')
                expect(kill).toHaveBeenCalledWith(-777002, 'SIGTERM')
                // Reclaiming the slot is the point: without waiting for the
                // port, the loop below still reads it as occupied and the
                // viewer is pushed onto a fresh slot for nothing.
                expect(result).toMatchObject({ webPort: 6080, ready: true })
            } finally {
                kill.mockRestore()
            }
        })

        // Same hazard through the other door: lookup re-registers the lease it
        // was handed, so a cached one whose record was already released would
        // put it back — pointing at a slot its former owner no longer holds.
        it('reports no lease once its registry record has been released', async () => {
            const { ApiMachineClient } = await import('./apiMachine')
            const client = new ApiMachineClient('token', machineClient())
            client.setRPCHandlers(rpcHandlers())
            const handlers = handlersFrom(client)

            await handlers.get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })
            leaseRegistryMocks.records.delete(ALICE_KEY)
            viewerMocks.isViewerServing.mockResolvedValue(true)

            const looked = await handlers.get('machine-1:browser-viewer:lookup')?.({ viewerKey: ALICE_KEY })

            expect(looked).toBeNull()
            expect(leaseRegistryMocks.records.has(ALICE_KEY)).toBe(false)
        })

        // A lease deleted from the registry must not come back from the
        // daemon's own cache: the slot may already belong to someone else, and
        // the reuse path would hand this viewer their live screen.
        it('does not resurrect a lease another viewer has taken over', async () => {
            const { ApiMachineClient } = await import('./apiMachine')
            const client = new ApiMachineClient('token', machineClient())
            client.setRPCHandlers(rpcHandlers())
            const start = handlersFrom(client).get('machine-1:browser-viewer:start')!

            const alice = await start({ viewerKey: ALICE_KEY })
            expect(alice).toMatchObject({ webPort: 6080 })
            // Alice's screen dies; Bob's start releases her registry record.
            const bob = await start({ viewerKey: BOB_KEY })
            expect(bob).toMatchObject({ webPort: 6081 })

            viewerMocks.isViewerServing.mockResolvedValue(true)
            const aliceAgain = await start({ viewerKey: ALICE_KEY })

            expect(aliceAgain).not.toMatchObject({ webPort: 6080 })
            expect(aliceAgain).toMatchObject({ webPort: 6082 })
        })

        // The lease is about to be rewritten with a new slot, so these pids are
        // the last record of the stack holding the old one. Giving up on
        // SIGTERM strands that slot for the life of the machine.
        it('escalates to SIGKILL when its own stack ignores SIGTERM', async () => {
            leaseRegistryMocks.records.set(ALICE_KEY, {
                ...lease(ALICE_KEY, 0),
                processIds: { websockify: 777001 },
            })
            await holdPort(6080)
            const releaseWebPort = held[held.length - 1]
            fsMocks.readFile.mockImplementation(async (path: string) => {
                if (path === '/proc/777001/cmdline') return 'websockify\x00--web\x00/root\x00127.0.0.1:6080\x00127.0.0.1:5900\x00'
                return path.endsWith('/cmdline') ? '/usr/bin/google-chrome\x00' : 'PATH=/usr/bin\x00'
            })
            const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: unknown) => {
                if (pid === -777001 && signal === 'SIGKILL') void releaseWebPort()
                return true
            })
            try {
                const { ApiMachineClient } = await import('./apiMachine')
                const client = new ApiMachineClient('token', machineClient())
                client.setRPCHandlers(rpcHandlers())

                const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

                expect(kill).toHaveBeenCalledWith(-777001, 'SIGKILL')
                expect(result).toMatchObject({ webPort: 6080, ready: true })
            } finally {
                kill.mockRestore()
            }
        }, 20_000)

        // Releasing a record is the last moment its pids are known, for other
        // viewers exactly as for our own. A port still bound after its screen
        // stopped answering is a stack nobody can reach and nobody can reap —
        // its owner least of all, since the lease naming it was just dropped.
        it('reaps another viewer whose released slot is still bound', async () => {
            leaseRegistryMocks.records.set(BOB_KEY, {
                ...lease(BOB_KEY, 1),
                processIds: { websockify: 777010 },
            })
            await holdPort(6081)
            const releaseBob = held[held.length - 1]
            fsMocks.readFile.mockImplementation(async (path: string) => {
                if (path === '/proc/777010/cmdline') return 'websockify\x00--web\x00/root\x00127.0.0.1:6081\x00127.0.0.1:5901\x00'
                return path.endsWith('/cmdline') ? '/usr/bin/google-chrome\x00' : 'PATH=/usr/bin\x00'
            })
            const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
                if (pid === -777010) void releaseBob()
                return true
            })
            try {
                const { ApiMachineClient } = await import('./apiMachine')
                const client = new ApiMachineClient('token', machineClient())
                client.setRPCHandlers(rpcHandlers())

                await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

                expect(kill).toHaveBeenCalledWith(-777010, 'SIGTERM')
                expect(await isPortFree(6081)).toBe(true)
            } finally {
                kill.mockRestore()
            }
        })

        // Nothing is holding the slot, so there is nothing to reclaim — and the
        // pids on a released record may belong to anything by now.
        it('does not signal a released viewer whose port is already free', async () => {
            leaseRegistryMocks.records.set(BOB_KEY, {
                ...lease(BOB_KEY, 1),
                processIds: { websockify: 777010 },
            })
            fsMocks.readFile.mockImplementation(async (path: string) => {
                if (path === '/proc/777010/cmdline') return 'websockify\x00--web\x00/root\x00127.0.0.1:6081\x00127.0.0.1:5901\x00'
                return path.endsWith('/cmdline') ? '/usr/bin/google-chrome\x00' : 'PATH=/usr/bin\x00'
            })
            const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
            try {
                const { ApiMachineClient } = await import('./apiMachine')
                const client = new ApiMachineClient('token', machineClient())
                client.setRPCHandlers(rpcHandlers())

                await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

                expect(kill).not.toHaveBeenCalledWith(-777010, 'SIGTERM')
            } finally {
                kill.mockRestore()
            }
        })

        // The other half of the same outage: the slot was judged free because
        // nothing was serving noVNC on it, but websockify could not bind it
        // either, so every retry landed on the one port that could not work.
        it('skips a slot whose port is held by something that answers nothing', async () => {
            await holdPort(6080)
            const { ApiMachineClient } = await import('./apiMachine')
            const client = new ApiMachineClient('token', machineClient())
            client.setRPCHandlers(rpcHandlers())

            const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

            expect(result).toMatchObject({ webPort: 6081, ready: true })
        })

        // 2026-09-21, walter-gpu: a second user pushed this viewer onto slot 1,
        // websockify lost 6081 to something already holding it and exited, and
        // a bind check still called the screen ready. The studio minted a relay
        // URL onto that port and every request came back ECONNRESET.
        it('refuses to call the screen ready when websockify dies on startup', async () => {
            daemonMocks.spawnDetached.mockImplementation((...call: any[]): DetachedProcess => {
                const [command] = call as [string]
                return command === 'websockify'
                    ? { pid: 1234, exit: { kind: 'exit', code: 1, signal: null } }
                    : { pid: 1234, exit: null }
            })
            const { ApiMachineClient } = await import('./apiMachine')
            const client = new ApiMachineClient('token', machineClient())
            client.setRPCHandlers(rpcHandlers())

            const result = await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

            expect(result).toMatchObject({ ready: false })
        })

        it('runs the legacy pair and serves the scaling page when Xvnc is absent', async () => {
            viewerMocks.detectViewerCapabilities.mockResolvedValue({
                hasXvnc: false,
                hasXvfb: true,
                hasX11vnc: true,
                hasWebsockify: true,
                hasWindowManager: true,
            })
            const { ApiMachineClient } = await import('./apiMachine')
            const client = new ApiMachineClient('token', machineClient())
            client.setRPCHandlers(rpcHandlers())

            await handlersFrom(client).get('machine-1:browser-viewer:start')?.({ viewerKey: ALICE_KEY })

            const spawned = daemonMocks.spawnDetached.mock.calls.map((call: any[]) => call[0])
            expect(spawned).toContain('Xvfb')
            expect(spawned).toContain('x11vnc')
            expect(spawned).not.toContain('Xvnc')
            expect(spawned).not.toContain('vncconfig')
            // x11vnc ignores SetDesktopSize, so asking for it would leave the
            // screen clipped exactly as before.
            expect(daemonMocks.ensureViewerWebRoot).toHaveBeenCalledWith(
                expect.objectContaining({ resizeMode: 'scale' }),
            )
        }, 15_000)
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
        let releaseCapabilityProbe: (caps: any) => void = () => {}
        viewerMocks.detectViewerCapabilities.mockReturnValueOnce(new Promise((resolve) => {
            releaseCapabilityProbe = resolve
        }))
        const { ApiMachineClient } = await import('./apiMachine')
        const client = new ApiMachineClient('token', machineClient())
        client.setRPCHandlers(rpcHandlers())
        const start = handlersFrom(client).get('machine-1:browser-viewer:start')!

        const first = start({ viewerKey: ALICE_KEY })
        const second = start({ viewerKey: ALICE_KEY })
        await vi.waitFor(() => {
            expect(viewerMocks.detectViewerCapabilities).toHaveBeenCalledTimes(1)
        })
        releaseCapabilityProbe({
            hasXvnc: true,
            hasXvfb: true,
            hasX11vnc: true,
            hasWebsockify: true,
            hasWindowManager: true,
            hasVncConfig: true,
        })

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

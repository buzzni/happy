import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { BrowserRuntimeError, type AuthContext, type InteractiveCapability, type ProfileId, type TabId } from './contracts'
import { InputLeaseManager } from './inputLease'
import { ENCODING, RFB_VERSION, StreamFramer, clientParser, keyEvent, pointerEvent, setEncodingsMessage, vncAuthResponse, type ClientMessage, type RfbParser } from './rfb'
import { startRuntimeServer, type RuntimeServer } from './server'
import { PIXEL_FORMAT_32, prng, randomSplit, serverStream, u16, u32 } from './testing/rfbFixtures'
import { RawRfbViewer } from './testing/rfbViewerClient'
import { ViewerProxy } from './viewerProxy'

const PROFILE = 'profile-a' as ProfileId
const NOW = 1_000_000

function capability(overrides: Partial<InteractiveCapability> = {}): InteractiveCapability {
    return {
        kind: 'interactive', capabilityId: 'cap-1', principalId: 'p1' as never, workspaceId: 'w1' as never, machineId: 'm1' as never,
        viewerSessionId: 'viewer-1', profileId: PROFILE, operations: ['viewerTicket', 'takeOver', 'releaseControl'],
        issuedAtMs: NOW - 1_000, expiresAtMs: NOW + 240_000, ...overrides,
    }
}
const auth = (credential: AuthContext['credential']): AuthContext => ({ credential, verifiedAtMs: NOW })

function proxy(options: { now?: () => number; revoked?: Set<string> } = {}) {
    const revoked = options.revoked ?? new Set<string>()
    const now = options.now ?? (() => NOW)
    return new ViewerProxy({
        now,
        isCapabilityLive: (cap) => cap.expiresAtMs > now() && !revoked.has(cap.capabilityId),
        endpoint: (profileId) => profileId === PROFILE ? { host: '127.0.0.1', port: 1 } : undefined,
        vncPassword: 'synthpw1',
        allowedOrigins: [],
        leases: { userControl: () => ({ tabs: [], settling: false }), subscribe: () => () => undefined },
    })
}

describe('viewer tickets', () => {
    it('issues a one-time ticket that expires after 30 seconds or with the capability, whichever is first', () => {
        const viewer = proxy()
        const ticket = viewer.issueTicket(auth(capability()), { profileId: PROFILE })
        expect(ticket.expiresAtMs).toBe(NOW + 30_000)
        expect(ticket.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(viewer.consumeTicket(ticket.ticket)).toMatchObject({ profileId: PROFILE, capability: { capabilityId: 'cap-1' } })
        expect(viewer.consumeTicket(ticket.ticket)).toBeUndefined()
        const short = viewer.issueTicket(auth(capability({ expiresAtMs: NOW + 5_000 })), { profileId: PROFILE })
        expect(short.expiresAtMs).toBe(NOW + 5_000)
    })

    it('refuses an expired ticket and one whose capability was revoked after issue', () => {
        let now = NOW
        const revoked = new Set<string>()
        const viewer = proxy({ now: () => now, revoked })
        const late = viewer.issueTicket(auth(capability()), { profileId: PROFILE })
        now += 30_000
        expect(viewer.consumeTicket(late.ticket)).toBeUndefined()
        const revokedTicket = viewer.issueTicket(auth(capability({ capabilityId: 'cap-2' })), { profileId: PROFILE })
        revoked.add('cap-2')
        expect(viewer.consumeTicket(revokedTicket.ticket)).toBeUndefined()
    })

    it('requires an interactive capability with viewerTicket for exactly this profile', () => {
        const viewer = proxy()
        const denied = (a: AuthContext, profileId = PROFILE) => expect(() => viewer.issueTicket(a, { profileId })).toThrowError(BrowserRuntimeError)
        denied(auth(capability({ operations: ['takeOver'] })))
        denied(auth(capability()), 'profile-b' as ProfileId)
        denied(auth({ kind: 'agent-grant', grantId: 'g', principalId: 'p1', workspaceId: 'w1', machineId: 'm1', agentSessionId: 'a',
            profileId: PROFILE, allowedOrigins: [], operations: ['viewerTicket'], taskSpaceIds: [], issuedAtMs: NOW - 1, expiresAtMs: NOW + 1_000 } as never))
        denied(auth(capability({ expiresAtMs: NOW })))
    })

    it('reports RUNTIME_UNAVAILABLE for a profile without a viewer endpoint', () => {
        const viewer = proxy()
        const other = 'profile-b' as ProfileId
        expect(() => viewer.issueTicket(auth(capability({ profileId: other })), { profileId: other }))
            .toThrowError(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
    })
})

// ---------------------------------------------------------------------------
// Connection tests: a real HTTP server, a real WebSocket viewer and a fake x11vnc.
// ---------------------------------------------------------------------------

const PASSWORD = 'synthpw1'
const TAB = 'tab-1' as TabId
const OWNER = { kind: 'user' as const, principalId: 'p1' as never, viewerSessionId: 'viewer-1' }
const OTHER_VIEWER = { ...OWNER, viewerSessionId: 'viewer-2' }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await sleep(10)
    }
}

/** x11vnc stand-in: VNC authentication with the per-run password, then it records everything the proxy sends. */
class FakeX11vnc {
    readonly sockets: Socket[] = []
    readonly sharedFlags: number[] = []
    authFailures = 0
    private readonly raw: Buffer[] = []
    private constructor(private readonly server: Server, readonly port: number) {}

    static async start(): Promise<FakeX11vnc> {
        let fake!: FakeX11vnc
        const server = createServer((socket) => fake.accept(socket))
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        fake = new FakeX11vnc(server, (server.address() as { port: number }).port)
        return fake
    }

    private accept(socket: Socket): void {
        this.sockets.push(socket)
        socket.on('error', () => undefined)
        const self = this
        function* serve(): RfbParser {
            socket.write(RFB_VERSION)
            if (((yield { read: 12, forward: false }) as Buffer).toString('latin1') !== RFB_VERSION) return void socket.destroy()
            socket.write(Buffer.from([1, 2]))
            if (((yield { read: 1, forward: false }) as Buffer)[0] !== 2) return void socket.destroy()
            const challenge = randomBytes(16)
            socket.write(challenge)
            if (!((yield { read: 16, forward: false }) as Buffer).equals(vncAuthResponse(PASSWORD, challenge))) {
                self.authFailures += 1
                socket.end(u32(1))
                return
            }
            socket.write(u32(0))
            self.sharedFlags.push(((yield { read: 1, forward: false }) as Buffer)[0])
            const name = Buffer.from('fake-browser:99')
            socket.write(Buffer.concat([u16(64), u16(48), PIXEL_FORMAT_32, u32(name.length), name]))
            yield { skip: Number.MAX_SAFE_INTEGER }
        }
        const framer = new StreamFramer(serve(), (bytes) => this.raw.push(Buffer.from(bytes)), 1 << 20)
        socket.on('data', (chunk) => framer.push(chunk))
    }

    /** Everything received after ClientInit, parsed as viewer messages. */
    messages(): ClientMessage[] {
        const messages: ClientMessage[] = []
        const parser = new StreamFramer(clientParser({ send: () => undefined, serverInit: Buffer.alloc(0), onReady: () => undefined, onMessage: (m) => messages.push(m) }), () => undefined, 1 << 30)
        parser.push(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 0]), ...this.raw]))
        return messages
    }
    inputs(): ClientMessage[] { return this.messages().filter((m) => m.kind === 'key' || m.kind === 'pointer' || m.kind === 'cutText') }
    sendToViewer(bytes: Buffer): void { for (const socket of this.sockets) socket.write(bytes) }
    async close(): Promise<void> {
        for (const socket of this.sockets) socket.destroy()
        await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }
}

const fbur = (marker: number) => Buffer.concat([Buffer.from([3, 1]), u16(marker), u16(0), u16(1), u16(1)])
const cutText = (text: string) => Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(text.length), Buffer.from(text)])
const markerSeen = (x11vnc: FakeX11vnc, marker: number) => () => x11vnc.messages().some((m) => m.kind === 'framebufferUpdateRequest' && m.bytes.readUInt16BE(2) === marker)

let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    cleanups = []
})

async function viewerStack(options: { allowedOrigins?: string[] } = {}) {
    const x11vnc = await FakeX11vnc.start()
    const leases = new InputLeaseManager()
    const revoked = new Set<string>()
    const proxy = new ViewerProxy({
        leases,
        endpoint: (profileId) => profileId === PROFILE ? { host: '127.0.0.1', port: x11vnc.port } : undefined,
        vncPassword: PASSWORD,
        isCapabilityLive: (cap) => cap.expiresAtMs > Date.now() && !revoked.has(cap.capabilityId),
        allowedOrigins: options.allowedOrigins ?? ['https://tunnel.example'],
    })
    const server: RuntimeServer = await startRuntimeServer({ api: {} as never, verifyToken: () => { throw new BrowserRuntimeError('UNAUTHORIZED', 'x') },
        port: 0, health: () => ({}), viewer: proxy })
    cleanups.push(() => x11vnc.close(), () => server.close())
    const origin = `http://127.0.0.1:${server.port}`
    const ticket = (overrides: Partial<InteractiveCapability> = {}) =>
        proxy.issueTicket(auth(capability({ issuedAtMs: Date.now() - 1_000, expiresAtMs: Date.now() + 240_000, ...overrides })), { profileId: PROFILE }).ticket
    const url = (value: string) => `ws://127.0.0.1:${server.port}/v1/viewer/websockify?ticket=${value}`
    const connect = async (overrides: Partial<InteractiveCapability> = {}) => {
        const viewer = await RawRfbViewer.open(url(ticket(overrides)), origin)
        cleanups.push(() => viewer.ws.terminate())
        return viewer
    }
    return { x11vnc, leases, revoked, proxy, server, origin, ticket, url, connect }
}

describe('viewer proxy connection', () => {
    it('runs both RFB handshakes independently: None to the viewer, VNC authentication and a shared session upstream', async () => {
        const { x11vnc, connect } = await viewerStack()
        const viewer = await connect()
        expect(await viewer.handshake()).toEqual({ width: 64, height: 48, name: 'Agent Browser' })
        expect(x11vnc.authFailures).toBe(0)
        expect(x11vnc.sharedFlags).toEqual([1])
    })

    it('drops key, pointer and cut text input while the viewer holds no takeover lease', async () => {
        const { x11vnc, connect } = await viewerStack()
        const viewer = await connect()
        await viewer.handshake()
        viewer.send(Buffer.concat([keyEvent(true, 0x61), keyEvent(false, 0x61), pointerEvent(1, 3, 4), pointerEvent(0, 3, 4), cutText('secret'), fbur(101)]))
        await waitFor(markerSeen(x11vnc, 101), 'marker')
        expect(x11vnc.inputs()).toEqual([])
    })

    it('forwards input only while this viewer owns the takeover and settling has finished', async () => {
        const { x11vnc, leases, connect } = await viewerStack()
        const viewer = await connect()
        await viewer.handshake()
        leases.acquire(TAB, PROFILE, { kind: 'agent', agentSessionId: 'a' as never, taskId: 'task-1' as never, segmentId: 'batch-1' as never })
        leases.fenceForTakeover(TAB, PROFILE, 'task-1' as never, OWNER)
        viewer.send(Buffer.concat([keyEvent(true, 0x62), keyEvent(false, 0x62), fbur(1)]))
        await waitFor(markerSeen(x11vnc, 1), 'settling marker')
        expect(x11vnc.inputs()).toEqual([])

        leases.completePendingTakeovers('task-1' as never)
        viewer.send(Buffer.concat([keyEvent(true, 0x63), keyEvent(false, 0x63), pointerEvent(0, 7, 8), cutText('ok'), fbur(2)]))
        await waitFor(markerSeen(x11vnc, 2), 'owner marker')
        expect(x11vnc.inputs().map((m) => m.kind)).toEqual(['key', 'key', 'pointer', 'cutText'])

        leases.release(TAB, PROFILE)
        leases.takeOver(TAB, PROFILE, OTHER_VIEWER)
        viewer.send(Buffer.concat([keyEvent(true, 0x64), keyEvent(false, 0x64), fbur(3)]))
        await waitFor(markerSeen(x11vnc, 3), 'other-owner marker')
        expect(x11vnc.inputs()).toHaveLength(4)
    })

    it('drops input right after release and releases held keys and buttons upstream on control loss', async () => {
        const { x11vnc, leases, connect } = await viewerStack()
        const viewer = await connect()
        await viewer.handshake()
        leases.takeOver(TAB, PROFILE, OWNER)
        viewer.send(Buffer.concat([keyEvent(true, 0xffe1 /* Shift_L */), keyEvent(true, 0x61), pointerEvent(1, 5, 6), fbur(10)]))
        await waitFor(markerSeen(x11vnc, 10), 'held marker')
        leases.release(TAB, PROFILE)
        await waitFor(() => x11vnc.inputs().length === 6, 'releases after control loss')
        expect(x11vnc.inputs().slice(3)).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'key', down: false, keysym: 0xffe1 }),
            expect.objectContaining({ kind: 'key', down: false, keysym: 0x61 }),
            expect.objectContaining({ kind: 'pointer', buttonMask: 0, x: 5, y: 6 }),
        ]))
        viewer.send(Buffer.concat([keyEvent(true, 0x62), pointerEvent(1, 1, 1), cutText('late'), fbur(11)]))
        await waitFor(markerSeen(x11vnc, 11), 'after-release marker')
        expect(x11vnc.inputs()).toHaveLength(6)
    })

    it('treats a new lease epoch as control loss even when the same viewer takes over again', async () => {
        const { x11vnc, leases, connect } = await viewerStack()
        const viewer = await connect()
        await viewer.handshake()
        leases.takeOver(TAB, PROFILE, OWNER)
        viewer.send(Buffer.concat([keyEvent(true, 0x61), fbur(20)]))
        await waitFor(markerSeen(x11vnc, 20), 'held marker')
        leases.release(TAB, PROFILE)
        leases.takeOver(TAB, PROFILE, OWNER)
        viewer.send(Buffer.concat([keyEvent(true, 0x62), fbur(21)]))
        await waitFor(markerSeen(x11vnc, 21), 'retake marker')
        expect(x11vnc.inputs().map((m) => m.kind === 'key' && [m.down, m.keysym])).toEqual([[true, 0x61], [false, 0x61], [true, 0x62]])
    })

    it('releases held keys when the viewer disconnects', async () => {
        const { x11vnc, leases, connect } = await viewerStack()
        const viewer = await connect()
        await viewer.handshake()
        leases.takeOver(TAB, PROFILE, OWNER)
        viewer.send(Buffer.concat([keyEvent(true, 0x61), fbur(30)]))
        await waitFor(markerSeen(x11vnc, 30), 'held marker')
        viewer.ws.close()
        await waitFor(() => x11vnc.inputs().length === 2, 'key-up after disconnect')
        expect(x11vnc.inputs()[1]).toMatchObject({ kind: 'key', down: false, keysym: 0x61 })
    })

    it('closes the connection when the capability expires, after releasing what the viewer holds', async () => {
        const { x11vnc, leases, connect } = await viewerStack()
        const viewer = await connect({ expiresAtMs: Date.now() + 1_500 })
        await viewer.handshake()
        leases.takeOver(TAB, PROFILE, OWNER)
        viewer.send(Buffer.concat([keyEvent(true, 0x61), fbur(40)]))
        await waitFor(markerSeen(x11vnc, 40), 'held marker')
        expect(await viewer.closed).toMatchObject({ code: 4001 })
        await waitFor(() => x11vnc.inputs().length === 2, 'key-up at expiry')
        expect(x11vnc.inputs()[1]).toMatchObject({ kind: 'key', down: false })
    })

    it('closes the connection soon after the capability is revoked', async () => {
        const { revoked, connect } = await viewerStack()
        const viewer = await connect({ capabilityId: 'cap-revoked' })
        await viewer.handshake()
        revoked.add('cap-revoked')
        expect(await viewer.closed).toMatchObject({ code: 4001 })
    })

    it('rejects a missing or foreign Origin, and a self origin on a non-loopback Host', async () => {
        const { origin, ticket, url, connect } = await viewerStack()
        await expect(RawRfbViewer.open(url(ticket()))).rejects.toThrow('HTTP 403')
        await expect(RawRfbViewer.open(url(ticket()), 'https://evil.example')).rejects.toThrow('HTTP 403')
        await expect(RawRfbViewer.open(url(ticket()), origin.replace('127.0.0.1', 'localhost'))).rejects.toThrow('HTTP 403')
        const rebound = await new Promise<number>((resolve) => {
            const ws = new WebSocket(url(ticket()), { headers: { origin: 'http://rebind.example:1234', host: 'rebind.example:1234' } })
            ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
            ws.once('open', () => resolve(101))
        })
        expect(rebound).toBe(403)
        const tunnel = await RawRfbViewer.open(url(ticket()), 'https://tunnel.example')
        tunnel.ws.terminate()
        expect((await connect()).ws.readyState).toBe(WebSocket.OPEN)
    })

    it('accepts a ticket once: reuse, an unknown ticket and none at all are refused', async () => {
        const { origin, ticket, url } = await viewerStack()
        const once = ticket()
        const first = await RawRfbViewer.open(url(once), origin)
        first.ws.terminate()
        await expect(RawRfbViewer.open(url(once), origin)).rejects.toThrow('HTTP 401')
        await expect(RawRfbViewer.open(url('not-a-ticket'), origin)).rejects.toThrow('HTTP 401')
        await expect(RawRfbViewer.open(url('').replace('?ticket=', ''), origin)).rejects.toThrow('HTTP 401')
    })

    it('forwards only framable encodings upstream', async () => {
        const { x11vnc, connect } = await viewerStack()
        const viewer = await connect()
        await viewer.handshake()
        viewer.send(Buffer.concat([setEncodingsMessage([7, ENCODING.hextile, -258, ENCODING.desktopSize, 0xc0a1e5ce | 0, ENCODING.raw, -313]), fbur(50)]))
        await waitFor(markerSeen(x11vnc, 50), 'marker')
        expect(x11vnc.messages().find((m) => m.kind === 'setEncodings')).toMatchObject({ encodings: [ENCODING.hextile, ENCODING.desktopSize, ENCODING.raw] })
    })

    it.each([
        ['an unknown message type', Buffer.from([255, 0, 0, 0])],
        ['more than 64 encodings', Buffer.concat([Buffer.from([2, 0]), u16(65)])],
        ['cut text over 64 KiB', Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(64 * 1024 + 1)])],
    ])('closes the connection on %s', async (_name, bytes) => {
        const { connect } = await viewerStack()
        const viewer = await connect()
        await viewer.handshake()
        viewer.send(bytes)
        expect(await viewer.closed).toMatchObject({ code: 1008 })
    })

    it('closes the viewer when the upstream uses an encoding the viewer never requested', async () => {
        const { x11vnc, connect } = await viewerStack()
        const viewer = await connect()
        await viewer.handshake()
        x11vnc.sendToViewer(Buffer.concat([Buffer.from([0, 0]), u16(1), u16(0), u16(0), u16(1), u16(1), u32(7)]))
        expect(await viewer.closed).toMatchObject({ code: 1011 })
    })

    it('stays framed under random WebSocket fragmentation and coalescing in both directions', async () => {
        for (let seed = 1; seed <= 15; seed++) {
            const random = prng(seed)
            const { x11vnc, leases, connect } = await viewerStack()
            const viewer = await connect()
            leases.takeOver(TAB, PROFILE, OWNER)
            // The viewer's whole byte stream, handshake included, cut at random points and sent as
            // single frames, coalesced frames, or WebSocket continuation fragments.
            const clientStream = Buffer.concat([
                Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1]), Buffer.from([1]),
                Buffer.from([0, 0, 0, 0]), PIXEL_FORMAT_32,
                setEncodingsMessage([ENCODING.hextile, ENCODING.zrle, ENCODING.copyRect, ENCODING.cursor, ENCODING.desktopSize, 7]),
                keyEvent(true, 0x61), keyEvent(false, 0x61), pointerEvent(2, 9, 9), pointerEvent(0, 9, 9), cutText('fragmented'),
                fbur(60 + seed),
            ])
            const pieces = randomSplit(clientStream, random)
            for (const [index, piece] of pieces.entries()) viewer.send(piece, { fin: index === pieces.length - 1 || random() < 0.6 })
            await waitFor(markerSeen(x11vnc, 60 + seed), `seed ${seed} marker`)
            expect(x11vnc.messages().map((m) => m.kind), `seed ${seed}`).toEqual(['setPixelFormat', 'setEncodings', 'key', 'key', 'pointer', 'pointer', 'cutText', 'framebufferUpdateRequest'])

            const stream = serverStream()
            const prefixLength = 12 + 2 + 4 + 24 + 'Agent Browser'.length
            for (const piece of randomSplit(stream, random)) {
                x11vnc.sendToViewer(piece)
                if (random() < 0.2) await sleep(1)
            }
            await waitFor(() => viewer.received().length >= prefixLength + stream.length, `seed ${seed} server stream`)
            expect(viewer.received().subarray(prefixLength).equals(stream), `seed ${seed}`).toBe(true)
            for (const cleanup of cleanups.reverse()) await cleanup()
            cleanups = []
        }
    })
})

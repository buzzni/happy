import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createConnection, KEEPALIVE_INTERVAL_MS } from './connection.js'

/** Fake WebSocket capturing what the connection sends and letting tests fire events. */
class FakeWebSocket {
    static OPEN = 1
    static CLOSED = 3
    static instances = []

    constructor(url) {
        this.url = url
        this.readyState = 0
        this.sent = []
        this.listeners = {}
        this.closed = false
        FakeWebSocket.instances.push(this)
    }

    addEventListener(event, handler) {
        ;(this.listeners[event] ||= []).push(handler)
    }

    send(data) {
        this.sent.push(data)
    }

    close(code) {
        this.closed = true
        this.readyState = FakeWebSocket.CLOSED
        this.fire('close', { code })
    }

    fire(event, payload) {
        for (const handler of this.listeners[event] ?? []) handler(payload)
    }

    open() {
        this.readyState = FakeWebSocket.OPEN
        this.fire('open')
    }
}

function fakeChrome(stored = { token: 'tok', port: 41777, profile: 'default' }, badges) {
    return {
        storage: { local: { get: async () => stored } },
        tabs: { query: async () => [] },
        action: {
            setBadgeText: ({ text }) => { badges?.push(text) },
            setBadgeBackgroundColor: () => {},
        },
    }
}

describe('createConnection', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeWebSocket.instances = []
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    const make = (chrome = fakeChrome()) =>
        createConnection({ chrome, WebSocketImpl: FakeWebSocket })

    it('opens one socket with the configured token, port and profile', async () => {
        const connection = make()
        await connection.connect()
        expect(FakeWebSocket.instances).toHaveLength(1)
        expect(FakeWebSocket.instances[0].url).toBe('ws://127.0.0.1:41777/?token=tok&profile=default')
    })

    it('identifies an automated pairing without replacing the user profile', async () => {
        const connection = make(fakeChrome({
            token: 'tok', port: 41777, profile: 'work', pairingId: 'viewer-9222',
        }))
        await connection.connect()
        expect(FakeWebSocket.instances[0].url).toBe(
            'ws://127.0.0.1:41777/?token=tok&profile=work&pairingId=viewer-9222',
        )
    })

    // The daemon is not always on this machine — a user pointing their own,
    // already-logged-in Chrome at a remote happy session needs the extension
    // to dial out somewhere other than its own loopback.
    it('dials a configured remote host instead of loopback', async () => {
        const connection = make(fakeChrome({ token: 'tok', port: 41777, profile: 'default', host: 'happy.example.com' }))
        await connection.connect()
        expect(FakeWebSocket.instances[0].url).toBe('ws://happy.example.com:41777/?token=tok&profile=default')
    })

    it('brackets an IPv6 literal so the URL stays well-formed', async () => {
        const connection = make(fakeChrome({ token: 'tok', port: 41777, profile: 'default', host: '::1' }))
        await connection.connect()
        expect(FakeWebSocket.instances[0].url).toBe('ws://[::1]:41777/?token=tok&profile=default')
    })

    it('does not double-bracket a host the user already bracketed', async () => {
        const connection = make(fakeChrome({ token: 'tok', port: 41777, profile: 'default', host: '[::1]' }))
        await connection.connect()
        expect(FakeWebSocket.instances[0].url).toBe('ws://[::1]:41777/?token=tok&profile=default')
    })

    // host became free-form user input with the remote-daemon feature. A typo
    // ("http://1.2.3.4") makes the WebSocket constructor throw, which used to
    // escape connect() as an unhandled rejection: no badge, no reconnect, and
    // a service worker that looks alive but will never connect.
    it('shows the error badge instead of dying when the configured host makes an invalid URL', async () => {
        const badges = []
        const chrome = fakeChrome({ token: 'tok', port: 41777, profile: 'default', host: 'http://1.2.3.4' }, badges)
        function ThrowingWebSocket() { throw new SyntaxError("The URL 'ws://http://1.2.3.4:41777/' is invalid.") }
        ThrowingWebSocket.OPEN = 1
        const connection = createConnection({ chrome, WebSocketImpl: ThrowingWebSocket })

        await expect(connection.connect()).resolves.toBeUndefined()
        expect(badges).toContain('!')
    })

    it('can still connect after a bad host is corrected', async () => {
        const stored = { token: 'tok', port: 41777, profile: 'default', host: 'http://1.2.3.4' }
        const chrome = fakeChrome(stored)
        let failNext = true
        function MaybeThrowingWebSocket(url) {
            if (failNext) throw new SyntaxError('invalid')
            return new FakeWebSocket(url)
        }
        MaybeThrowingWebSocket.OPEN = 1
        const connection = createConnection({ chrome, WebSocketImpl: MaybeThrowingWebSocket })

        await connection.connect()
        failNext = false
        stored.host = '127.0.0.1'
        connection.restart()
        await vi.advanceTimersByTimeAsync(0)
        expect(FakeWebSocket.instances).toHaveLength(1)
    })

    it('does not connect before a pairing token is saved', async () => {
        const connection = make(fakeChrome({ token: '', port: 41777, profile: 'default' }))
        await connection.connect()
        expect(FakeWebSocket.instances).toHaveLength(0)
    })

    // Regression: the `if (socket) return` guard sits before `await readConfig()`,
    // so two overlapping calls both got past it and opened a second socket. Real
    // Chrome hit this — the daemon logged two connections for one profile.
    it('opens only one socket when connect() is called twice before the first resolves', async () => {
        const connection = make()
        await Promise.all([connection.connect(), connection.connect()])
        expect(FakeWebSocket.instances).toHaveLength(1)
    })

    it('opens only one socket when a settings change races the initial connect', async () => {
        const connection = make()
        const initial = connection.connect()
        connection.restart()
        await initial
        await vi.advanceTimersByTimeAsync(0)
        const live = FakeWebSocket.instances.filter((ws) => !ws.closed)
        expect(live).toHaveLength(1)
    })

    it('uses the latest settings when restart is requested during an in-flight config read', async () => {
        let resolveFirstRead
        let reads = 0
        const chrome = fakeChrome()
        chrome.storage.local.get = vi.fn(() => {
            reads += 1
            if (reads === 1) {
                return new Promise((resolve) => { resolveFirstRead = resolve })
            }
            return Promise.resolve({ token: 'new-token', port: 41778, profile: 'new-profile' })
        })
        const connection = make(chrome)

        const initial = connection.connect()
        connection.restart()
        resolveFirstRead({ token: 'old-token', port: 41777, profile: 'old-profile' })
        await initial

        expect(FakeWebSocket.instances).toHaveLength(1)
        expect(FakeWebSocket.instances[0].url).toBe(
            'ws://127.0.0.1:41778/?token=new-token&profile=new-profile',
        )
    })

    it('sends a keepalive ping once the socket is open', async () => {
        const connection = make()
        await connection.connect()
        FakeWebSocket.instances[0].open()
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS)
        expect(FakeWebSocket.instances[0].sent).toEqual([JSON.stringify({ type: 'ping' })])
    })

    // Regression: keepalive was a single shared timer, so a stale socket's close
    // event cleared the live socket's timer. The service worker then went idle
    // and Chrome terminated it.
    it('keeps the live socket pinging when a stale socket closes', async () => {
        const connection = make()
        await connection.connect()
        const stale = FakeWebSocket.instances[0]
        stale.open()

        connection.restart()
        await vi.advanceTimersByTimeAsync(0)
        const live = FakeWebSocket.instances[1]
        live.open()
        live.sent.length = 0

        // The stale socket's close arrives late, after the new one is running.
        stale.fire('close')

        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS)
        expect(live.sent).toEqual([JSON.stringify({ type: 'ping' })])
    })

    it('does not schedule a reconnect when a stale socket closes', async () => {
        const connection = make()
        await connection.connect()
        const stale = FakeWebSocket.instances[0]
        stale.open()

        connection.restart()
        await vi.advanceTimersByTimeAsync(0)
        expect(FakeWebSocket.instances).toHaveLength(2)

        stale.fire('close')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(FakeWebSocket.instances).toHaveLength(2)
    })

    it('reconnects with backoff after the live socket closes', async () => {
        const connection = make()
        await connection.connect()
        FakeWebSocket.instances[0].open()
        FakeWebSocket.instances[0].close()

        await vi.advanceTimersByTimeAsync(999)
        expect(FakeWebSocket.instances).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(FakeWebSocket.instances).toHaveLength(2)
    })

    it('answers a command from the daemon and ignores its pong', async () => {
        const connection = make()
        await connection.connect()
        const ws = FakeWebSocket.instances[0]
        ws.open()

        ws.fire('message', { data: JSON.stringify({ type: 'pong' }) })
        await vi.advanceTimersByTimeAsync(0)
        expect(ws.sent).toEqual([])

        ws.fire('message', { data: JSON.stringify({ id: 1, method: 'ping' }) })
        await vi.advanceTimersByTimeAsync(0)
        expect(ws.sent).toEqual([JSON.stringify({ id: 1, result: 'pong' })])
    })

    describe('badge', () => {
        // The badge is the user's only in-browser signal that something is
        // driving their tabs, so it has to distinguish "connected and idle"
        // from "a command is running right now".
        it('marks the badge while a command runs and restores it afterwards', async () => {
            const badges = []
            const connection = make(fakeChrome(undefined, badges))
            await connection.connect()
            const ws = FakeWebSocket.instances[0]
            ws.open()
            badges.length = 0

            ws.fire('message', { data: JSON.stringify({ id: 1, method: 'ping' }) })
            await vi.advanceTimersByTimeAsync(0)

            expect(badges[0]).toBe('▶')
            expect(badges[badges.length - 1]).toBe('●')
        })

        it('restores the idle badge even when the command fails', async () => {
            const badges = []
            const connection = make(fakeChrome(undefined, badges))
            await connection.connect()
            const ws = FakeWebSocket.instances[0]
            ws.open()
            badges.length = 0

            ws.fire('message', { data: JSON.stringify({ id: 2, method: 'no_such_method' }) })
            await vi.advanceTimersByTimeAsync(0)

            expect(badges[badges.length - 1]).toBe('●')
        })

        it('shows a distinct badge when the daemon rejects the stored token', async () => {
            // A stale token (daemon's token file rotated after pairing) closes
            // with 4401 and the extension retries forever with the same stale
            // token — without a distinct badge that looks identical to a normal
            // transient disconnect, which is what made this silent to debug.
            const badges = []
            const connection = make(fakeChrome(undefined, badges))
            await connection.connect()
            const ws = FakeWebSocket.instances[0]
            ws.open()
            badges.length = 0

            ws.close(4401)

            expect(badges[badges.length - 1]).toBe('!')
        })

        it('does not mark the badge for keepalive pongs', async () => {
            const badges = []
            const connection = make(fakeChrome(undefined, badges))
            await connection.connect()
            const ws = FakeWebSocket.instances[0]
            ws.open()
            badges.length = 0

            ws.fire('message', { data: JSON.stringify({ type: 'pong' }) })
            await vi.advanceTimersByTimeAsync(0)

            expect(badges).toEqual([])
        })
    })
})

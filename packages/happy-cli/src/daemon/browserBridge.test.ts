import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { BrowserBridge, BridgeRequestError } from './browserBridge'

/**
 * Fake of the `ws` WebSocket surface the bridge uses. Mirrors the
 * PreviewWsProxy testing approach: the bridge stays pure of the socket
 * library, so an EventEmitter with send/close is a full stand-in.
 */
class FakeSocket extends EventEmitter {
    sent: string[] = []
    closed: { code?: number; reason?: string } | null = null

    send(data: string): void {
        this.sent.push(data)
    }

    close(code?: number, reason?: string): void {
        this.closed = { code, reason }
        this.emit('close')
    }

    /** Simulate a message arriving from the extension. */
    receive(payload: unknown): void {
        this.emit('message', Buffer.from(JSON.stringify(payload)))
    }

    lastSent(): any {
        return JSON.parse(this.sent[this.sent.length - 1])
    }
}

const TOKEN = 'secret-token'

describe('BrowserBridge', () => {
    let bridge: BrowserBridge

    beforeEach(() => {
        vi.useFakeTimers()
        bridge = new BrowserBridge({ authToken: TOKEN })
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    const connect = (profile = 'default') => {
        const socket = new FakeSocket()
        const accepted = bridge.handleConnection(socket, { token: TOKEN, profile })
        expect(accepted).toBe(true)
        return socket
    }

    describe('authentication', () => {
        it('rejects a connection with a wrong token and does not register it', () => {
            const socket = new FakeSocket()
            const accepted = bridge.handleConnection(socket, { token: 'wrong', profile: 'default' })
            expect(accepted).toBe(false)
            expect(socket.closed?.code).toBe(4401)
            expect(bridge.connections()).toEqual([])
        })

        it('rejects a connection with a missing token', () => {
            const socket = new FakeSocket()
            const accepted = bridge.handleConnection(socket, {})
            expect(accepted).toBe(false)
            expect(socket.closed?.code).toBe(4401)
        })

        it('accepts a connection with the right token and registers its profile', () => {
            connect('work')
            expect(bridge.connections()).toEqual([{ profile: 'work' }])
        })
    })

    describe('hasRecentAuthFailure', () => {
        // Ground truth for this: an already-paired extension kept a token that
        // predates the daemon's token file being regenerated. It retried
        // forever, rejected every time, and nothing surfaced that to the user
        // — connections() only reports successes, so `/browser/status` looked
        // identical to "nothing has ever tried to connect".
        it('is false when nothing has failed to authenticate', () => {
            expect(bridge.hasRecentAuthFailure()).toBe(false)
        })

        it('is true right after a rejected token', () => {
            bridge.handleConnection(new FakeSocket(), { token: 'wrong', profile: 'default' })
            expect(bridge.hasRecentAuthFailure()).toBe(true)
        })

        it('stays false once a connection with that profile succeeds', () => {
            bridge.handleConnection(new FakeSocket(), { token: 'wrong', profile: 'default' })
            connect('default')
            expect(bridge.hasRecentAuthFailure()).toBe(false)
        })

        it('expires after the recent-failure window passes', () => {
            bridge.handleConnection(new FakeSocket(), { token: 'wrong', profile: 'default' })
            vi.advanceTimersByTime(60_001)
            expect(bridge.hasRecentAuthFailure()).toBe(false)
        })
    })

    describe('request/response correlation', () => {
        it('resolves a request with the result matching its id', async () => {
            const socket = connect()
            const promise = bridge.request('tabs_list', {})
            const sent = socket.lastSent()
            expect(sent.method).toBe('tabs_list')
            socket.receive({ id: sent.id, result: { tabs: [{ id: 1, url: 'https://a.com' }] } })
            await expect(promise).resolves.toEqual({ tabs: [{ id: 1, url: 'https://a.com' }] })
        })

        it('correlates out-of-order responses for concurrent requests', async () => {
            const socket = connect()
            const first = bridge.request('tabs_list', {})
            const second = bridge.request('ping', {})
            const [firstMsg, secondMsg] = socket.sent.map(s => JSON.parse(s))
            socket.receive({ id: secondMsg.id, result: 'pong' })
            socket.receive({ id: firstMsg.id, result: 'tabs' })
            await expect(second).resolves.toBe('pong')
            await expect(first).resolves.toBe('tabs')
        })

        it('rejects with the extension-reported error', async () => {
            const socket = connect()
            const promise = bridge.request('tabs_list', {})
            const sent = socket.lastSent()
            socket.receive({ id: sent.id, error: { code: 'TAB_NOT_FOUND', message: 'no such tab' } })
            await expect(promise).rejects.toMatchObject({ code: 'TAB_NOT_FOUND', message: 'no such tab' })
        })

        it('ignores malformed and unknown-id messages without crashing', async () => {
            const socket = connect()
            const promise = bridge.request('tabs_list', {})
            socket.emit('message', Buffer.from('not json'))
            socket.receive({ id: 99999, result: 'stale' })
            const sent = socket.lastSent()
            socket.receive({ id: sent.id, result: 'ok' })
            await expect(promise).resolves.toBe('ok')
        })
    })

    describe('failure modes', () => {
        it('rejects immediately when no extension is connected', async () => {
            await expect(bridge.request('tabs_list', {})).rejects.toMatchObject({ code: 'NO_EXTENSION_CONNECTED' })
        })

        it('rejects with TIMEOUT when the extension never responds', async () => {
            connect()
            const promise = bridge.request('tabs_list', {}, { timeoutMs: 5000 })
            const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' })
            await vi.advanceTimersByTimeAsync(5001)
            await assertion
        })

        it('rejects pending requests when the extension disconnects', async () => {
            const socket = connect()
            const promise = bridge.request('tabs_list', {})
            const assertion = expect(promise).rejects.toMatchObject({ code: 'EXTENSION_DISCONNECTED' })
            socket.close()
            await assertion
            expect(bridge.connections()).toEqual([])
        })

        it('errors are BridgeRequestError instances', async () => {
            await expect(bridge.request('x', {})).rejects.toBeInstanceOf(BridgeRequestError)
        })
    })

    describe('keepalive', () => {
        it('replies pong to an extension ping', () => {
            const socket = connect()
            socket.receive({ type: 'ping' })
            expect(socket.lastSent()).toEqual({ type: 'pong' })
        })
    })

    describe('multiple profiles', () => {
        it('routes a request to the matching profile', async () => {
            const work = connect('work')
            const home = connect('home')
            const promise = bridge.request('tabs_list', {}, { profile: 'home' })
            expect(work.sent).toHaveLength(0)
            const sent = home.lastSent()
            home.receive({ id: sent.id, result: 'home-tabs' })
            await expect(promise).resolves.toBe('home-tabs')
        })

        it('rejects when the requested profile is not connected', async () => {
            connect('work')
            await expect(bridge.request('tabs_list', {}, { profile: 'home' }))
                .rejects.toMatchObject({ code: 'NO_EXTENSION_CONNECTED' })
        })

        it('refuses to pick for the caller when more than one profile is connected', async () => {
            // Ground truth for why this is an error and not a default: a Chrome
            // profile with no open windows answered `capabilities` fine but
            // returned zero tabs, and the arbitrary first-inserted pick meant
            // the profile the user was actually looking at could never win.
            connect('work')
            connect('home')
            await expect(bridge.request('tabs_list', {})).rejects.toMatchObject({ code: 'AMBIGUOUS_PROFILE' })
        })

        it('names the connected profiles so the caller can retry with one', async () => {
            connect('work')
            connect('home')
            const error = await bridge.request('tabs_list', {}).catch((e: Error) => e)
            expect((error as Error).message).toContain('work')
            expect((error as Error).message).toContain('home')
        })

        it('still routes without a profile while only one is connected', async () => {
            const only = connect('work')
            const promise = bridge.request('tabs_list', {})
            const sent = only.lastSent()
            only.receive({ id: sent.id, result: 'work-tabs' })
            await expect(promise).resolves.toBe('work-tabs')
        })

        it('a reconnecting profile replaces the previous connection', () => {
            const stale = connect('work')
            connect('work')
            expect(stale.closed?.code).toBe(4409)
            expect(bridge.connections()).toEqual([{ profile: 'work' }])
        })
    })
})

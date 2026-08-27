import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
    BrowserBridge,
    BridgeRequestError,
    deriveBrowserViewerBridgeToken,
} from './browserBridge'

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
const ALICE_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const BOB_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012346'

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

        // Once the bridge can bind a non-loopback interface (browserBridgeServer's
        // HAPPY_BROWSER_BRIDGE_HOST), the token is the sole defense on a network
        // an attacker can reach — a length-dependent compare timing side-channel
        // is worth closing even though it was harmless on loopback.
        it('rejects a same-length wrong token without throwing', () => {
            const socket = new FakeSocket()
            const wrongSameLength = TOKEN.slice(0, -1) + (TOKEN.endsWith('x') ? 'y' : 'x')
            const accepted = bridge.handleConnection(socket, { token: wrongSameLength, profile: 'default' })
            expect(accepted).toBe(false)
            expect(socket.closed?.code).toBe(4401)
        })

        it('rejects a token of different length without throwing', () => {
            const socket = new FakeSocket()
            const accepted = bridge.handleConnection(socket, { token: TOKEN + 'x', profile: 'default' })
            expect(accepted).toBe(false)
            expect(socket.closed?.code).toBe(4401)
        })

        it('accepts a connection with the right token and registers its profile', () => {
            connect('work')
            expect(bridge.connections()).toEqual([{ profile: 'work' }])
        })

        it('reports a pairing id separately from the user profile', () => {
            const socket = new FakeSocket()
            bridge.handleConnection(socket, { token: TOKEN, profile: 'work', pairingId: 'viewer-9222' })
            expect(bridge.connections()).toEqual([{ profile: 'work', pairingId: 'viewer-9222' }])
        })

        it('requires a viewer-scoped credential for a viewer connection', () => {
            const wrong = new FakeSocket()
            expect(bridge.handleConnection(wrong, {
                token: TOKEN,
                profile: 'default',
                viewerKey: ALICE_KEY,
            })).toBe(false)

            const scoped = new FakeSocket()
            expect(bridge.handleConnection(scoped, {
                token: deriveBrowserViewerBridgeToken(TOKEN, ALICE_KEY),
                profile: 'default',
                viewerKey: ALICE_KEY,
            })).toBe(true)
        })

        it('rejects a malformed viewer key before registering a scope', () => {
            const socket = new FakeSocket()
            expect(bridge.handleConnection(socket, {
                token: deriveBrowserViewerBridgeToken(TOKEN, 'short'),
                viewerKey: 'short',
            })).toBe(false)
            expect(socket.closed?.code).toBe(4401)
            expect(bridge.connections()).toEqual([])
        })

        it('keeps recent authentication failures inside their viewer scope', () => {
            const wrong = new FakeSocket()
            bridge.handleConnection(wrong, {
                token: 'wrong-token',
                viewerKey: BOB_KEY,
            })

            expect(bridge.hasRecentAuthFailure(BOB_KEY)).toBe(true)
            expect(bridge.hasRecentAuthFailure(ALICE_KEY)).toBe(false)
            expect(bridge.hasRecentAuthFailure()).toBe(false)
        })

        it('bounds authentication failure scopes from untrusted viewer keys', () => {
            for (let index = 0; index < 300; index += 1) {
                const viewerKey = `bv1_${index.toString(36).padStart(32, 'a')}`
                bridge.handleConnection(new FakeSocket(), { token: 'wrong-token', viewerKey })
            }

            expect((bridge as any).lastAuthFailureByScope.size).toBeLessThanOrEqual(256)
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
        it('reports activity for a scoped bridge request', async () => {
            const onViewerActivity = vi.fn()
            const scopedBridge = new BrowserBridge({ authToken: TOKEN, onViewerActivity })
            const socket = new FakeSocket()
            scopedBridge.handleConnection(socket, {
                token: deriveBrowserViewerBridgeToken(TOKEN, ALICE_KEY),
                viewerKey: ALICE_KEY,
            })

            const promise = scopedBridge.request('tabs_list', {}, { viewerKey: ALICE_KEY })
            const sent = socket.lastSent()
            socket.receive({ id: sent.id, result: [] })
            await promise

            expect(onViewerActivity).toHaveBeenCalledWith(ALICE_KEY)

            const repeated = scopedBridge.request('tabs_list', {}, { viewerKey: ALICE_KEY })
            socket.receive({ id: socket.lastSent().id, result: [] })
            await repeated
            expect(onViewerActivity).toHaveBeenCalledTimes(1)

            vi.advanceTimersByTime(60_000)
            const later = scopedBridge.request('tabs_list', {}, { viewerKey: ALICE_KEY })
            socket.receive({ id: socket.lastSent().id, result: [] })
            await later
            expect(onViewerActivity).toHaveBeenCalledTimes(2)

            socket.close()
            expect((scopedBridge as any).lastViewerActivityByScope.size).toBe(0)
        })

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

        it('names what is connected when the requested profile is not', async () => {
            // "no extension is connected" is false and unactionable when one
            // is — the caller just named the wrong profile and needs to see
            // the real names to fix its own call.
            connect('work')
            const error = await bridge.request('tabs_list', {}, { profile: 'home' }).catch((e: Error) => e)
            expect((error as Error).message).toContain('home')
            expect((error as Error).message).toContain('work')
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

        it('routes only within the caller viewer key', async () => {
            const alice = new FakeSocket()
            const bob = new FakeSocket()
            expect(bridge.handleConnection(alice, {
                token: deriveBrowserViewerBridgeToken(TOKEN, ALICE_KEY),
                profile: 'default',
                viewerKey: ALICE_KEY,
            })).toBe(true)
            expect(bridge.handleConnection(bob, {
                token: deriveBrowserViewerBridgeToken(TOKEN, BOB_KEY),
                profile: 'default',
                viewerKey: BOB_KEY,
            })).toBe(true)

            const promise = bridge.request('tabs_list', {}, { viewerKey: ALICE_KEY })
            expect(bob.sent).toHaveLength(0)
            const sent = alice.lastSent()
            alice.receive({ id: sent.id, result: 'alice-tabs' })

            await expect(promise).resolves.toBe('alice-tabs')
        })

        it('does not allow a profile name to cross the caller viewer boundary', async () => {
            const alice = new FakeSocket()
            const bob = new FakeSocket()
            bridge.handleConnection(alice, {
                token: deriveBrowserViewerBridgeToken(TOKEN, ALICE_KEY),
                profile: 'work',
                viewerKey: ALICE_KEY,
            })
            bridge.handleConnection(bob, {
                token: deriveBrowserViewerBridgeToken(TOKEN, BOB_KEY),
                profile: 'home',
                viewerKey: BOB_KEY,
            })

            const promise = bridge.request('tabs_list', {}, {
                viewerKey: ALICE_KEY,
                profile: 'home',
            })
            expect(bob.sent).toHaveLength(0)
            await expect(promise).rejects.toMatchObject({ code: 'NO_EXTENSION_CONNECTED' })
        })

        it('does not expose another viewer key or profile through status introspection', () => {
            const alice = new FakeSocket()
            const bob = new FakeSocket()
            bridge.handleConnection(alice, {
                token: deriveBrowserViewerBridgeToken(TOKEN, ALICE_KEY),
                profile: 'alice-profile',
                viewerKey: ALICE_KEY,
            })
            bridge.handleConnection(bob, {
                token: deriveBrowserViewerBridgeToken(TOKEN, BOB_KEY),
                profile: 'bob-profile',
                viewerKey: BOB_KEY,
            })

            expect(bridge.connections(ALICE_KEY)).toEqual([{
                profile: 'alice-profile',
                viewerKey: ALICE_KEY,
            }])
            expect(bridge.connections()).toEqual([])
        })
    })
})

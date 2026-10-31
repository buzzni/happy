import { describe, expect, it, vi } from 'vitest'
import { BROWSER_NATIVE_HOST_NAME, approveLocalConnection, attemptNativePairing, attemptSetupPairing, prepareLocalConnection } from './nativePairing.js'

function fakeChrome({ stored = {}, response, error } = {}) {
    const set = vi.fn(async () => {})
    const sendNativeMessage = vi.fn(async () => {
        if (error) throw error
        return response
    })
    return {
        chrome: {
            storage: {
                local: {
                    get: vi.fn(async () => stored),
                    set,
                },
            },
            runtime: { sendNativeMessage },
        },
        set,
        sendNativeMessage,
    }
}

describe('attemptNativePairing', () => {
    it('preserves a scoped Desktop setup across worker restarts without replacing its token', async () => {
        const { chrome, sendNativeMessage } = fakeChrome({ stored: { token: 'scoped', viewerKey: 'bv1_abcdefghijklmnopqrstuvwxyz012345', pairingId: 'setup-id' } })
        expect(await attemptNativePairing(chrome)).toEqual({ status: 'already-configured' })
        expect(sendNativeMessage).not.toHaveBeenCalled()
    })
    it('stores local pairing config returned by the Happy native host', async () => {
        const { chrome, set, sendNativeMessage } = fakeChrome({
            response: {
                ok: true,
                config: { token: 'secret-token', port: 41777, host: '127.0.0.1' },
            },
        })

        await expect(attemptNativePairing(chrome)).resolves.toEqual({ status: 'paired' })
        expect(sendNativeMessage).toHaveBeenCalledWith(BROWSER_NATIVE_HOST_NAME, { type: 'pair' })
        expect(set).toHaveBeenCalledWith({
            token: 'secret-token',
            port: 41777,
            host: '127.0.0.1',
        })
    })

    it('stores a viewer-scoped container pairing response', async () => {
        const { chrome, set } = fakeChrome({
            response: {
                ok: true,
                config: {
                    token: 'scoped-token',
                    port: 41777,
                    host: 'host.docker.internal',
                    viewerKey: 'bv1_abcdefghijklmnopqrstuvwxyz012345',
                },
            },
        })

        await expect(attemptNativePairing(chrome)).resolves.toEqual({ status: 'paired' })
        expect(set).toHaveBeenCalledWith(expect.objectContaining({
            token: 'scoped-token',
            host: 'host.docker.internal',
            viewerKey: 'bv1_abcdefghijklmnopqrstuvwxyz012345',
        }))
    })

    it('reports that automatic pairing is unavailable when the native host is absent', async () => {
        const { chrome, set } = fakeChrome({ error: new Error('Specified native messaging host not found') })

        await expect(attemptNativePairing(chrome)).resolves.toEqual({ status: 'unavailable' })
        expect(set).not.toHaveBeenCalled()
    })

    it.each([
        undefined,
        { ok: false, error: 'unavailable' },
        { ok: true, config: { token: '', port: 41777, host: '127.0.0.1' } },
        { ok: true, config: { token: 'token', port: 0, host: '127.0.0.1' } },
        { ok: true, config: { token: 'token', port: 41777, host: '0.0.0.0' } },
    ])('rejects an invalid or non-loopback native response without saving it', async (response) => {
        const { chrome, set } = fakeChrome({ response })

        await expect(attemptNativePairing(chrome)).resolves.toEqual({ status: 'invalid-response' })
        expect(set).not.toHaveBeenCalled()
    })

    it('preserves an existing manual or remote pairing without contacting the native host', async () => {
        const { chrome, set, sendNativeMessage } = fakeChrome({
            stored: { token: 'existing-token' },
        })

        await expect(attemptNativePairing(chrome)).resolves.toEqual({ status: 'already-configured' })
        expect(sendNativeMessage).not.toHaveBeenCalled()
        expect(set).not.toHaveBeenCalled()
    })

    it('refreshes an existing viewer-scoped pairing after its container restarts', async () => {
        const viewerKey = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
        const { chrome, set, sendNativeMessage } = fakeChrome({
            stored: { token: 'previous-scoped-token', viewerKey },
            response: {
                ok: true,
                config: {
                    token: 'current-scoped-token',
                    port: 41777,
                    host: 'host.docker.internal',
                    viewerKey,
                },
            },
        })

        await expect(attemptNativePairing(chrome)).resolves.toEqual({ status: 'paired' })
        expect(sendNativeMessage).toHaveBeenCalled()
        expect(set).toHaveBeenCalledWith(expect.objectContaining({
            token: 'current-scoped-token',
            viewerKey,
        }))
    })

    it('does not overwrite settings saved while the native host is responding', async () => {
        let resolveResponse
        const stored = {}
        const set = vi.fn(async () => {})
        const chrome = {
            storage: {
                local: {
                    get: vi.fn(async () => stored),
                    set,
                },
            },
            runtime: {
                sendNativeMessage: vi.fn(() => new Promise((resolve) => {
                    resolveResponse = resolve
                })),
            },
        }

        const pairing = attemptNativePairing(chrome)
        await vi.waitFor(() => expect(chrome.runtime.sendNativeMessage).toHaveBeenCalled())
        stored.token = 'manual-token'
        resolveResponse({
            ok: true,
            config: { token: 'native-token', port: 41777, host: '127.0.0.1' },
        })

        await expect(pairing).resolves.toEqual({ status: 'already-configured' })
        expect(set).not.toHaveBeenCalled()
    })
})

describe('Desktop setup native pairing', () => {
    const operationId = 'a'.repeat(32)
    const config = { token: 'scoped', port: 41777, host: '127.0.0.1', viewerKey: 'bv1_abcdefghijklmnopqrstuvwxyz012345', pairingId: operationId, profile: 'My Chrome' }
    it('uses the one-time operation, overwrites legacy pairing, and validates exact marker and scope', async () => {
        const { chrome, set, sendNativeMessage } = fakeChrome({ stored: { token: 'legacy' }, response: { ok: true, config } })
        expect(await attemptSetupPairing(chrome, operationId)).toEqual({ status: 'paired' })
        expect(sendNativeMessage).toHaveBeenCalledWith(BROWSER_NATIVE_HOST_NAME, { type: 'setup-pair', operationId })
        expect(set).toHaveBeenCalledWith(config)
    })
    it.each([{ ...config, pairingId: 'other' }, { ...config, viewerKey: '' }, { ...config, host: 'remote' }])('refuses incorrect config without fallback', async config => {
        const { chrome, set } = fakeChrome({ response: { ok: true, config } })
        expect(await attemptSetupPairing(chrome, operationId)).toEqual({ status: 'invalid-response' })
        expect(set).not.toHaveBeenCalled()
    })
})

function fakeChromeByType(responses, stored = {}) {
    const store = { ...stored }
    const sendNativeMessage = vi.fn(async (_host, message) => {
        const response = responses[message.type]
        if (response instanceof Error) throw response
        return response
    })
    return {
        chrome: {
            storage: { local: {
                get: vi.fn(async keys => Object.fromEntries(keys.filter(key => key in store).map(key => [key, store[key]]))),
                set: vi.fn(async values => { Object.assign(store, values) }),
            } },
            runtime: { sendNativeMessage },
        },
        store,
        sendNativeMessage,
    }
}

const viewerKey = 'bv1_abcdefghijklmnopqrstuvwxyz012345'

describe('prepareLocalConnection', () => {
    it('waits for approval when the local daemon offers an account, without pairing anything', async () => {
        const { chrome, store, sendNativeMessage } = fakeChromeByType({ 'connect-offer': { ok: true, account: 'a@example.com' } })
        expect(await prepareLocalConnection(chrome)).toEqual({ status: 'awaiting-approval', account: 'a@example.com' })
        expect(sendNativeMessage).toHaveBeenCalledTimes(1)
        expect(store.token).toBeUndefined()
    })
    it('keeps an approved per-user pairing without asking again', async () => {
        const { chrome, sendNativeMessage } = fakeChromeByType({}, { token: 't', viewerKey, pairingId: 'p' })
        expect(await prepareLocalConnection(chrome)).toEqual({ status: 'already-configured' })
        expect(sendNativeMessage).not.toHaveBeenCalled()
    })
    it.each([
        ['an older native host', { ok: false, error: '로컬 Happy 연결 정보를 읽지 못했습니다.' }],
        ['an ineligible machine', { ok: false, error: 'MACHINE_NOT_ELIGIBLE' }],
    ])('falls back to the legacy local pairing for %s', async (_name, offer) => {
        const { chrome, store } = fakeChromeByType({ 'connect-offer': offer, pair: { ok: true, config: { token: 'legacy', port: 41777, host: '127.0.0.1' } } })
        const result = await prepareLocalConnection(chrome)
        expect(result.status).toBe('paired')
        expect(store.token).toBe('legacy')
    })
    it('reports the refusal code alongside the legacy outcome', async () => {
        const { chrome } = fakeChromeByType({ 'connect-offer': { ok: false, error: 'DAEMON_OFFLINE' }, pair: new Error('no host') })
        expect(await prepareLocalConnection(chrome)).toEqual({ status: 'unavailable', reason: 'DAEMON_OFFLINE' })
    })
    it('reports a missing native host as unavailable', async () => {
        const { chrome } = fakeChromeByType({ 'connect-offer': new Error('Specified native messaging host not found.'), pair: new Error('same') })
        expect(await prepareLocalConnection(chrome)).toEqual({ status: 'unavailable' })
    })
})

describe('approveLocalConnection', () => {
    const config = { token: 'scoped', port: 41777, host: '127.0.0.1', viewerKey, pairingId: 'pairing-1', profile: 'default-1f8b' }
    it('connects this profile under its own name and stores the per-user pairing', async () => {
        const { chrome, store, sendNativeMessage } = fakeChromeByType({ connect: { ok: true, config } }, { profile: 'default-1f8b' })
        expect(await approveLocalConnection(chrome)).toEqual({ status: 'paired' })
        expect(sendNativeMessage).toHaveBeenCalledWith(BROWSER_NATIVE_HOST_NAME, { type: 'connect', profile: 'default-1f8b' })
        expect(store).toMatchObject(config)
    })
    it.each([
        ['another profile', { ...config, profile: 'other' }],
        ['no per-user key', { ...config, viewerKey: '' }],
        ['no pairing marker', { ...config, pairingId: '' }],
        ['a non-loopback host', { ...config, host: 'example.com' }],
    ])('refuses a config for %s', async (_name, bad) => {
        const { chrome, store } = fakeChromeByType({ connect: { ok: true, config: bad } }, { profile: 'default-1f8b' })
        expect(await approveLocalConnection(chrome)).toEqual({ status: 'invalid-response' })
        expect(store.token).toBeUndefined()
    })
    it('passes a known refusal code to the page', async () => {
        const { chrome } = fakeChromeByType({ connect: { ok: false, error: 'MACHINE_NOT_ELIGIBLE' } }, { profile: 'default-1f8b' })
        expect(await approveLocalConnection(chrome)).toEqual({ status: 'refused', reason: 'MACHINE_NOT_ELIGIBLE' })
    })
})

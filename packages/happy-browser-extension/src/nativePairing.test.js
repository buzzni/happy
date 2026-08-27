import { describe, expect, it, vi } from 'vitest'
import { BROWSER_NATIVE_HOST_NAME, attemptNativePairing } from './nativePairing.js'

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

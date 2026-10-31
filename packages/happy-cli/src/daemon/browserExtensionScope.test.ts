import { describe, expect, it, vi } from 'vitest'
import { fetchBrowserExtensionScope } from './browserExtensionScope'

const viewerKey = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
function respond(status: number, body: unknown) {
    return vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }))
}

describe('daemon lookup of its owner browser key', () => {
    it('asks the trusted studio with the daemon token for this machine', async () => {
        const fetch = respond(200, { routingVersion: 1, viewerKey, account: { label: 'a@example.com' } })
        const scope = await fetchBrowserExtensionScope({ origin: 'https://saycode.ai', machineId: 'M 1', token: 'daemon-token', fetch })
        expect(scope).toEqual({ viewerKey, account: 'a@example.com' })
        const [url, init] = fetch.mock.calls[0]
        expect(url).toBe('https://saycode.ai/api/machines/M%201/browser-local-setup')
        expect(init.method).toBe('POST')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer daemon-token')
        expect(JSON.parse(String(init.body))).toEqual({ action: 'extension-scope' })
    })
    it.each([401, 403])('maps %i to a machine that cannot connect a browser', async status => {
        await expect(fetchBrowserExtensionScope({ origin: 'https://saycode.ai', machineId: 'M1', token: 't', fetch: respond(status, {}) }))
            .rejects.toThrow('MACHINE_NOT_ELIGIBLE')
    })
    it.each([
        ['server failure', respond(503, { code: 'BROWSER_SETUP_UNAVAILABLE' })],
        ['old server', respond(400, { code: 'INVALID_REQUEST' })],
        ['malformed body', respond(200, { routingVersion: 1, viewerKey })],
        ['network error', vi.fn(async () => { throw new Error('ECONNRESET') })],
    ])('reports %s as unavailable', async (_name, fetch) => {
        await expect(fetchBrowserExtensionScope({ origin: 'https://saycode.ai', machineId: 'M1', token: 't', fetch }))
            .rejects.toThrow('SCOPE_UNAVAILABLE')
    })
    it('does not call anything without a trusted studio origin', async () => {
        const fetch = respond(200, {})
        await expect(fetchBrowserExtensionScope({ origin: null, machineId: 'M1', token: 't', fetch })).rejects.toThrow('SCOPE_UNAVAILABLE')
        expect(fetch).not.toHaveBeenCalled()
    })
})

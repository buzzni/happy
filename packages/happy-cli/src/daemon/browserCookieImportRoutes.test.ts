import fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startAdminServer } from '@/browserRuntime/admin'
import { BrowserRuntimeError } from '@/browserRuntime/contracts'
import { attachBrowserCookieImportRoutes } from './browserCookieImportRoutes'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const request = { host: 'example.com', source: { browser: 'Google Chrome', profile: 'Default' },
    cookies: [{ name: 'sid', value: 'secret-value', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expiresAt: null }] }

async function daemon(cookies?: Parameters<typeof startAdminServer>[0]['cookies']) {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-cookies-')); cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const socketPath = join(dir, 'admin.sock')
    if (cookies) {
        const admin = await startAdminServer({ runtime: { revokeGrant: async () => {}, reconcileAction: async () => ({}) as never, pinnedProfiles: () => [] },
            drivers: new Map(), listen: { socketPath }, metrics: async () => ({}), revokeCapability: async () => {}, cookies })
        cleanups.push(() => admin.close())
    }
    const app = fastify()
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    attachBrowserCookieImportRoutes(app, { adminSocket: () => socketPath })
    cleanups.push(() => app.close())
    return app
}

describe('Desktop cookie import routes', () => {
    it('passes a host’s cookies to the personal runtime and answers with counts only', async () => {
        const seen: unknown[] = []
        const app = await daemon({
            set: async (input) => { seen.push(input); return { host: 'example.com', imported: 1, skipped: 0 } },
            remove: async () => ({ host: 'example.com', removed: 1, failed: 0 }),
            list: async () => [{ host: 'example.com', source: request.source, importedAtMs: 5, count: 1 }],
        })
        const set = await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/set', payload: request })
        expect(set.statusCode).toBe(200)
        expect(set.json()).toEqual({ host: 'example.com', imported: 1, skipped: 0 })
        expect(seen).toEqual([request])
        expect((await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/list', payload: {} })).json())
            .toEqual({ imports: [{ host: 'example.com', source: request.source, importedAtMs: 5, count: 1 }] })
        expect((await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/remove', payload: { host: 'example.com' } })).json())
            .toEqual({ host: 'example.com', removed: 1, failed: 0 })
    })

    it('accepts a site’s full set of cookies above the default body limit', async () => {
        const app = await daemon({ set: async () => ({ host: 'example.com', imported: 300, skipped: 0 }), remove: async () => ({}) as never, list: async () => [] })
        const many = { ...request, cookies: Array.from({ length: 300 }, (_, index) => ({ ...request.cookies[0], name: `c${index}`, value: 'v'.repeat(4000) })) }
        expect((await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/set', payload: many })).statusCode).toBe(200)
    })

    it('maps runtime refusals to stable codes without echoing values', async () => {
        const app = await daemon({
            set: async () => { throw new BrowserRuntimeError('INVALID_REQUEST', 'bad secret-value') },
            remove: async () => { throw new BrowserRuntimeError('TARGET_GONE', 'nothing') },
            list: async () => { throw new Error('boom') },
        })
        const set = await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/set', payload: request })
        expect([set.statusCode, set.json()]).toEqual([400, { error: 'INVALID_REQUEST' }])
        const remove = await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/remove', payload: { host: 'example.com' } })
        expect([remove.statusCode, remove.json()]).toEqual([404, { error: 'NOTHING_TO_REMOVE' }])
        const list = await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/list', payload: {} })
        expect([list.statusCode, list.json()]).toEqual([503, { error: 'AI_BROWSER_UNAVAILABLE' }])
        expect(set.body + remove.body + list.body).not.toContain('secret-value')
    })

    it('reports an absent runtime or one without cookie support', async () => {
        const absent = await daemon()
        const list = await absent.inject({ method: 'POST', url: '/browser/desktop-login/cookies/list', payload: {} })
        expect([list.statusCode, list.json()]).toEqual([503, { error: 'AI_BROWSER_UNAVAILABLE' }])

        const dir = await mkdtemp(join(tmpdir(), 'daemon-cookies-')); cleanups.push(() => rm(dir, { recursive: true, force: true }))
        const socketPath = join(dir, 'admin.sock')
        const old = await startAdminServer({ runtime: { revokeGrant: async () => {}, reconcileAction: async () => ({}) as never, pinnedProfiles: () => [] },
            drivers: new Map(), listen: { socketPath }, metrics: async () => ({}), revokeCapability: async () => {} })
        cleanups.push(() => old.close())
        const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler)
        attachBrowserCookieImportRoutes(app, { adminSocket: () => socketPath }); cleanups.push(() => app.close())
        const unsupported = await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/set', payload: request })
        expect([unsupported.statusCode, unsupported.json()]).toEqual([501, { error: 'COOKIE_IMPORT_UNSUPPORTED' }])
    })

    it('rejects malformed requests before reaching the runtime', async () => {
        const seen: unknown[] = []
        const app = await daemon({ set: async (input) => { seen.push(input); return {} as never }, remove: async () => ({}) as never, list: async () => [] })
        for (const payload of [{ ...request, host: 'https://example.com' }, { ...request, extra: 1 }, { ...request, cookies: [] }])
            expect((await app.inject({ method: 'POST', url: '/browser/desktop-login/cookies/set', payload })).statusCode).toBe(400)
        expect(seen).toEqual([])
    })
})

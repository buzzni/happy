import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { BrowserLocalSetup } from './browserLocalSetup'

/** All routes inherit the control server bearer and managed-runtime restrictions. */
export function attachBrowserLocalSetupRoutes(app: FastifyInstance, setup: BrowserLocalSetup) {
    const typed = app.withTypeProvider<ZodTypeProvider>()
    const scope = z.string().regex(/^bv1_[A-Za-z0-9_-]{32}$/)
    typed.post('/browser/local-setup/begin', { schema: { body: z.object({ viewerKey: scope, profile: z.string().min(1).max(128), extensionId: z.string().regex(/^[a-p]{32}$/).optional() }).strict() } },
        async request => setup.begin(request.body.viewerKey, request.body.profile, request.body.extensionId))
    typed.post('/browser/local-setup/status', { schema: { body: z.object({ viewerKey: scope }).strict() } },
        async request => setup.status(request.body.viewerKey))
    typed.post('/browser/local-setup/revoke', { schema: { body: z.object({ viewerKey: scope }).strict() } },
        async request => setup.revoke(request.body.viewerKey))
    // Extension-started connection: the native host asks on the extension's behalf, the daemon resolves whose key.
    typed.post('/browser/local-setup/offer', { schema: { body: z.object({}).strict() } },
        async (_request, reply) => {
            try { return { ok: true, account: (await setup.offer()).account } }
            catch (error) { reply.code(409); return { ok: false, error: setupErrorCode(error) } }
        })
    typed.post('/browser/local-setup/connect', { schema: { body: z.object({ profile: z.string().min(1).max(128) }).strict() } },
        async (request, reply) => {
            try { return { ok: true, config: await setup.connect(request.body.profile) } }
            catch (error) { reply.code(409); return { ok: false, error: setupErrorCode(error) } }
        })
    // Desktop arms its signed-in user's offer; `clear` withdraws it (sign-out).
    typed.post('/browser/local-setup/arm', { schema: { body: z.union([z.object({ viewerKey: scope, account: z.string().min(1).max(200) }).strict(), z.object({ clear: z.literal(true) }).strict()]) } },
        async request => { await setup.arm('clear' in request.body ? null : request.body); return { ok: true } })
    typed.post('/browser/local-setup/consume', { schema: { body: z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict() } },
        async (request, reply) => {
            try { return { ok: true, config: await setup.consume(request.body.operationId) } }
            catch { reply.code(409); return { ok: false, error: 'SETUP_EXPIRED' } }
        })
}

const SETUP_ERROR_CODES = new Set(['MACHINE_NOT_ELIGIBLE', 'SCOPE_UNAVAILABLE', 'INVALID_PROFILE'])
/** Only known codes leave the daemon; anything else is a generic unavailability. */
function setupErrorCode(error: unknown): string {
    return error instanceof Error && SETUP_ERROR_CODES.has(error.message) ? error.message : 'SCOPE_UNAVAILABLE'
}

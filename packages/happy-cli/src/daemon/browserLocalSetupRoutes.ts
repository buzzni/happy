import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { BrowserLocalSetup } from './browserLocalSetup'
import type { BrowserBridge } from './browserBridge'

/** All routes inherit the control server bearer and managed-runtime restrictions. */
export function attachBrowserLocalSetupRoutes(app: FastifyInstance, setup: BrowserLocalSetup, bridge: BrowserBridge) {
    const typed = app.withTypeProvider<ZodTypeProvider>()
    const scope = z.string().regex(/^bv1_[A-Za-z0-9_-]{32}$/)
    // While another process holds the bridge port, the extension connects to it, not to this daemon,
    // so a pairing set up here would never complete. Opens again once this daemon takes the port over.
    const preHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
        if (bridge.heldPort !== null) return reply.code(503).send({ ok: false, error: 'BRIDGE_PORT_IN_USE' })
    }
    typed.post('/browser/local-setup/begin', { preHandler, schema: { body: z.object({ viewerKey: scope, profile: z.string().min(1).max(128), extensionId: z.string().regex(/^[a-p]{32}$/).optional() }).strict() } },
        async request => setup.begin(request.body.viewerKey, request.body.profile, request.body.extensionId))
    typed.post('/browser/local-setup/status', { preHandler, schema: { body: z.object({ viewerKey: scope }).strict() } },
        async request => setup.status(request.body.viewerKey))
    typed.post('/browser/local-setup/revoke', { preHandler, schema: { body: z.object({ viewerKey: scope }).strict() } },
        async request => setup.revoke(request.body.viewerKey))
    // Extension-started connection: the native host asks on the extension's behalf, the daemon resolves whose key.
    typed.post('/browser/local-setup/offer', { preHandler, schema: { body: z.object({}).strict() } },
        async (_request, reply) => {
            try { return { ok: true, account: (await setup.offer()).account } }
            catch (error) { reply.code(409); return { ok: false, error: setupErrorCode(error) } }
        })
    typed.post('/browser/local-setup/connect', { preHandler, schema: { body: z.object({ profile: z.string().min(1).max(128) }).strict() } },
        async (request, reply) => {
            try { return { ok: true, config: await setup.connect(request.body.profile) } }
            catch (error) { reply.code(409); return { ok: false, error: setupErrorCode(error) } }
        })
    typed.post('/browser/local-setup/consume', { preHandler, schema: { body: z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict() } },
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

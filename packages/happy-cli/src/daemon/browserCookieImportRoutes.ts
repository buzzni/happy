/**
 * Desktop-only routes that hand site cookies the user chose in Saycode Desktop to this user's
 * personal AI browser runtime (Desktop specs/ai-browser-cookie-import, ADR-087).
 *
 * The control server bearer guards them like every other route. They forward to the runtime's
 * 0600 admin socket and answer with counts and stable codes only: cookie values go in, never out,
 * and never reach a log.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { request } from 'node:http'
import { z } from 'zod'
import { cookieImportRequest } from '@/browserRuntime/cookieImports'

/** A site's 300 cookies of up to 4 KiB each, as JSON. */
const BODY_LIMIT = 2 * 1024 * 1024
/** Setting cookies may first start the browser. */
const RUNTIME_TIMEOUT_MS = 60_000

type AdminAnswer = { status: number; body: { ok?: boolean; result?: unknown; error?: { code?: unknown } } }

function callAdmin(socketPath: string | undefined, method: 'GET' | 'POST', path: string, body?: unknown): Promise<AdminAnswer | undefined> {
    // No configured runtime: the AI browser is not there to take the cookies.
    if (!socketPath) return Promise.resolve(undefined)
    return new Promise(resolve => {
        const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json' }, timeout: RUNTIME_TIMEOUT_MS }, res => {
            let raw = ''
            res.on('data', chunk => { raw += chunk })
            res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }) } catch { resolve(undefined) } })
        })
        // No socket, a dead runtime or a timeout: the same.
        req.on('error', () => resolve(undefined))
        req.on('timeout', () => req.destroy())
        req.end(body === undefined ? undefined : JSON.stringify(body))
    })
}

function answer(reply: FastifyReply, result: AdminAnswer | undefined) {
    if (result?.status === 200 && result.body.ok) return result.body.result
    const code = result?.body.error?.code
    if (result?.status === 404 && code === 'UNSUPPORTED_OPERATION') return reply.code(501).send({ error: 'COOKIE_IMPORT_UNSUPPORTED' })
    if (code === 'INVALID_REQUEST') return reply.code(400).send({ error: 'INVALID_REQUEST' })
    if (code === 'TARGET_GONE') return reply.code(404).send({ error: 'NOTHING_TO_REMOVE' })
    return reply.code(503).send({ error: 'AI_BROWSER_UNAVAILABLE' })
}

export function attachBrowserCookieImportRoutes(app: FastifyInstance, runtime: { adminSocket(): string | undefined }) {
    const typed = app.withTypeProvider<ZodTypeProvider>()
    typed.post('/browser/desktop-login/cookies/list', { schema: { body: z.object({}).strict() } },
        async (_request, reply) => answer(reply, await callAdmin(runtime.adminSocket(), 'GET', '/admin/cookies')))
    typed.post('/browser/desktop-login/cookies/set', { bodyLimit: BODY_LIMIT, schema: { body: cookieImportRequest } },
        async (req, reply) => answer(reply, await callAdmin(runtime.adminSocket(), 'POST', '/admin/cookies/set', req.body)))
    typed.post('/browser/desktop-login/cookies/remove', { schema: { body: z.object({ host: cookieImportRequest.shape.host }).strict() } },
        async (req, reply) => answer(reply, await callAdmin(runtime.adminSocket(), 'POST', '/admin/cookies/remove', req.body)))
}

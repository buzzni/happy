/**
 * Loopback control routes for the restart drain (aplus specs/codexcli-daemon-restart-drain
 * R1·R22·R24). They sit behind the control server's bearer hook like every other
 * route; a managed runtime never reaches them (its hook refuses non-report paths).
 *
 * A daemon running the Windows standalone shutdown drain advertises
 * `supported: false` — the two drains must never coexist on one daemon.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
    MAX_RESTART_DRAIN_GRACE_SECONDS,
    RESTART_DRAIN_REASONS,
    type RestartDrainBeginRequest,
    type RestartDrainBeginResult,
    type RestartDrainView,
} from './restartDrain'

export const RESTART_DRAIN_CAPABILITY = 'daemon-restart-drain-v1'
/** The daemon is already replacing itself; a caller just waits for it to exit. */
export const RESTART_DRAIN_HANDING_OFF = 'RESTART_DRAIN_HANDING_OFF'

export interface RestartDrainControlPort {
    /** Stable for this daemon process: pid + start time (R18). */
    instanceId: string
    begin: (request: RestartDrainBeginRequest) => RestartDrainBeginResult
    status: (operationId: string) => RestartDrainView | null
    /** A drain is open and not yet ready — `/stop` must wait for it. */
    stopBlocked: () => boolean
}

const token = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
const beginSchema = z.object({
    requestId: token,
    expectedInstanceId: z.string().min(1).max(128),
    reason: z.enum(RESTART_DRAIN_REASONS),
    intent: z.enum(['restart', 'stop']),
    graceSeconds: z.number().int().min(0).max(MAX_RESTART_DRAIN_GRACE_SECONDS).optional(),
    force: z.boolean().optional(),
    leaseSeconds: z.number().int().min(0).max(300).optional(),
}).strict()
const statusSchema = z.object({
    expectedInstanceId: z.string().min(1).max(128),
    operationId: token,
}).strict()

export function attachRestartDrainRoutes(
    app: FastifyInstance,
    control: RestartDrainControlPort | undefined,
    options: { standaloneDrainActive: boolean },
): void {
    const port = options.standaloneDrainActive ? undefined : control

    app.post('/restart-drain/capabilities', async () => port
        ? { supported: true, capability: RESTART_DRAIN_CAPABILITY, instanceId: port.instanceId }
        : { supported: false, capability: RESTART_DRAIN_CAPABILITY })

    app.post('/restart-drain/begin', async (request, reply) => {
        if (!port) return reply.code(409).send({ error: 'restart-drain-unsupported' })
        const parsed = beginSchema.safeParse(request.body)
        if (!parsed.success) return reply.code(400).send({ error: 'invalid-request' })
        if (parsed.data.expectedInstanceId !== port.instanceId) return reply.code(409).send({ error: 'instance-mismatch' })
        const result = port.begin({
            reason: parsed.data.reason,
            intent: parsed.data.intent,
            trigger: 'request',
            requestId: parsed.data.requestId,
            ...(parsed.data.graceSeconds !== undefined ? { graceSeconds: parsed.data.graceSeconds } : {}),
            ...(parsed.data.force !== undefined ? { force: parsed.data.force } : {}),
            ...(parsed.data.leaseSeconds !== undefined ? { leaseSeconds: parsed.data.leaseSeconds } : {}),
        })
        if (!result.ok) {
            if (result.code === 'handing-off') return reply.code(409).send({ error: 'handing-off', code: RESTART_DRAIN_HANDING_OFF })
            return reply.code(result.code === 'not-ready' ? 503 : 400).send({ error: result.code })
        }
        return result.view
    })

    app.post('/restart-drain/status', async (request, reply) => {
        if (!port) return reply.code(409).send({ error: 'restart-drain-unsupported' })
        const parsed = statusSchema.safeParse(request.body)
        if (!parsed.success) return reply.code(400).send({ error: 'invalid-request' })
        if (parsed.data.expectedInstanceId !== port.instanceId) return reply.code(409).send({ error: 'instance-mismatch' })
        const view = port.status(parsed.data.operationId)
        if (!view) return reply.code(404).send({ error: 'unknown-operation' })
        return view
    })
}

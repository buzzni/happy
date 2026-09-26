/** Public broker registration metadata; process ownership is optional for legacy sessions. */
import { z } from 'zod'

export const sessionOwnerSchema = z.object({
    bootId: z.string().min(1).max(256),
    pid: z.number().int().positive().safe(),
    // Linux clock ticks since boot, kept as a string to avoid precision loss.
    pidStartTime: z.string().regex(/^\d+$/),
}).strict()

export type SessionOwner = z.infer<typeof sessionOwnerSchema>

export const sessionRegistrationsSchema = z.array(z.object({
    registrationId: z.string().min(1),
    agentSessionId: z.string().optional(),
    owner: sessionOwnerSchema.optional(),
    createdAtMs: z.number(),
    revoking: z.boolean(),
}))

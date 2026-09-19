import * as z from 'zod'

export const DIFFICULTY_ROUTING_POLICY_VERSION = 'org-shared-difficulty-routing.v1' as const
export const DIFFICULTY_ROUTING_CAPABILITY_VERSION = 1 as const
export const DIFFICULTY_ROUTING_MAX_INPUT_CHARS = 8000 as const
export const DIFFICULTY_ROUTING_MAX_INPUT_TOKENS = 512 as const

export const DifficultyRoutingIntentSchema = z.object({
  version: z.literal(1),
  mode: z.literal('auto'),
  policy: z.literal(DIFFICULTY_ROUTING_POLICY_VERSION),
  clientRequestId: z.string().min(1),
  clientRouteSource: z.literal('default-auto'),
})

export const DifficultyRoutingCapabilitySchema = z.object({
  version: z.literal(1),
  protocol: z.literal(DIFFICULTY_ROUTING_POLICY_VERSION),
  hostProcessKeyId: z.string().min(1),
  hostProcessPublicKey: z.string().min(1),
  ready: z.boolean().optional(),
  classifier: z.object({
    kind: z.literal('transformers-binary'),
    modelMaxInputTokens: z.literal(DIFFICULTY_ROUTING_MAX_INPUT_TOKENS),
    maxInputChars: z.literal(DIFFICULTY_ROUTING_MAX_INPUT_CHARS),
    onnxSha256: z.literal('444c99b6f4d417e50859f73e1557db11943a2ad073ce4050a65f1b7d39403038'),
    tokenizerJsonSha256: z.literal('acadd7d076a55a97edf9fb0521a0a2e9cf8cbbdd62e4d793f2aa3d1900916356'),
    revision: z.string().min(1),
  }),
  limits: z.object({
    concurrency: z.literal(1),
    queueSize: z.literal(8),
    requestDeadlineMs: z.literal(1000),
  }),
})

export type DifficultyRoutingIntent = z.infer<typeof DifficultyRoutingIntentSchema>
export type DifficultyRoutingCapability = z.infer<typeof DifficultyRoutingCapabilitySchema>

export function pickDifficultyRoutingPrompt(input: {
  intent: unknown
  contentText: string
  metaPrompt?: unknown
}): string | null {
  const intent = DifficultyRoutingIntentSchema.safeParse(input.intent)
  if (!intent.success) return null
  if (input.metaPrompt !== undefined && typeof input.metaPrompt !== 'string') return null
  const prompt = input.metaPrompt ?? input.contentText
  if (!prompt.trim()) return null
  return prompt.length <= DIFFICULTY_ROUTING_MAX_INPUT_CHARS ? prompt : null
}

/**
 * A turn the client delegated to organization-shared routing.
 *
 * Both runners decide model/effort handling from this, and a wrong `false`
 * silently applies the client's model and skips shared routing with no error
 * anywhere — so this judgment lives here alone rather than per runner.
 * The intent rules live in DifficultyRoutingIntentSchema — do not restate them.
 */
export function isDelegatedDifficultyRoutingMessage(message: {
  meta?: {
    modelSource?: string
    difficultyRoutingAuthorization?: string
    difficultyRoutingIntent?: unknown
  } | null
}): boolean {
  const meta = message.meta
  if (!meta || meta.modelSource !== 'auto') return false
  if (typeof meta.difficultyRoutingAuthorization !== 'string' || meta.difficultyRoutingAuthorization.length === 0) return false
  return DifficultyRoutingIntentSchema.safeParse(meta.difficultyRoutingIntent).success
}

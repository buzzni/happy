// Server-only entry point; do not export from the browser wire index.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
const schema = z.strictObject({ version: z.literal(1), projectId: z.string().startsWith('chat:').min(6).max(200),
  actorUserId: z.string().min(1).max(200), state: z.enum(['impact', 'active', 'archived', 'deleted']),
  bearerHash: z.string().regex(/^[a-f0-9]{64}$/), issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive() });
type Input = { projectId: string; actorUserId: string; state: z.infer<typeof schema>['state']; bearer: string; secret: string; now: number };
const hash = (bearer: string) => createHash('sha256').update(bearer).digest('hex');
function mac(payload: string, secret: string) {
  if (Buffer.byteLength(secret) < 32) throw new Error('CHAT_LIFECYCLE_SECRET_REQUIRED');
  return createHmac('sha256', secret).update('happy-chat-lifecycle-v1\0').update(payload).digest();
}
export function signChatAutomationLifecycle(input: Input) {
  const payload = Buffer.from(JSON.stringify(schema.parse({ version: 1, projectId: input.projectId, actorUserId: input.actorUserId,
    state: input.state, bearerHash: hash(input.bearer), issuedAt: input.now, expiresAt: input.now + 30000 }))).toString('base64url');
  return `CAL1.${payload}.${mac(payload, input.secret).toString('base64url')}`;
}
export function verifyChatAutomationLifecycle(input: Omit<Input, 'actorUserId'> & { token: string }): boolean {
  if (input.token.length > 4096) return false;
  const parts = /^CAL1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(input.token);
  if (!parts) return false;
  try {
    if (!timingSafeEqual(Buffer.from(mac(parts[1], input.secret).toString('base64url')), Buffer.from(parts[2]))) return false;
    const value = schema.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString()));
    return value.projectId === input.projectId && value.state === input.state && value.bearerHash === hash(input.bearer)
      && value.issuedAt <= input.now + 5000 && value.expiresAt > input.now && value.expiresAt - value.issuedAt === 30000;
  } catch { return false; }
}

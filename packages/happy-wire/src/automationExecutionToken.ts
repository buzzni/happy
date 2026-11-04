// Server-only entry point: the shared admission secret must never reach a browser bundle.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(200);
const targetSchema = z.strictObject({
  automationId: id, projectId: id, runId: id,
  generation: z.number().int().positive(), revision: z.number().int().positive(),
  machineId: id, machineAccountId: id, displaySessionId: id,
  createBodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  executionBindingRequired: z.boolean(),
});
const claimsSchema = targetSchema.extend({
  version: z.literal(1), bearerHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
});
export type AutomationExecutionTarget = z.infer<typeof targetSchema>;
const TTL_MS = 30_000;
const hash = (bearer: string) => createHash('sha256').update(bearer).digest('hex');
function mac(payload: string, secret: string): Buffer {
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('AUTOMATION_EXECUTION_SECRET_REQUIRED');
  return createHmac('sha256', secret).update('happy-automation-execution-target-v1\0').update(payload).digest();
}

export function signAutomationExecutionTarget(input: AutomationExecutionTarget & {
  bearer: string; secret: string; now: number;
}): string {
  const { bearer, secret, now, ...target } = input;
  if (!bearer) throw new Error('AUTOMATION_EXECUTION_BEARER_REQUIRED');
  const payload = Buffer.from(JSON.stringify(claimsSchema.parse({ ...target, version: 1,
    bearerHash: hash(bearer), issuedAt: now, expiresAt: now + TTL_MS }))).toString('base64url');
  return `AET1.${payload}.${mac(payload, secret).toString('base64url')}`;
}

export function verifyAutomationExecutionTarget(input: {
  token: string; expected: AutomationExecutionTarget; bearer: string; secret: string; now: number;
}): boolean {
  if (input.token.length > 8_192 || !input.bearer || !Number.isSafeInteger(input.now) || input.now < 0) return false;
  const parts = /^AET1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(input.token);
  if (!parts) return false;
  try {
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.toString('base64url') !== parts[2] || !timingSafeEqual(mac(parts[1], input.secret), signature)) return false;
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    const expected = targetSchema.parse(input.expected);
    return Object.entries(expected).every(([key, value]) => claims[key as keyof typeof expected] === value)
      && claims.bearerHash === hash(input.bearer)
      && claims.issuedAt <= input.now + 5_000 && claims.expiresAt > input.now
      && claims.expiresAt - claims.issuedAt === TTL_MS;
  } catch { return false; }
}

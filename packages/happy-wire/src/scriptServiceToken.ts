// Server-only entry point. Do not export this module from the browser wire index.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import * as z from 'zod';
const id = z.string().min(1).max(200);
const common = { projectId: id, automationId: id };
const key = { keyId: id, epoch: z.number().int().positive() };
const revision = { revision: z.number().int().positive(), generation: z.number().int().positive() };
export const scriptServiceOperationSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...common, operation: z.literal('management'), action: z.enum(['upsert', 'run', 'cancel']), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ ...common, ...key, operation: z.literal('key-sync'), revoked: z.boolean(), expiresAt: z.number().int().positive() }),
  z.strictObject({ ...common, ...key, ...revision, operation: z.literal('enqueue'), inputHash: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: id }),
  z.strictObject({ ...common, ...key, operation: z.literal('status'), runId: id }),
  z.strictObject({ ...common, operation: z.literal('execution'), runId: id, machineId: id, machineAccountId: id,
    generation: z.number().int().positive(), runAsUserId: id }),
]);
export type ScriptServiceOperation = z.infer<typeof scriptServiceOperationSchema>;
const envelopeSchema = z.strictObject({ version: z.literal(1), audience: z.literal('happy-script-service'),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), claims: scriptServiceOperationSchema });
const context = 'happy-script-service-v1\0';
function assertSecret(secret: string) {
  if (Buffer.byteLength(secret) < 32) throw new Error('SCRIPT_SERVICE_SECRET_REQUIRED');
}
function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(context).update(payload).digest('base64url');
}
export function signScriptServiceToken(input: { claims: ScriptServiceOperation; secret: string; now: number }) {
  assertSecret(input.secret);
  const value = envelopeSchema.parse({ version: 1, audience: 'happy-script-service', issuedAt: input.now, expiresAt: input.now + 30000, claims: input.claims });
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `SAS1.${payload}.${signature(payload, input.secret)}`;
}
export function verifyScriptServiceToken<T extends ScriptServiceOperation['operation']>(input: {
  token: string; operation: T; projectId: string; automationId: string; secret: string; now: number;
}): Extract<ScriptServiceOperation, { operation: T }> | null {
  assertSecret(input.secret);
  if (input.token.length > 8192) return null;
  const match = /^SAS1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(input.token);
  if (!match || !timingSafeEqual(Buffer.from(signature(match[1], input.secret)), Buffer.from(match[2]))) return null;
  try {
    const value = envelopeSchema.parse(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
    if (value.issuedAt > input.now + 5000 || value.expiresAt <= input.now || value.expiresAt <= value.issuedAt
      || value.expiresAt - value.issuedAt > 30000 || value.claims.operation !== input.operation
      || value.claims.projectId !== input.projectId || value.claims.automationId !== input.automationId) return null;
    return value.claims as Extract<ScriptServiceOperation, { operation: T }>;
  } catch { return null; }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hashScriptInput(input: Record<string, unknown>): string {
  const value = z.record(z.string(), z.json()).parse(input);
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error('INPUT_TOO_LARGE');
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Both storage services can reserve the same ID before either network write. */
export function scriptAutomationId(projectId: string, registrationKey: string): string {
  id.parse(projectId); id.parse(registrationKey);
  return `scr_${createHash('sha256').update(JSON.stringify(['script-automation-v2', projectId, registrationKey])).digest('hex')}`;
}

export function hashScriptManagementRequest(input: unknown): string {
  const value = z.json().parse(input);
  if (Buffer.byteLength(JSON.stringify(value)) > 12 * 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
  return createHash('sha256').update(canonical(value)).digest('hex');
}

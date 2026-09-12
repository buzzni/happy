import * as z from 'zod';
import { scriptEncryptedValueSchema } from './scriptCrypto';

// Separate from prompt v1 and monitor v2: older clients must reject, never strip the script action.
export const SCRIPT_AUTOMATION_PAYLOAD_VERSION = 3;
export const SCRIPT_AUTOMATION_CAPABILITY = 'script-invocations-v1';
export const SCRIPT_AUTOMATION_PROTOCOL_VERSION = 5;

const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Invalid IANA timezone');
const wallClock = {
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timezone: timezoneSchema,
  enabled: z.boolean(),
};

export const scriptScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), at: z.number().int().nonnegative().max(8.64e15), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('interval'), minutes: z.number().int().min(15).max(525600), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('daily'), ...wallClock }),
  z.strictObject({
    kind: z.literal('weekly'), ...wallClock,
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7)
      .refine((days) => new Set(days).size === days.length, 'Duplicate weekdays'),
  }),
]);
export type ScriptSchedule = z.infer<typeof scriptScheduleSchema>;

const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).refine(
  (name) => !/^(NODE_|LD_|DYLD_|HAPPY_|SAYCODE_|SCRIPT_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/.test(name)
    && !['PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV'].includes(name),
  'Reserved runtime environment variable',
);
const entrypointSchema = z.string().min(1).max(500)
  .regex(/^[A-Za-z0-9_./-]+\.(?:mjs|js)$/)
  .refine((value) => value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Invalid entrypoint');
const originSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash && url.origin === value;
}, 'Expected an HTTP(S) origin without credentials or path');

export const scriptAutomationPayloadSchema = z.strictObject({
  version: z.literal(SCRIPT_AUTOMATION_PAYLOAD_VERSION),
  name: z.string().trim().min(1).max(200),
  action: z.strictObject({
    kind: z.literal('script'), runtime: z.literal('node'),
    artifactId: z.string().min(1).max(200), digest: z.string().regex(/^[a-f0-9]{64}$/),
    entrypoint: entrypointSchema,
    args: z.array(z.string().max(4000)).max(64),
    timeoutSeconds: z.number().int().min(1).max(1800),
    secretRefs: z.record(secretName, z.string().min(1).max(200)),
    allowedOrigins: z.array(originSchema).max(100),
  }),
  schedule: scriptScheduleSchema.nullable(),
  externalEnabled: z.boolean(),
  inputSchema: z.record(z.string(), z.json()),
});
export type ScriptAutomationPayload = z.infer<typeof scriptAutomationPayloadSchema>;

export const scriptInvocationRequestSchema = z.strictObject({ input: z.record(z.string(), z.json()) });
export type ScriptInvocationRequest = z.infer<typeof scriptInvocationRequestSchema>;

export const scriptAdmissionSchema = scriptAutomationPayloadSchema.pick({
  schedule: true, externalEnabled: true, inputSchema: true,
}).extend({
  artifactId: z.string().min(1).max(200), digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const scriptRegistrationRequestSchema = z.strictObject({
  registrationKey: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(),
  paused: z.boolean(), viewerKeyVersion: z.number().int().positive(), machineKeyVersion: z.number().int().positive(),
  encrypted: scriptEncryptedValueSchema, admission: scriptAdmissionSchema,
  artifact: scriptEncryptedValueSchema.optional(),
});
export type ScriptRegistrationRequest = z.infer<typeof scriptRegistrationRequestSchema>;

const managementId = z.string().min(1).max(200);
export const scriptManagementRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('target') }),
  z.strictObject({ operation: z.literal('viewer-key'), expectedKeyVersion: z.number().int().nonnegative(), publicKey: z.string().min(1).max(100) }),
  z.strictObject({ operation: z.literal('upsert'), registration: scriptRegistrationRequestSchema }),
  z.strictObject({ operation: z.literal('runs'), automationId: managementId, runId: managementId.optional() }),
  z.strictObject({ operation: z.literal('artifact'), artifactId: managementId }),
  z.strictObject({ operation: z.literal('run'), automationId: managementId, input: z.record(z.string(), z.json()), idempotencyKey: managementId }),
  z.strictObject({ operation: z.literal('cancel'), automationId: managementId, runId: managementId }),
]);
export type ScriptManagementRequest = z.infer<typeof scriptManagementRequestSchema>;

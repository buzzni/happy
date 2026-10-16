import * as z from 'zod';
import { automationCreateRequestSchema, automationEncryptedFieldsSchema } from './automation';

const identifier = z.string().trim().min(1).max(200);
export const scheduledRegistrationKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const scheduledTaskScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interval'), minutes: z.number().int().min(15).max(525600) }),
  z.strictObject({ kind: z.literal('daily'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
]);
export const scheduledTaskToolRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('get'), automationId: identifier }),
  z.strictObject({ operation: z.literal('create'), registrationKey: scheduledRegistrationKeySchema,
    name: z.string().trim().min(1).max(200), prompt: z.string().trim().min(1).max(64000), schedule: scheduledTaskScheduleSchema }),
  z.strictObject({ operation: z.literal('set_paused'), automationId: identifier, expectedRevision: z.number().int().positive(), paused: z.boolean() }),
]);
export const scheduledTaskEncryptedCreateSchema = automationCreateRequestSchema.extend({ payloadVersion: z.literal(4), paused: z.literal(true) }).strict();
export const scheduledManagementRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('get'), automationId: identifier }),
  z.strictObject({ operation: z.literal('get_registration'), registrationKey: scheduledRegistrationKeySchema }),
  z.strictObject({ operation: z.literal('target') }),
  z.strictObject({ operation: z.literal('viewer_key'), expectedKeyVersion: z.number().int().nonnegative(), publicKey: z.string().length(44) }),
  z.strictObject({ operation: z.literal('create'), registrationKey: scheduledRegistrationKeySchema, encrypted: scheduledTaskEncryptedCreateSchema }),
  z.strictObject({ operation: z.literal('complete_registration'), registrationKey: scheduledRegistrationKeySchema, payloadCiphertext: automationEncryptedFieldsSchema.shape.payloadCiphertext }),
  z.strictObject({ operation: z.literal('set_paused'), automationId: identifier, expectedRevision: z.number().int().positive(), paused: z.boolean() }),
]);
export type ScheduledManagementRequest = z.infer<typeof scheduledManagementRequestSchema>;

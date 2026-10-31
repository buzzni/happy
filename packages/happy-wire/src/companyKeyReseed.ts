import * as z from 'zod';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary F8 — moving a strict
 * machine to a new company key (`datakey-reseed-strict-design.md` §4-3).
 *
 * A client that holds the machine key sends the security admin's signed
 * `company-data-key-generation` declaration as a bound customer-lane request.
 * The daemon checks it against the organization key it pinned, replaces its
 * machine key under the declared company key, and answers in the old machine
 * key with the new key's digest, so the client can tell the new envelope the
 * server hands it is the one the machine made.
 */
export const COMPANY_KEY_RESEED_METHOD = 'datakey:reseed';

export const companyKeyReseedCapabilitySchema = z.object({ version: z.literal(1) });
export type CompanyKeyReseedCapability = z.infer<typeof companyKeyReseedCapabilitySchema>;
export const COMPANY_KEY_RESEED_CAPABILITY: CompanyKeyReseedCapability = { version: 1 };

export const companyKeyReseedParamsSchema = z.object({
  companyId: z.string().min(1).max(512),
  /** The signed declaration document, as JSON. */
  declaration: z.string().min(1).max(70_000),
}).strict();
export type CompanyKeyReseedParams = z.infer<typeof companyKeyReseedParamsSchema>;

export const companyKeyReseedResultSchema = z.object({
  /** False when the machine already used the declared key. */
  changed: z.boolean(),
  generation: z.number().int().positive(),
  /** `machineKeyDigest(machineId, machineKey)` of the key the machine now uses, base64. */
  machineKeyDigest: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
}).strict();
export type CompanyKeyReseedResult = z.infer<typeof companyKeyReseedResultSchema>;

export const COMPANY_KEY_RESEED_ERROR_CODES = [
  'INVALID_PARAMS',
  'DEVICE_APPROVAL_REQUIRED',
  'INVALID_DECLARATION',
  'CONTEXT_MISMATCH',
  'NOT_STRICT',
  'STALE_GENERATION',
  'BUSY',
  'NO_SERVER_ENVELOPE',
  'ENVELOPE_CHANGED',
  'RESEED_FAILED',
] as const;
export type CompanyKeyReseedErrorCode = typeof COMPANY_KEY_RESEED_ERROR_CODES[number];

export type CompanyKeyReseedAnswer =
  | { success: true; result: CompanyKeyReseedResult }
  | { success: false; errorCode: CompanyKeyReseedErrorCode; error: string };

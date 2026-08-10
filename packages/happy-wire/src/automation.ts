import * as z from 'zod';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PAYLOAD_MAX_BYTES = 128 * 1024;
const ENVELOPE_BYTES = 105;

function decodedBase64Length(value: string): number {
  return Math.floor(value.length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

function firstBase64Byte(value: string): number {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return (alphabet.indexOf(value[0]!) << 2) | (alphabet.indexOf(value[1]!) >> 4);
}

function base64Schema(maxBytes: number, options: { minBytes?: number; exactBytes?: number; version?: number } = {}) {
  return z.string().min(1).regex(BASE64_PATTERN).refine(
    (value) => {
      const length = decodedBase64Length(value);
      return length <= maxBytes
        && length >= (options.minBytes ?? 0)
        && (options.exactBytes === undefined || length === options.exactBytes)
        && (options.version === undefined || firstBase64Byte(value) === options.version);
    },
    'invalid encoded value',
  );
}

const positiveInteger = z.number().int().min(1);
const timestamp = z.number().int().min(0);
const publicKeySchema = base64Schema(32, { exactBytes: 32 });
const payloadCiphertextSchema = base64Schema(PAYLOAD_MAX_BYTES, { minBytes: 41, version: 1 });
const envelopeSchema = base64Schema(ENVELOPE_BYTES, { exactBytes: ENVELOPE_BYTES, version: 1 });

export const automationAgentSchema = z.enum(['claude', 'codex', 'gemini', 'openclaw', 'opencode']);
export type AutomationAgent = z.infer<typeof automationAgentSchema>;

export const automationScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(15) }),
  z.object({
    kind: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

export const automationPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  schedule: automationScheduleSchema,
  prompt: z.string().trim().min(1).max(64_000),
  directory: z.string().trim().min(1).max(1_000),
  scriptCommand: z.string().trim().min(1).max(8_000).nullable(),
  suppressSilent: z.boolean(),
  agent: automationAgentSchema.nullable(),
});
export type AutomationPayload = z.infer<typeof automationPayloadSchema>;

export const automationPublicSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerAccountId: z.string().min(1),
  machineAccountId: z.string().min(1).nullable(),
  machineId: z.string().min(1).nullable(),
  revision: positiveInteger,
  generation: positiveInteger,
  payloadVersion: z.literal(1),
  payloadCiphertext: payloadCiphertextSchema,
  viewerKeyId: z.string().min(1).max(128),
  viewerKeyVersion: positiveInteger,
  viewerKeyEnvelope: envelopeSchema,
  machineKeyVersion: positiveInteger,
  paused: z.boolean(),
  enabledAt: timestamp,
  appliedRevision: z.number().int().min(0),
  appliedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AutomationPublic = z.infer<typeof automationPublicSchema>;

export const automationTargetSchema = z.object({
  machineAccountId: z.string().min(1),
  machineId: z.string().min(1),
  machinePublicKey: publicKeySchema,
  machineKeyVersion: positiveInteger,
  viewerPublicKey: publicKeySchema.nullable(),
  viewerKeyVersion: z.number().int().min(0),
});
export type AutomationTarget = z.infer<typeof automationTargetSchema>;

export const automationRunStatusSchema = z.enum([
  'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED',
]);
export const automationRunOutcomeSchema = z.enum(['WOKE', 'SILENT', 'SKIPPED_GATE', 'ERROR']);
export const automationRunSchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  generation: positiveInteger,
  scheduledFor: timestamp,
  machineId: z.string().min(1),
  status: automationRunStatusSchema,
  sessionId: z.string().min(1).nullable(),
  outcome: automationRunOutcomeSchema.nullable(),
  detailCiphertext: base64Schema(PAYLOAD_MAX_BYTES).nullable(),
  claimedAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  lateReport: z.boolean(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationEncryptedFieldsSchema = z.object({
  payloadVersion: z.literal(1),
  payloadCiphertext: payloadCiphertextSchema,
  viewerKeyId: z.string().min(1).max(128),
  viewerKeyVersion: positiveInteger,
  viewerKeyEnvelope: envelopeSchema,
  machineKeyVersion: positiveInteger,
  machineKeyEnvelope: envelopeSchema,
});
export type AutomationEncryptedFields = z.infer<typeof automationEncryptedFieldsSchema>;

export const automationCreateRequestSchema = automationEncryptedFieldsSchema.extend({ paused: z.boolean().default(false) });
export type AutomationCreateRequest = z.input<typeof automationCreateRequestSchema>;

export const automationUpdateRequestSchema = z.object({
  expectedRevision: positiveInteger,
  paused: z.boolean().optional(),
  payloadVersion: z.literal(1).optional(),
  payloadCiphertext: payloadCiphertextSchema.optional(),
  viewerKeyId: z.string().min(1).max(128).optional(),
  viewerKeyVersion: positiveInteger.optional(),
  viewerKeyEnvelope: envelopeSchema.optional(),
  machineKeyVersion: positiveInteger.optional(),
  machineKeyEnvelope: envelopeSchema.optional(),
}).superRefine((value, ctx) => {
  const encryptedKeys = [
    'payloadVersion', 'payloadCiphertext', 'viewerKeyId', 'viewerKeyVersion',
    'viewerKeyEnvelope', 'machineKeyVersion', 'machineKeyEnvelope',
  ] as const;
  const present = encryptedKeys.filter((key) => value[key] !== undefined).length;
  if (present === 0 && value.paused === undefined) {
    ctx.addIssue({ code: 'custom', message: 'patch must change paused or encrypted payload' });
  }
  if (present !== 0 && present !== encryptedKeys.length) {
    ctx.addIssue({ code: 'custom', message: 'encrypted payload fields must be replaced together' });
  }
});
export type AutomationUpdateRequest = z.infer<typeof automationUpdateRequestSchema>;

export const automationDeleteRequestSchema = z.object({ expectedRevision: positiveInteger });
export const automationViewerKeyRequestSchema = z.object({
  expectedKeyVersion: z.number().int().min(0),
  publicKey: publicKeySchema,
});

export interface AutomationCryptoAdapter {
  randomBytes(length: number): Uint8Array;
  secretBoxSeal(plaintext: Uint8Array, key: Uint8Array): Uint8Array;
  secretBoxOpen(bundle: Uint8Array, key: Uint8Array): Uint8Array | null;
  boxSeal(plaintext: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array;
  boxOpen(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null;
  sha256(value: Uint8Array): Promise<Uint8Array>;
  encodeBase64(value: Uint8Array, urlSafe?: boolean): string;
  decodeBase64(value: string): Uint8Array;
}

function versioned(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value.length + 1);
  result[0] = 1;
  result.set(value, 1);
  return result;
}

function openVersioned(value: string, crypto: AutomationCryptoAdapter, exactLength?: number): Uint8Array {
  const decoded = crypto.decodeBase64(value);
  if (decoded[0] !== 1 || (exactLength !== undefined && decoded.length !== exactLength)) {
    throw new Error('automation-decrypt-failed');
  }
  return decoded.slice(1);
}

export async function encryptAutomationPayload(input: {
  payload: AutomationPayload;
  viewer: { publicKey: Uint8Array; keyVersion: number };
  machine: { publicKey: Uint8Array; keyVersion: number };
  crypto: AutomationCryptoAdapter;
}): Promise<AutomationEncryptedFields> {
  const payload = automationPayloadSchema.parse(input.payload);
  if (input.viewer.publicKey.length !== 32 || input.machine.publicKey.length !== 32) {
    throw new Error('automation-encrypt-failed');
  }
  const dek = input.crypto.randomBytes(32);
  if (dek.length !== 32) throw new Error('automation-encrypt-failed');
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const result = {
    payloadVersion: 1 as const,
    payloadCiphertext: input.crypto.encodeBase64(versioned(input.crypto.secretBoxSeal(plaintext, dek))),
    viewerKeyId: input.crypto.encodeBase64(await input.crypto.sha256(input.viewer.publicKey), true),
    viewerKeyVersion: input.viewer.keyVersion,
    viewerKeyEnvelope: input.crypto.encodeBase64(versioned(input.crypto.boxSeal(dek, input.viewer.publicKey))),
    machineKeyVersion: input.machine.keyVersion,
    machineKeyEnvelope: input.crypto.encodeBase64(versioned(input.crypto.boxSeal(dek, input.machine.publicKey))),
  };
  return automationEncryptedFieldsSchema.parse(result);
}

export async function decryptAutomationPayload(input: {
  payloadVersion: 1;
  payloadCiphertext: string;
  keyEnvelope: string;
  recipientSecretKey: Uint8Array;
  crypto: AutomationCryptoAdapter;
}): Promise<AutomationPayload> {
  try {
    if (input.payloadVersion !== 1 || input.recipientSecretKey.length !== 32) throw new Error();
    const encryptedDek = openVersioned(input.keyEnvelope, input.crypto, ENVELOPE_BYTES);
    const dek = input.crypto.boxOpen(encryptedDek, input.recipientSecretKey);
    if (!dek || dek.length !== 32) throw new Error();
    const encryptedPayload = openVersioned(input.payloadCiphertext, input.crypto);
    const plaintext = input.crypto.secretBoxOpen(encryptedPayload, dek);
    if (!plaintext) throw new Error();
    return automationPayloadSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error('automation-decrypt-failed');
  }
}

export class AutomationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly latest: AutomationPublic | null = null,
  ) {
    super(code);
    this.name = 'AutomationApiError';
  }
}

export interface AutomationFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type AutomationFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<AutomationFetchResponse>;

export interface AutomationApiClient {
  getTarget(projectId: string): Promise<AutomationTarget>;
  setViewerKey(projectId: string, input: z.infer<typeof automationViewerKeyRequestSchema>): Promise<{ keyVersion: number }>;
  listAutomations(projectId: string): Promise<AutomationPublic[]>;
  createAutomation(projectId: string, input: AutomationCreateRequest): Promise<AutomationPublic>;
  updateAutomation(projectId: string, automationId: string, input: AutomationUpdateRequest): Promise<AutomationPublic>;
  deleteAutomation(projectId: string, automationId: string, expectedRevision: number): Promise<AutomationPublic>;
  listRuns(projectId: string, input?: { automationId?: string; limit?: number }): Promise<AutomationRun[]>;
}

function pathId(value: string): string {
  return encodeURIComponent(value);
}

export function createAutomationApiClient(options: {
  baseUrl: string;
  token: string;
  fetch: AutomationFetch;
}): AutomationApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
    const response = await options.fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) {
      const parsed = z.object({
        error: z.string().min(1),
        latest: automationPublicSchema.optional(),
      }).safeParse(value);
      throw new AutomationApiError(
        response.status,
        parsed.success ? parsed.data.error : 'automation-request-failed',
        parsed.success ? parsed.data.latest ?? null : null,
      );
    }
    return schema.parse(value);
  }

  const automationPath = (projectId: string) => `/v1/projects/${pathId(projectId)}/automations`;
  return {
    async getTarget(projectId) {
      const value = await request(`/v1/projects/${pathId(projectId)}/automation-target`, z.object({ target: automationTargetSchema }));
      return value.target;
    },
    async setViewerKey(projectId, input) {
      return request(
        `/v1/projects/${pathId(projectId)}/automation-viewer-key`,
        z.object({ keyVersion: positiveInteger }),
        'PUT',
        automationViewerKeyRequestSchema.parse(input),
      );
    },
    async listAutomations(projectId) {
      const value = await request(automationPath(projectId), z.object({ automations: z.array(automationPublicSchema) }));
      return value.automations;
    },
    async createAutomation(projectId, input) {
      const value = await request(
        automationPath(projectId),
        z.object({ automation: automationPublicSchema }),
        'POST',
        automationCreateRequestSchema.parse(input),
      );
      return value.automation;
    },
    async updateAutomation(projectId, automationId, input) {
      const value = await request(
        `${automationPath(projectId)}/${pathId(automationId)}`,
        z.object({ automation: automationPublicSchema }),
        'PATCH',
        automationUpdateRequestSchema.parse(input),
      );
      return value.automation;
    },
    async deleteAutomation(projectId, automationId, expectedRevision) {
      const body = automationDeleteRequestSchema.parse({ expectedRevision });
      const value = await request(
        `${automationPath(projectId)}/${pathId(automationId)}`,
        z.object({ automation: automationPublicSchema }),
        'DELETE',
        body,
      );
      return value.automation;
    },
    async listRuns(projectId, input = {}) {
      const query = new URLSearchParams();
      if (input.automationId) query.set('automationId', input.automationId);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const value = await request(
        `/v1/projects/${pathId(projectId)}/automation-runs${suffix}`,
        z.object({ runs: z.array(automationRunSchema) }),
      );
      return value.runs;
    },
  };
}

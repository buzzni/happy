import { z } from 'zod';
import nacl from 'tweetnacl';
import { canonicalOrgSetupTokenJson, parseCanonicalOrgSetupTokenJson } from './orgSetupTokenApproval';
export { default as sharedMachineRotationFixture } from './fixtures/sharedMachineRotation.v1.json';

const encoder = new TextEncoder();
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).refine(v => !Object.is(v, -0));
const positive = integer.refine(v => v > 0);
const id = z.string().min(1).max(128).regex(/^[^\s\u0000-\u001f\u007f-\u009f]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RotationOriginSchema = z.string().max(512).refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
});
export function rotationBase64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function rotationDecodeBinary(value: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length !== Math.ceil(length * 4 / 3)) throw new Error('Invalid binary encoding');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (bytes.length !== length || rotationBase64url(bytes) !== value) throw new Error('Noncanonical binary');
  return bytes;
}
const binary = (length: number) => z.string().refine(v => {
  try { rotationDecodeBinary(v, length); return true; } catch { return false; }
});
const times = { issuedAt: integer, expiresAt: integer };
const lifetime = (v: { issuedAt: number; expiresAt: number }) => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 60000;
const identity = { companyId: id, machineId: id, approvalId: id, deviceKeyId: hash, launchId: id };
export const MachineSetupTokenBindingV2Schema = z.object({
  version: z.literal(2), type: z.literal('claude-setup-token-binding'), audience: z.literal('saycode-daemon'),
  principalType: z.literal('machine'), ...identity, groupScope: id, assignmentGeneration: positive,
  assignmentFingerprint: hash, managedAccountId: id, credentialGeneration: positive, bindingRevision: positive,
  nonce: binary(32), previousNonce: binary(32).nullable(), keyId: hash, ...times,
}).strict().refine(lifetime).refine(v => (v.bindingRevision === 1) === (v.previousNonce === null));
export type MachineSetupTokenBindingV2 = z.infer<typeof MachineSetupTokenBindingV2Schema>;

export const SetupTokenActivitySchema = z.object({ instanceId: id, turnId: id, seq: positive, state: z.enum(['active', 'finished']) }).strict();
export type SetupTokenActivity = z.infer<typeof SetupTokenActivitySchema>;
export const RotationObservationSchema = z.object({
  observationId: id, observedAt: integer, managedAccountId: id, credentialGeneration: positive,
  windows: z.array(z.object({ kind: z.enum(['five_hour', 'seven_day']), utilizationBps: integer.refine(v => v <= 10000), resetsAt: integer.nullable() }).strict()).max(2),
  accountWideRefusal: z.enum(['account_limit', 'authentication_failed']).nullable(),
}).strict().refine(v => new Set(v.windows.map(w => w.kind)).size === v.windows.length)
  .refine(v => v.windows.length > 0 || v.accountWideRefusal !== null);
export type RotationObservation = z.infer<typeof RotationObservationSchema>;
export const DAEMON_ROTATION_PATHS = {
  issue: '/api/claude-setup-token/daemon/v2/issue', claim: '/api/claude-setup-token/daemon/v2/claim',
  start: '/api/claude-setup-token/daemon/v2/start', commit: '/api/claude-setup-token/daemon/v2/commit', usage: '/api/claude-setup-token/daemon/v2/usage',
  rebind: '/api/claude-setup-token/daemon/v2/rebind', operation: '/api/claude-setup-token/daemon/v2/operation',
} as const;
const requestCommon = { version: z.literal(2), type: z.literal('setup-token-daemon-request'),
  audience: RotationOriginSchema, method: z.literal('POST'), ...identity, operationId: id, ...times };
const claim = { sessionId: id, nonce: binary(32), bindingRevision: positive };
const hashes = { sessionTagHash: hash, sessionCreateBodyHash: hash };
export const DaemonRotationRequestBodySchema = z.discriminatedUnion('action', [
  z.object({ ...requestCommon, action: z.literal('issue'), path: z.literal(DAEMON_ROTATION_PATHS.issue), sessionOwnerAccountId: id, ...hashes }).strict(),
  z.object({ ...requestCommon, action: z.literal('claim'), path: z.literal(DAEMON_ROTATION_PATHS.claim), ...claim }).strict(),
  z.object({ ...requestCommon, action: z.literal('commit'), path: z.literal(DAEMON_ROTATION_PATHS.commit), ...claim, bindingDigest: hash }).strict(),
  z.object({ ...requestCommon, action: z.literal('start'), path: z.literal(DAEMON_ROTATION_PATHS.start), ...claim, requestId: id }).strict(),
  z.object({ ...requestCommon, action: z.literal('usage'), path: z.literal(DAEMON_ROTATION_PATHS.usage), ...claim, observation: RotationObservationSchema.optional(), activity: SetupTokenActivitySchema.optional() }).strict(),
  z.object({ ...requestCommon, action: z.literal('rebind'), path: z.literal(DAEMON_ROTATION_PATHS.rebind), ...claim, observation: RotationObservationSchema }).strict(),
  z.object({ ...requestCommon, action: z.literal('operation'), path: z.literal(DAEMON_ROTATION_PATHS.operation), targetOperationId: id }).strict(),
]).refine(lifetime).refine(v => v.action !== 'usage' || !!v.observation !== !!v.activity);
export type DaemonRotationRequestBody = z.infer<typeof DaemonRotationRequestBodySchema>;

export const SessionExecutionTicketBodySchema = z.object({
  version: z.literal(1), type: z.literal('saycode-session-execution'), audience: RotationOriginSchema,
  studioOrigin: RotationOriginSchema, keyId: hash, ...identity, machineOwnerAccountId: id, sessionOwnerAccountId: id,
  initialNonce: binary(32), operationId: id, deviceSigningPublicKey: binary(32), ...hashes, ...times,
}).strict().refine(lifetime);
export type SessionExecutionTicketBody = z.infer<typeof SessionExecutionTicketBodySchema>;
export const HappySessionCreateProofBodySchema = z.object({
  version: z.literal(1), type: z.literal('happy-session-create-proof'), audience: RotationOriginSchema,
  method: z.literal('POST'), path: z.literal('/v1/sessions'), ticketDigest: hash,
  sessionOwnerAccountId: id, ...hashes, ...times,
}).strict().refine(lifetime);
export type HappySessionCreateProofBody = z.infer<typeof HappySessionCreateProofBodySchema>;
const bodySchema = z.union([MachineSetupTokenBindingV2Schema, DaemonRotationRequestBodySchema, SessionExecutionTicketBodySchema, HappySessionCreateProofBodySchema]);
export type RotationSignedBody = z.infer<typeof bodySchema>;
export const MachineSetupTokenBindingV2DocumentSchema = z.object({ body: MachineSetupTokenBindingV2Schema, signature: binary(64) }).strict();
export const DaemonRotationRequestSchema = z.object({ body: DaemonRotationRequestBodySchema, signature: binary(64) }).strict();
export const SessionExecutionTicketSchema = z.object({ body: SessionExecutionTicketBodySchema, signature: binary(64) }).strict();
export const SignedHappySessionCreateProofSchema = z.object({ body: HappySessionCreateProofBodySchema, signature: binary(64) }).strict();
export const HappySessionExecutionProofSchema = z.object({ ticket: SessionExecutionTicketSchema, deviceProof: SignedHappySessionCreateProofSchema }).strict();
export type HappySessionExecutionProof = z.infer<typeof HappySessionExecutionProofSchema>;
export type SessionExecutionTicket = z.infer<typeof SessionExecutionTicketSchema>;
export type DaemonRotationRequest = z.infer<typeof DaemonRotationRequestSchema>;
export type MachineSetupTokenBindingV2Document = z.infer<typeof MachineSetupTokenBindingV2DocumentSchema>;
export const SessionExecutionCreateBodySchema = z.object({
  tag: z.string().min(1).max(1024), metadata: z.string().max(60000),
  agentState: z.string().max(60000).nullable().optional(), dataEncryptionKey: z.string().max(1024).nullable().optional(),
}).strict();
export type SessionExecutionCreateBody = z.infer<typeof SessionExecutionCreateBodySchema>;
export const HappySessionCreateRequestSchema = SessionExecutionCreateBodySchema.extend({ executionProof: HappySessionExecutionProofSchema });
export type HappySessionCreateRequest = z.infer<typeof HappySessionCreateRequestSchema>;
export const ExecutionOwnerRequestSchema = z.object({ companyId: id, machineId: id, launchId: id, initialNonce: binary(32) }).strict();
export const ExecutionOwnerResponseSchema = z.object({ owner: z.object({
  companyId: id, machineId: id, sessionId: id, launchId: id, initialNonce: binary(32),
  machineOwnerAccountId: id, sessionOwnerAccountId: id,
}).strict().nullable() }).strict();

export async function rotationSha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const rotationDigest = (value: unknown): Promise<string> => rotationSha256(encoder.encode(canonicalOrgSetupTokenJson(value)));
export const sessionTagHash = (tag: string): Promise<string> => {
  canonicalOrgSetupTokenJson(tag); // Reject invalid Unicode before UTF-8 replacement.
  return rotationSha256(encoder.encode(tag));
};
export const sessionCreateBodyHash = (value: unknown): Promise<string> => {
  canonicalOrgSetupTokenJson(value);
  return rotationDigest(SessionExecutionCreateBodySchema.parse(value));
};
export function rotationSigningBytes(value: unknown): Uint8Array {
  canonicalOrgSetupTokenJson(value);
  const body = bodySchema.parse(value);
  return encoder.encode(`saycode/${body.type}/v${body.version}\n${canonicalOrgSetupTokenJson(body)}`);
}
export function rotationIsFresh(body: { issuedAt: number; expiresAt: number }, now: number): boolean {
  return [body.issuedAt, body.expiresAt, now].every(v => Number.isSafeInteger(v) && v >= 0) &&
    lifetime(body) && body.issuedAt <= now + 60000 && now < body.expiresAt;
}
export async function daemonRotationOperationDigest(value: DaemonRotationRequestBody): Promise<string> {
  const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...stable } = DaemonRotationRequestBodySchema.parse(value);
  return rotationDigest(stable);
}
const documentSchema = z.object({ body: bodySchema, signature: binary(64) }).strict();
export function parseRotationDocument(json: string): z.infer<typeof documentSchema> {
  return documentSchema.parse(parseCanonicalOrgSetupTokenJson(json));
}
export async function signRotationDocument<T extends RotationSignedBody>(body: T, secretKey: Uint8Array): Promise<{ body: T; signature: string }> {
  const bytes = rotationSigningBytes(body);
  if (secretKey.length !== 64) throw new Error('Invalid secret key');
  const pair = nacl.sign.keyPair.fromSeed(secretKey.slice(0, 32));
  try {
    if (!nacl.verify(pair.secretKey, secretKey)) throw new Error('Inconsistent secret key');
    return { body, signature: rotationBase64url(nacl.sign.detached(bytes, pair.secretKey)) };
  } finally { pair.secretKey.fill(0); }
}
/** Authenticity only. The caller MUST pin trust and check type, audience, freshness and authorization. */
export async function verifyRotationDocument(value: unknown, publicKey: Uint8Array): Promise<z.infer<typeof documentSchema>> {
  canonicalOrgSetupTokenJson(value);
  const document = documentSchema.parse(value);
  if (publicKey.length !== 32 || !nacl.sign.detached.verify(rotationSigningBytes(document.body), rotationDecodeBinary(document.signature, 64), publicKey)) throw new Error('Invalid signature');
  return document;
}

import nacl from 'tweetnacl';
import { z } from 'zod';
export { default as orgSetupTokenApprovalV1Fixture } from './fixtures/orgSetupTokenApproval.v1.json';

const MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const badUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function bounded(text: string): string {
  if (encoder.encode(text).length > MAX_BYTES) throw new Error('Org setup-token document too large');
  return text;
}

/** UTF-16 key ordering; build JSON directly so integer-like keys cannot be reordered by JSON.stringify. */
export function canonicalOrgSetupTokenJson(value: unknown): string {
  function encode(current: unknown, depth: number): string {
    if (depth > 64) throw new Error('Org setup-token document too deep');
    if (current === null) return 'null';
    if (typeof current === 'string') {
      if (badUnicode.test(current)) throw new Error('Invalid Unicode');
      return bounded(JSON.stringify(current));
    }
    if (typeof current === 'boolean') return String(current);
    if (typeof current === 'number' && Number.isSafeInteger(current) && current >= 0 && !Object.is(current, -0)) return String(current);
    if (Array.isArray(current)) {
      // Sparse arrays are not JSON values; map/join would otherwise silently emit holes.
      return bounded('[' + Array.from(current, entry => encode(entry, depth + 1)).join(',') + ']');
    }
    if (typeof current === 'object' && current && [Object.prototype, null].includes(Object.getPrototypeOf(current))) {
      if (Object.getOwnPropertySymbols(current).length) throw new Error('Invalid JSON key');
      return bounded('{' + Object.keys(current).sort().map(key => encode(key, depth + 1) + ':' + encode((current as Record<string, unknown>)[key], depth + 1)).join(',') + '}');
    }
    throw new Error('Invalid canonical JSON value');
  }
  return encode(value, 0);
}

/** JSON.parse alone silently accepts repeated keys, including escaped aliases. Scan before parsing. */
function parseUniqueJson(text: string): unknown {
  bounded(text);
  let offset = 0;
  function whitespace() { while (/[\x20\t\r\n]/.test(text[offset] ?? '') && offset < text.length) offset++; }
  function string(): string {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '\\') offset++;
      else if (char === '"') return JSON.parse(text.slice(start, offset));
    }
    throw new Error('Invalid JSON string');
  }
  function value(depth: number): void {
    if (depth > 64) throw new Error('Org setup-token document too deep');
    whitespace();
    const char = text[offset];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      offset++;
      whitespace();
      const end = char === '{' ? '}' : ']';
      const keys = new Set<string>();
      if (text[offset] === end) { offset++; return; }
      while (offset < text.length) {
        whitespace();
        if (char === '{') {
          if (text[offset] !== '"') throw new Error('Invalid JSON key');
          const key = string();
          if (keys.has(key)) throw new Error('Duplicate JSON key');
          keys.add(key); whitespace();
          if (text[offset++] !== ':') throw new Error('Invalid JSON object');
        }
        value(depth + 1); whitespace();
        if (text[offset] === end) { offset++; return; }
        if (text[offset++] !== ',') throw new Error('Invalid JSON delimiter');
      }
      throw new Error('Unterminated JSON');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset));
    if (!token) throw new Error('Invalid JSON value');
    offset += token[0].length;
  }
  value(0); whitespace();
  if (offset !== text.length) throw new Error('Trailing JSON input');
  const parsed: unknown = JSON.parse(text);
  canonicalOrgSetupTokenJson(parsed);
  return parsed;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBinary(value: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  if (bytes.length !== length || base64url(bytes) !== value) throw new Error('Noncanonical binary');
  return bytes;
}
const binary = (length: number) => z.string().refine(value => { try { decodeBinary(value, length); return true; } catch { return false; } });
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).refine(value => !Object.is(value, -0));
const positive = integer.refine(value => value > 0);
const id = z.string().min(1).refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !badUnicode.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ownership = { machineId: id, machineType: z.enum(['dedicated', 'shared']), ownerUserId: id.nullable() };
const owns = (value: { machineType: string; ownerUserId: string | null }) => value.machineType === 'dedicated' ? value.ownerUserId !== null : value.ownerUserId === null;
const common = { version: z.literal(1), companyId: id, signingGeneration: positive, signingKeyId: digest, issuedAt: integer };
const approval = z.object({ ...common, kind: z.literal('device-approval'), approvalId: id, approvalRevision: positive,
  ...ownership, deviceSigningPublicKey: binary(32), recipientPublicKey: binary(32), enrollmentDigest: digest }).strict().refine(owns);
const assignment = z.object({ ...common, kind: z.literal('ai-assignment'), bindingId: id, assignmentRevision: positive,
  credentialGroupId: id, credentialGroupRevision: positive, target: z.object({ kind: z.enum(['user-group', 'machine']), id }).strict(),
  accounts: z.array(z.object({ managedAccountId: id, credentialGeneration: positive, credentialDigest: digest }).strict()),
}).strict().refine(value => value.accounts.every((account, index) => index === 0 || value.accounts[index - 1].managedAccountId < account.managedAccountId));
const revocation = z.object({ ...common, kind: z.literal('device-revocation'), approvalId: id, approvalRevision: positive,
  machineId: id, recipientKeyId: digest }).strict();
const rotation = z.object({ ...common, kind: z.literal('org-signing-rotation'), nextGeneration: positive,
  nextPublicKey: binary(32), nextKeyId: digest }).strict().refine(value => value.nextGeneration === value.signingGeneration + 1);
const bodySchema = z.union([approval, assignment, revocation, rotation]);
const documentSchema = z.object({ body: bodySchema, signature: binary(64) }).strict();
const enrollmentSchema = z.object({ version: z.literal(1), companyId: id, ...ownership,
  deviceSigningPublicKey: binary(32), recipientPublicKey: binary(32), orgSigningPublicKey: binary(32),
  signingGeneration: positive, enrollmentNonce: binary(32), expiresAt: integer }).strict().refine(owns);
export type OrgSetupTokenBody = z.infer<typeof bodySchema>;
export type OrgSetupTokenDocument = z.infer<typeof documentSchema>;
export type OrgDeviceEnrollmentTranscript = z.infer<typeof enrollmentSchema>;

export function parseOrgSetupTokenDocument(json: string): OrgSetupTokenDocument {
  return documentSchema.parse(parseUniqueJson(json));
}
export function orgSetupTokenSigningBytes(value: unknown): Uint8Array {
  // Validate original input first: schema parsing must not hide malformed values by stripping them.
  canonicalOrgSetupTokenJson(value);
  const body = bodySchema.parse(value);
  return encoder.encode(bounded(`saycode/${body.kind}/v1\n${canonicalOrgSetupTokenJson(body)}`));
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function orgSetupTokenKeyId(publicKey: Uint8Array): Promise<string> {
  if (publicKey.length !== 32) throw new Error('Invalid public key length');
  return sha256(publicKey);
}
async function checkKeyIds(body: OrgSetupTokenBody, publicKey: Uint8Array): Promise<void> {
  if (body.signingKeyId !== await orgSetupTokenKeyId(publicKey)) throw new Error('Signing key mismatch');
  if (body.kind === 'org-signing-rotation' && body.nextKeyId !== await orgSetupTokenKeyId(decodeBinary(body.nextPublicKey, 32))) throw new Error('Next signing key mismatch');
}
export async function signOrgSetupTokenDocument(value: unknown, secretKey: Uint8Array): Promise<OrgSetupTokenDocument> {
  const bytes = orgSetupTokenSigningBytes(value);
  const body = bodySchema.parse(value);
  // Derive from seed, not the untrusted public-key suffix of an Ed25519 secret key.
  if (secretKey.length !== 64) throw new Error('Invalid signing secret key');
  const pair = nacl.sign.keyPair.fromSeed(secretKey.slice(0, 32));
  try {
    if (!nacl.verify(pair.secretKey, secretKey)) throw new Error('Inconsistent signing key');
    await checkKeyIds(body, pair.publicKey);
    const document = { body, signature: base64url(nacl.sign.detached(bytes, pair.secretKey)) };
    bounded(canonicalOrgSetupTokenJson(document));
    return document;
  } finally { pair.secretKey.fill(0); }
}
/** Authenticity only: callers still enforce pinned trust, scope, freshness, revision and revocation. */
export async function verifyOrgSetupTokenDocument(json: string, publicKey: Uint8Array): Promise<OrgSetupTokenDocument> {
  const document = parseOrgSetupTokenDocument(json);
  await checkKeyIds(document.body, publicKey);
  if (!nacl.sign.detached.verify(orgSetupTokenSigningBytes(document.body), decodeBinary(document.signature, 64), publicKey)) throw new Error('Invalid signature');
  return document;
}
export async function orgDeviceEnrollmentDigest(value: unknown): Promise<string> {
  canonicalOrgSetupTokenJson(value);
  const transcript = enrollmentSchema.parse(value);
  return sha256(encoder.encode(bounded(`saycode/device-enrollment/v1\n${canonicalOrgSetupTokenJson(transcript)}`)));
}

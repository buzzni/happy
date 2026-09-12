import nacl from 'tweetnacl';
import * as z from 'zod';

function isBase64(value: string) {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  for (let index = value.length - padding; index < value.length; index++) if (value.charCodeAt(index) !== 61) return false;
  return value.length > padding;
}
const base64 = z.string().min(1).max(6 * 1024 * 1024).refine(isBase64);
export const scriptEncryptedValueSchema = z.strictObject({
  version: z.literal(2), ciphertext: base64,
  viewerKeyEnvelope: base64.max(140), machineKeyEnvelope: base64.max(140),
});
export type ScriptEncryptedValue = z.infer<typeof scriptEncryptedValueSchema>;
const contextSchema = z.strictObject({
  projectId: z.string().min(1).max(200), resourceId: z.string().min(1).max(200),
  purpose: z.enum(['artifact', 'configuration', 'input', 'log']),
});
export type ScriptCryptoContext = z.infer<typeof contextSchema>;
const encode = (bytes: Uint8Array) => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
function sealKey(key: Uint8Array, publicKey: Uint8Array) {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  try { return encode(concat(new Uint8Array([2]), ephemeral.publicKey, nonce, nacl.box(key, nonce, publicKey, ephemeral.secretKey))); }
  finally { ephemeral.secretKey.fill(0); }
}

export function encryptScriptValue(input: {
  value: unknown; context: ScriptCryptoContext; viewerPublicKey: Uint8Array; machinePublicKey: Uint8Array;
}): ScriptEncryptedValue {
  const context = contextSchema.parse(input.context);
  const value = z.json().parse(input.value);
  const plaintext = new Uint8Array(new TextEncoder().encode(JSON.stringify({ context, value })));
  if (plaintext.length > 4 * 1024 * 1024) throw new Error('SCRIPT_VALUE_TOO_LARGE');
  const key = nacl.randomBytes(32);
  const nonce = nacl.randomBytes(24);
  try {
    return {
      version: 2,
      ciphertext: encode(concat(new Uint8Array([2]), nonce, nacl.secretbox(plaintext, nonce, key))),
      viewerKeyEnvelope: sealKey(key, input.viewerPublicKey), machineKeyEnvelope: sealKey(key, input.machinePublicKey),
    };
  } finally { key.fill(0); }
}

export function decryptScriptValue(input: {
  encrypted: ScriptEncryptedValue; context: ScriptCryptoContext; recipient: 'viewer' | 'machine'; secretKey: Uint8Array;
}): unknown {
  let key: Uint8Array | null = null;
  try {
    const encrypted = scriptEncryptedValueSchema.parse(input.encrypted);
    const context = contextSchema.parse(input.context);
    const envelope = decode(input.recipient === 'viewer' ? encrypted.viewerKeyEnvelope : encrypted.machineKeyEnvelope);
    if (envelope.length !== 105 || envelope[0] !== 2) throw new Error();
    key = nacl.box.open(envelope.subarray(57), envelope.subarray(33, 57), envelope.subarray(1, 33), input.secretKey);
    if (!key || key.length !== 32) throw new Error();
    const bundle = decode(encrypted.ciphertext);
    if (bundle[0] !== 2 || bundle.length < 41) throw new Error();
    const plaintext = nacl.secretbox.open(bundle.subarray(25), bundle.subarray(1, 25), key);
    if (!plaintext) throw new Error();
    const decoded = z.strictObject({ context: contextSchema, value: z.json() }).parse(JSON.parse(new TextDecoder().decode(plaintext)));
    if (decoded.context.projectId !== context.projectId || decoded.context.resourceId !== context.resourceId || decoded.context.purpose !== context.purpose) throw new Error();
    return decoded.value;
  } catch { throw new Error('SCRIPT_DECRYPT_FAILED'); }
  finally { key?.fill(0); }
}

import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { encryptScriptValue, decryptScriptValue } from './scriptCrypto';

const context = { projectId: 'p1', resourceId: 'artifact-1', purpose: 'artifact' as const };
describe('script encrypted values', () => {
  it('lets viewer and machine decrypt the same authenticated value', () => {
    const viewer = nacl.box.keyPair(); const machine = nacl.box.keyPair();
    const encrypted = encryptScriptValue({ value: { source: 'console.log(1)' }, context, viewerPublicKey: viewer.publicKey, machinePublicKey: machine.publicKey });
    expect(JSON.stringify(encrypted)).not.toContain('console.log');
    expect(decryptScriptValue({ encrypted, context, recipient: 'viewer', secretKey: viewer.secretKey })).toEqual({ source: 'console.log(1)' });
    expect(decryptScriptValue({ encrypted, context, recipient: 'machine', secretKey: machine.secretKey })).toEqual({ source: 'console.log(1)' });
  });
  it('rejects wrong keys, project/resource/purpose swaps and modified ciphertext', () => {
    const key = nacl.box.keyPair();
    const encrypted = encryptScriptValue({ value: {}, context, viewerPublicKey: key.publicKey, machinePublicKey: key.publicKey });
    const input = { encrypted, context, recipient: 'viewer' as const, secretKey: key.secretKey };
    expect(() => decryptScriptValue({ ...input, secretKey: nacl.box.keyPair().secretKey })).toThrow('SCRIPT_DECRYPT_FAILED');
    for (const patch of [{ projectId: 'p2' }, { resourceId: 'a2' }, { purpose: 'input' as const }]) {
      expect(() => decryptScriptValue({ ...input, context: { ...context, ...patch } })).toThrow('SCRIPT_DECRYPT_FAILED');
    }
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64'); ciphertext[30] ^= 1;
    expect(() => decryptScriptValue({ ...input, encrypted: { ...encrypted, ciphertext: ciphertext.toString('base64') } })).toThrow('SCRIPT_DECRYPT_FAILED');
  });
  it('validates and decrypts ciphertext near the four MiB plaintext limit without overflowing the validator stack', () => {
    const key = nacl.box.keyPair();
    const value = { log: '\0'.repeat(699_000), truncated: true };
    const encrypted = encryptScriptValue({ value, context, viewerPublicKey: key.publicKey, machinePublicKey: key.publicKey });
    expect(encrypted.ciphertext.length).toBeGreaterThan(5 * 1024 * 1024);
    expect(decryptScriptValue({ encrypted, context, recipient: 'viewer', secretKey: key.secretKey })).toEqual(value);
  });
});

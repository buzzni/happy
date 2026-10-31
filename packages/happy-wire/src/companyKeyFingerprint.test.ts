import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { companyKeyFingerprint } from './companyKeyFingerprint';
import { machineKeyFingerprint } from './machineKeyAttestation';

describe('companyKeyFingerprint', () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index);

  it('prints five groups of four base32 characters, the same on every client', () => {
    const fingerprint = companyKeyFingerprint(key);
    expect(fingerprint).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){4}$/);
    expect(companyKeyFingerprint(Uint8Array.from(key))).toBe(fingerprint);
  });

  it('differs for another key and from a machine key fingerprint of the same bytes', () => {
    expect(companyKeyFingerprint(nacl.box.keyPair().publicKey)).not.toBe(companyKeyFingerprint(key));
    expect(companyKeyFingerprint(key)).not.toBe(machineKeyFingerprint('', key));
  });

  it('refuses a key that is not a 32-byte public key', () => {
    expect(() => companyKeyFingerprint(new Uint8Array(31))).toThrow();
  });
});

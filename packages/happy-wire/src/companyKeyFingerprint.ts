import nacl from 'tweetnacl';
import { formatKeyFingerprint } from './keyFingerprint';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary F8 — the company (data)
 * public key a person compares between `happy datakey status` on a machine and
 * the organization key screen, in the machine key fingerprint's form.
 *
 * SHA-512 (tweetnacl) over a domain of its own and the key, so the same bytes
 * never print as both a machine key and a company key fingerprint.
 */
const DOMAIN = new TextEncoder().encode('happy company key fingerprint v1');

export function companyKeyFingerprint(publicKey: Uint8Array): string {
  if (publicKey.length !== nacl.box.publicKeyLength) throw new Error('Invalid company public key length');
  const input = new Uint8Array(DOMAIN.length + 1 + publicKey.length);
  input.set(DOMAIN, 0);
  input.set(publicKey, DOMAIN.length + 1);
  return formatKeyFingerprint(nacl.hash(input));
}

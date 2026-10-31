/**
 * The form a person compares a key digest in: the digest's first 100 bits,
 * RFC 4648 base32, five groups of four (e.g. `JOEL-Q5QQ-YRAH-WSYT-WGJR`).
 * Shared by every fingerprint a machine and a client print side by side.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function formatKeyFingerprint(digest: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest.subarray(0, 13)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 20) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

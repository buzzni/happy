import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { machineKeyTerminalCipher } from './terminalCipher';

describe('machineKeyTerminalCipher', () => {
  for (const encryptionVariant of ['legacy', 'dataKey'] as const) {
    it(`seals and opens in the machine-key format clients already use (${encryptionVariant})`, () => {
      const encryptionKey = new Uint8Array(randomBytes(32));
      const cipher = machineKeyTerminalCipher({ encryptionKey, encryptionVariant });

      expect(decrypt(encryptionKey, encryptionVariant, decodeBase64(cipher.seal('ls\r')))).toBe('ls\r');
      expect(cipher.open(encodeBase64(encrypt(encryptionKey, encryptionVariant, 'out')))).toBe('out');
    });
  }

  it('does not open data sealed with another key', () => {
    const cipher = machineKeyTerminalCipher({ encryptionKey: new Uint8Array(randomBytes(32)), encryptionVariant: 'dataKey' });
    const other = machineKeyTerminalCipher({ encryptionKey: new Uint8Array(randomBytes(32)), encryptionVariant: 'dataKey' });

    expect(cipher.open(other.seal('x'))).toBeNull();
  });
});

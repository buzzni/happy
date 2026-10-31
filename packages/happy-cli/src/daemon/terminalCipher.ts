/**
 * How one remote terminal's traffic is sealed, shared by the relay path
 * (apiMachine.ts `terminal-open-fwd`) and the direct path
 * (controlServerTerminalWs.ts).
 *
 * Today every terminal is sealed with the machine's own key and variant, the
 * same `encrypt`/`decrypt` dispatcher the rest of the daemon uses. Each
 * terminal holds its cipher, so a terminal with its own key (aplus-dev-studio
 * specs/e2ee-machine-control-boundary terminal-binding-strict-design.md) can
 * carry a different one.
 */

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';

export interface MachineEncryption {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}

export interface TerminalCipher {
  /** Seals a value for the wire (base64). Throws when it cannot. */
  seal(value: unknown): string;
  /** Opens a wire string; throws or returns null when it does not open, like `decrypt`. */
  open(data: string): unknown;
}

export function machineKeyTerminalCipher(machine: MachineEncryption): TerminalCipher {
  return {
    seal: (value) => encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, value)),
    open: (data) => decrypt(machine.encryptionKey, machine.encryptionVariant, decodeBase64(data)),
  };
}

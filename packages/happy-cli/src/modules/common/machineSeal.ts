/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 — values the server seals for one
 * machine: AES-256-GCM `[nonce 12 | ciphertext | tag 16]`, base64, under a key derived from the
 * machine's server-lane key with a purpose label. Only the daemon holding the machine key opens
 * it; the browser that carries it cannot. Each purpose (spawn env, git credential) has its own
 * label, so a value sealed for one is never read as another.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { deriveServerRpcKey } from '@/api/encryption';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function sealKey(laneKey: Uint8Array, label: string): Buffer {
    return createHmac('sha256', laneKey).update(label).digest();
}

/** The server's side of the seal, here so the format has one reference next to its reader. */
export function sealForMachine(laneKey: Uint8Array, label: string, payload: unknown): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', sealKey(laneKey, label), nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

/** The opened JSON, or null when it was not sealed for this machine key and label. */
export function openSealedForMachine(machineKey: Uint8Array, label: string, sealedBase64: string): unknown | null {
    try {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sealedBase64)) return null;
        const bytes = Buffer.from(sealedBase64, 'base64');
        if (bytes.length <= NONCE_BYTES + TAG_BYTES) return null;
        const decipher = createDecipheriv('aes-256-gcm', sealKey(deriveServerRpcKey(machineKey), label), bytes.subarray(0, NONCE_BYTES));
        decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
        const plaintext = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8'));
    } catch {
        return null;
    }
}

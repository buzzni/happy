export const MACHINE_DATA_KEY_ENVELOPE_LENGTH = 105;
export const MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH = 140;

/** Decodes a version-0 account envelope of a machine data key, refusing any non-canonical base64 spelling. */
export function decodeMachineDataKeyEnvelope(value: string): Uint8Array | null {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value
        || decoded.length !== MACHINE_DATA_KEY_ENVELOPE_LENGTH
        || decoded[0] !== 0x00) {
        return null;
    }
    return new Uint8Array(decoded);
}

export function machineDataKeyEnvelopesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return Buffer.from(left).equals(Buffer.from(right));
}

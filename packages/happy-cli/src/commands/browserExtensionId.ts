import { createHash } from 'node:crypto'

/**
 * Reproduces Chrome's extension id derivation: SHA-256 of the DER-encoded
 * public key (manifest.json's "key" field), first 16 bytes, each nibble
 * mapped to a-p. Pinning a key in the manifest is what makes an unpacked
 * extension's id stable across reloads — this lets the CLI print a
 * chrome-extension://<id>/... link without the extension having to report
 * its own id first.
 */
export function computeChromeExtensionId(base64SpkiKey: string): string {
    const der = Buffer.from(base64SpkiKey, 'base64')
    const hash = createHash('sha256').update(der).digest()
    const first16 = hash.subarray(0, 16)

    let id = ''
    for (const byte of first16) {
        id += String.fromCharCode(97 + (byte >> 4))
        id += String.fromCharCode(97 + (byte & 0x0f))
    }
    return id
}

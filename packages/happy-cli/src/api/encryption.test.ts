import { describe, it, expect } from 'vitest';
import tweetnacl from 'tweetnacl';
import { decryptBlob, getRandomBytes } from './encryption';

describe('decryptBlob', () => {
    it('decrypts a blob encrypted with NaCl secretbox', () => {
        const key = getRandomBytes(32);
        const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
        const ciphertext = tweetnacl.secretbox(plaintext, nonce, key);

        // Wire format: nonce + ciphertext
        const bundle = new Uint8Array(nonce.length + ciphertext.length);
        bundle.set(nonce, 0);
        bundle.set(ciphertext, nonce.length);

        const decrypted = decryptBlob(bundle, key);
        expect(decrypted).not.toBeNull();
        expect(decrypted).toEqual(plaintext);
    });

    it('returns null for wrong key', () => {
        const key = getRandomBytes(32);
        const wrongKey = getRandomBytes(32);
        const plaintext = new Uint8Array([10, 20, 30]);
        const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
        const ciphertext = tweetnacl.secretbox(plaintext, nonce, key);

        const bundle = new Uint8Array(nonce.length + ciphertext.length);
        bundle.set(nonce, 0);
        bundle.set(ciphertext, nonce.length);

        expect(decryptBlob(bundle, wrongKey)).toBeNull();
    });

    it('returns null for truncated bundle', () => {
        const key = getRandomBytes(32);
        const tooShort = new Uint8Array(10); // Less than nonce (24) + auth tag (16)
        expect(decryptBlob(tooShort, key)).toBeNull();
    });

    it('round-trips binary data of various sizes', () => {
        const key = getRandomBytes(32);
        for (const size of [0, 1, 255, 1024, 65536]) {
            const data = getRandomBytes(size);
            const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
            const encrypted = tweetnacl.secretbox(data, nonce, key);
            const bundle = new Uint8Array(nonce.length + encrypted.length);
            bundle.set(nonce, 0);
            bundle.set(encrypted, nonce.length);

            const decrypted = decryptBlob(bundle, key);
            expect(decrypted).toEqual(data);
        }
    });
});

// aplus §6-1 Phase 3b (aplus-dev-studio specs/20260818-e2ee-account-keypair) —
// getOrCreateMachine 이 보내는 dataEncryptionKey 봉투의 단일 조립 지점.
// 포맷: [version 0x00 | ephemeralPub(32) | nonce(24) | box ct] — dataKey
// 모드가 이미 쓰던 것과 바이트 단위로 동일해야 한다.
describe('wrapDataEncryptionKey', () => {
    it('wraps a machine key so the recipient private key can unwrap it', async () => {
        const { wrapDataEncryptionKey } = await import('./encryption');
        const recipient = tweetnacl.box.keyPair();
        const machineKey = getRandomBytes(32);

        const bundle = wrapDataEncryptionKey(machineKey, recipient.publicKey);

        expect(bundle[0]).toBe(0); // version byte
        const ephemeralPub = bundle.slice(1, 33);
        const nonce = bundle.slice(33, 33 + 24);
        const ct = bundle.slice(33 + 24);
        const opened = tweetnacl.box.open(ct, nonce, ephemeralPub, recipient.secretKey);
        expect(opened).not.toBeNull();
        expect(new Uint8Array(opened!)).toEqual(machineKey);
    });

    it('produces a fresh ephemeral key per call (no bundle reuse)', async () => {
        const { wrapDataEncryptionKey } = await import('./encryption');
        const recipient = tweetnacl.box.keyPair();
        const machineKey = getRandomBytes(32);
        const a = wrapDataEncryptionKey(machineKey, recipient.publicKey);
        const b = wrapDataEncryptionKey(machineKey, recipient.publicKey);
        expect(Buffer.from(a).toString('base64')).not.toBe(Buffer.from(b).toString('base64'));
    });
});

import * as Crypto from 'expo-crypto';
import type { AutomationCryptoAdapter } from '@slopus/happy-wire';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBox, encryptBox } from '@/encryption/libsodium';
import sodium from '@/encryption/libsodium.lib';

export const automationCrypto: AutomationCryptoAdapter = {
    randomBytes: (length) => Crypto.getRandomBytes(length),
    secretBoxSeal(plaintext, key) {
        const nonce = Crypto.getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
        const ciphertext = sodium.crypto_secretbox_easy(
            new Uint8Array(plaintext),
            nonce,
            new Uint8Array(key),
        );
        const bundle = new Uint8Array(nonce.length + ciphertext.length);
        bundle.set(nonce);
        bundle.set(ciphertext, nonce.length);
        return bundle;
    },
    secretBoxOpen(bundle, key) {
        try {
            const nonce = bundle.slice(0, sodium.crypto_secretbox_NONCEBYTES);
            const ciphertext = bundle.slice(sodium.crypto_secretbox_NONCEBYTES);
            return sodium.crypto_secretbox_open_easy(ciphertext, nonce, new Uint8Array(key));
        } catch {
            return null;
        }
    },
    boxSeal: (plaintext, recipientPublicKey) => encryptBox(plaintext, recipientPublicKey),
    boxOpen: (bundle, recipientSecretKey) => decryptBox(bundle, recipientSecretKey),
    async sha256(value) {
        const digest = await Crypto.digest(
            Crypto.CryptoDigestAlgorithm.SHA256,
            new Uint8Array(Array.from(value)),
        );
        return new Uint8Array(digest);
    },
    encodeBase64: (value, urlSafe = false) => encodeBase64(value, urlSafe ? 'base64url' : 'base64'),
    decodeBase64: (value) => decodeBase64(value, 'base64'),
};

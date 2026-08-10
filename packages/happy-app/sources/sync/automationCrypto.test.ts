import { beforeAll, describe, expect, it, vi } from 'vitest';
import sodiumNode from 'libsodium-wrappers';
import { decryptAutomationPayload, encryptAutomationPayload } from '@slopus/happy-wire';

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomBytes: (length: number) => new Uint8Array(require('node:crypto').randomBytes(length)),
    digest: async (_algorithm: string, value: Uint8Array) => (
        new Uint8Array(require('node:crypto').createHash('sha256').update(value).digest())
    ),
}));

vi.mock('@/encryption/libsodium.lib', () => ({ default: require('libsodium-wrappers') }));

import sodium from '@/encryption/libsodium.lib';
import { automationCrypto } from './automationCrypto';

describe('automationCrypto', () => {
    beforeAll(async () => sodiumNode.ready);

    it('implements the shared v1 codec with independent viewer and machine recipients', async () => {
        const viewer = sodium.crypto_box_keypair();
        const machine = sodium.crypto_box_keypair();
        const payload = {
            name: 'Review',
            schedule: { kind: 'interval' as const, minutes: 15 },
            prompt: 'Review the current project',
            directory: '/workspace/project',
            scriptCommand: null,
            suppressSilent: true,
            agent: 'codex' as const,
        };

        const encrypted = await encryptAutomationPayload({
            payload,
            viewer: { publicKey: viewer.publicKey, keyVersion: 1 },
            machine: { publicKey: machine.publicKey, keyVersion: 3 },
            crypto: automationCrypto,
        });

        await expect(decryptAutomationPayload({
            payloadVersion: 1,
            payloadCiphertext: encrypted.payloadCiphertext,
            keyEnvelope: encrypted.viewerKeyEnvelope,
            recipientSecretKey: viewer.privateKey,
            crypto: automationCrypto,
        })).resolves.toEqual(payload);
        await expect(decryptAutomationPayload({
            payloadVersion: 1,
            payloadCiphertext: encrypted.payloadCiphertext,
            keyEnvelope: encrypted.machineKeyEnvelope,
            recipientSecretKey: machine.privateKey,
            crypto: automationCrypto,
        })).resolves.toEqual(payload);
        await expect(decryptAutomationPayload({
            payloadVersion: 1,
            payloadCiphertext: encrypted.payloadCiphertext,
            keyEnvelope: encrypted.viewerKeyEnvelope,
            recipientSecretKey: machine.privateKey,
            crypto: automationCrypto,
        })).rejects.toThrow('automation-decrypt-failed');
    });
});

/**
 * aplus-dev-studio specs/script-automation-viewer-key R2 — a machine switched
 * to dataKey before access.key kept the automation viewer public key recovers
 * it once from its own legacy backup, and changes nothing otherwise.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { configuration } from '@/configuration';
import { encodeBase64 } from '@/api/encryption';
import { readCredentials, replaceCredentialsDataKey, type Credentials } from '@/persistence';
import { deriveContentKeyPair } from '@/resume/localHappyAgentAuth';
import { backfillViewerPublicKey, planViewerKeyBackfill } from './viewerKeyBackfill';

const secret = new Uint8Array(randomBytes(32));
const publicKey = new Uint8Array(randomBytes(32));
const machineKey = new Uint8Array(randomBytes(32));
const backupRaw = {
    token: 'old-token',
    secret: encodeBase64(secret),
    encryption: { publicKey: encodeBase64(publicKey), machineKey: encodeBase64(new Uint8Array(randomBytes(32))) },
};
const dataKey = (extra: { viewerPublicKey?: Uint8Array } = {}): Credentials =>
    ({ token: 'token', encryption: { type: 'dataKey', publicKey, machineKey, ...extra } });

describe('planViewerKeyBackfill', () => {
    it('derives the viewer key from a backup of the same account, even after the machine key was replaced', () => {
        expect(planViewerKeyBackfill({ credentials: dataKey(), rawBackup: backupRaw }))
            .toEqual({ ok: true, viewerPublicKey: deriveContentKeyPair(secret).publicKey });
    });

    it('leaves a credential that already keeps the key', () => {
        expect(planViewerKeyBackfill({ credentials: dataKey({ viewerPublicKey: new Uint8Array(32) }), rawBackup: backupRaw }))
            .toEqual({ ok: false, reason: 'already-kept' });
    });

    it('leaves legacy credentials, which derive the key themselves', () => {
        expect(planViewerKeyBackfill({ credentials: { token: 't', encryption: { type: 'legacy', secret } }, rawBackup: backupRaw }))
            .toEqual({ ok: false, reason: 'not-datakey' });
    });

    it('needs a backup', () => {
        expect(planViewerKeyBackfill({ credentials: dataKey(), rawBackup: null })).toEqual({ ok: false, reason: 'no-backup' });
    });

    it('refuses a backup that names no account key to compare', () => {
        expect(planViewerKeyBackfill({ credentials: dataKey(), rawBackup: { token: 't', secret: encodeBase64(secret) } }))
            .toEqual({ ok: false, reason: 'backup-invalid' });
        expect(planViewerKeyBackfill({ credentials: dataKey(), rawBackup: 'nonsense' })).toEqual({ ok: false, reason: 'backup-invalid' });
    });

    it('refuses a backup of another account key', () => {
        const other = { ...backupRaw, encryption: { ...backupRaw.encryption, publicKey: encodeBase64(new Uint8Array(32).fill(1)) } };
        expect(planViewerKeyBackfill({ credentials: dataKey(), rawBackup: other })).toEqual({ ok: false, reason: 'other-account' });
    });
});

describe('backfillViewerPublicKey', () => {
    const backupFile = () => `${configuration.privateKeyFile}.legacy-backup`;

    afterEach(async () => {
        await rm(backupFile(), { force: true });
    });

    it('writes the derived key into access.key and returns the credential that carries it', async () => {
        await replaceCredentialsDataKey({ token: 'token', publicKey, machineKey, neverEscrowed: true });
        writeFileSync(backupFile(), JSON.stringify(backupRaw));
        const credentials = (await readCredentials())!;

        const kept = await backfillViewerPublicKey(credentials);

        const expected = { type: 'dataKey', publicKey, machineKey, neverEscrowed: true, viewerPublicKey: deriveContentKeyPair(secret).publicKey };
        expect(kept.encryption).toEqual(expected);
        expect((await readCredentials())!.encryption).toEqual(expected);
    });

    it('changes nothing when the backup belongs to another account', async () => {
        await replaceCredentialsDataKey({ token: 'token', publicKey, machineKey });
        const other = { ...backupRaw, encryption: { ...backupRaw.encryption, publicKey: encodeBase64(new Uint8Array(32).fill(1)) } };
        writeFileSync(backupFile(), JSON.stringify(other));
        const before = readFileSync(configuration.privateKeyFile, 'utf8');
        const credentials = (await readCredentials())!;

        await expect(backfillViewerPublicKey(credentials)).resolves.toBe(credentials);
        expect(readFileSync(configuration.privateKeyFile, 'utf8')).toBe(before);
    });
});

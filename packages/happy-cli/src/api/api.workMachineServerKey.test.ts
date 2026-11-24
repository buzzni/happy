/**
 * A protected daemon after a replace or restore (aplus-dev-studio specs/work-machine-migration):
 * Happy cleared the server copies of the machine key with the old key, so the daemon that is now
 * the current device puts them back at start, the way a registration would have sent them. Without
 * them Studio's server lane falls back to the account's legacy key, which the daemon refuses.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '@/api/api';
import { configuration } from '@/configuration';
import { deriveServerRpcKey, encodeBase64, encrypt, wrapDataEncryptionKey } from '@/api/encryption';

const MACHINE_ID = 'work-machine';
const MACHINE_KEY = new Uint8Array(32).fill(7);
const account = tweetnacl.box.keyPair();
const serverKey = tweetnacl.box.keyPair();
const ACCOUNT_ENVELOPE = encodeBase64(wrapDataEncryptionKey(MACHINE_KEY, account.publicKey));

let server: Server;
let originalUrl: string;
let requests: { method: string; url: string; authorization?: string; body: any }[];
let machineRow: Record<string, unknown>;
let uploadStatus: number;

function unwrapForServer(envelope: string): Uint8Array | null {
    const bytes = Buffer.from(envelope, 'base64');
    return tweetnacl.box.open(bytes.subarray(57), bytes.subarray(33, 57), bytes.subarray(1, 33), serverKey.secretKey);
}

function protectedClient(neverEscrowed = false) {
    return ApiClient.create({ token: 'wmx_daemon_token_for_tests', encryption: {
        type: 'dataKey', publicKey: account.publicKey, machineKey: MACHINE_KEY, ...(neverEscrowed ? { neverEscrowed: true as const } : {}),
    } });
}

function start(api: ApiClient, machineControl: 'compat' | 'strict' = 'compat', serverPublicKey: string | null = encodeBase64(serverKey.publicKey)) {
    return api.getOrCreateMachine({
        machineId: MACHINE_ID, metadata: { host: 'target' } as never, serverPublicKey, machineControl,
    });
}

beforeEach(async () => {
    requests = [];
    uploadStatus = 200;
    // As a handoff leaves the machine: the new device's account envelope, no server copies.
    machineRow = {
        id: MACHINE_ID, metadata: encodeBase64(encrypt(MACHINE_KEY, 'dataKey', { host: 'target' })), metadataVersion: 4,
        daemonState: null, daemonStateVersion: 2, dataEncryptionKey: ACCOUNT_ENVELOPE,
        serverDataEncryptionKey: null, serverRpcKeyEnvelope: null, dataKeyAttestation: null,
    };
    server = createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            requests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
            const upload = req.method === 'PUT' && req.url === `/v1/machines/${MACHINE_ID}/server-key-envelopes`;
            res.writeHead(upload ? uploadStatus : 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(upload ? { ok: true, changed: true } : { machine: machineRow }));
        });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    originalUrl = configuration.serverUrl;
    (configuration as { serverUrl: string }).serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
    (configuration as { serverUrl: string }).serverUrl = originalUrl;
    await new Promise<void>(done => server.close(() => done()));
});

const uploads = () => requests.filter(request => request.method === 'PUT');

describe('a protected daemon starting as the current device', () => {
    it('uploads the missing server copies for the data key the server has, with its device credential', async () => {
        const machine = await start(await protectedClient());

        expect(machine.id).toBe(MACHINE_ID);
        expect(uploads()).toHaveLength(1);
        const [upload] = uploads();
        expect(upload.authorization).toBe('Bearer wmx_daemon_token_for_tests');
        expect(upload.body.expectedDataEncryptionKey).toBe(ACCOUNT_ENVELOPE);
        expect(Buffer.from(unwrapForServer(upload.body.serverRpcKeyEnvelope)!)).toEqual(Buffer.from(deriveServerRpcKey(MACHINE_KEY)));
        expect(Buffer.from(unwrapForServer(upload.body.serverDataEncryptionKey)!)).toEqual(Buffer.from(MACHINE_KEY));
    });

    it('never sends the machine key itself under strict machine control', async () => {
        await start(await protectedClient(), 'strict');

        expect(uploads()).toHaveLength(1);
        expect(uploads()[0].body.serverDataEncryptionKey).toBeNull();
        expect(unwrapForServer(uploads()[0].body.serverRpcKeyEnvelope)).not.toBeNull();
    });

    it('never sends a machine key that was kept from the server, even outside strict machine control', async () => {
        await start(await protectedClient(true), 'compat');

        expect(uploads()).toHaveLength(1);
        expect(uploads()[0].body.serverDataEncryptionKey).toBeNull();
        expect(unwrapForServer(uploads()[0].body.serverRpcKeyEnvelope)).not.toBeNull();
    });

    it('uploads nothing when the server already has its copies', async () => {
        machineRow.serverRpcKeyEnvelope = encodeBase64(wrapDataEncryptionKey(deriveServerRpcKey(MACHINE_KEY), serverKey.publicKey));
        machineRow.serverDataEncryptionKey = encodeBase64(wrapDataEncryptionKey(MACHINE_KEY, serverKey.publicKey));
        await start(await protectedClient());
        expect(uploads()).toEqual([]);
    });

    it('sends only the copy that is missing', async () => {
        machineRow.serverRpcKeyEnvelope = encodeBase64(wrapDataEncryptionKey(deriveServerRpcKey(MACHINE_KEY), serverKey.publicKey));
        await start(await protectedClient());
        expect(uploads()).toHaveLength(1);
        expect(uploads()[0].body.serverRpcKeyEnvelope).toBeNull();
        expect(unwrapForServer(uploads()[0].body.serverDataEncryptionKey)).not.toBeNull();
    });

    it('uploads nothing without the server public key to wrap for', async () => {
        await start(await protectedClient(), 'compat', null);
        expect(uploads()).toEqual([]);
    });

    it('still starts when the upload is refused', async () => {
        uploadStatus = 409;
        await expect(start(await protectedClient())).resolves.toMatchObject({ id: MACHINE_ID });
        expect(uploads()).toHaveLength(1);
    });
});

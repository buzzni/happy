/** T4rt: real encrypted creation against an isolated HTTP server. */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionCreateBodyHash, sessionTagHash, sharedMachineRotationFixture, HappySessionExecutionProofSchema } from '@slopus/happy-wire';
import { ApiClient } from './api';
import { configuration } from '@/configuration';

const metadata = { path: '/project', host: 'test', homeDir: '/home/test', happyHomeDir: '/private', happyLibDir: '/lib', happyToolsDir: '/tools' };
const secret = new Uint8Array(32).fill(1);
const origin = configuration.serverUrl;
type Body = { tag: string; metadata: string; agentState?: string | null; dataEncryptionKey?: string | null };
async function proofFor(body: Body) {
    const now = Date.now();
    return { version: 1 as const, type: 'saycode-session-ownership' as const, issuer: 'https://studio.test', audience: 'https://happy.test',
        keyId: 'a'.repeat(64), issuedAt: now, expiresAt: now + 60_000, intentId: 'intent', operationId: 'operation',
        creationRequestId: 'creation', ownershipPolicy: 'prefer-owned' as const, subject: { issuer: 'https://studio.test', userId: 'person' },
        companyId: 'company', projectId: 'project', machineId: 'machine', machineAccountId: 'account', sessionAccountId: 'account',
        parentHubSessionId: null, spawnDigest: 'b'.repeat(64), nonce: Buffer.alloc(32, 2).toString('base64url'),
        tagHash: await sessionTagHash(body.tag), createBodyHash: await sessionCreateBodyHash(body), signature: Buffer.alloc(64).toString('base64url') };
}

describe('ownership creation transport', () => {
    let server: Server;
    let requests: Array<Body & { ownershipProof?: unknown; executionProof?: unknown }>;
    let status: number;
    let missingReceipt: boolean;
    beforeEach(async () => {
        requests = []; status = 200; missingReceipt = false;
        server = createServer(async (req, res) => {
            let data = '';
            for await (const chunk of req) data += chunk;
            const body = JSON.parse(data) as Body;
            requests.push(body);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status !== 200 ? { error: 'rejected-secret-must-not-escape' } : {
                session: { id: 'created', seq: 0, metadata: body.metadata, metadataVersion: 1, agentState: body.agentState, agentStateVersion: 1 },
                ...(!missingReceipt && 'ownershipProof' in body ? { ownership: { sessionId: 'created', ownershipBindingId: 'binding',
                    registrationState: 'pending', createDigest: await sessionCreateBodyHash({ tag: body.tag, metadata: body.metadata,
                        agentState: body.agentState, dataEncryptionKey: body.dataEncryptionKey }) } } : {}),
            }));
        });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        configuration.serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterEach(async () => { configuration.serverUrl = origin; await new Promise<void>(resolve => server.close(() => resolve())); });
    const client = () => ApiClient.create({ token: 'happy-account-token', encryption: { type: 'legacy', secret } });

    it('seals the final ciphertext once and returns the pending receipt only to its trusted callback', async () => {
        let prepared: Body | undefined;
        let proof: unknown;
        let receipt: unknown;
        const options = Object.assign({ tag: 'tag', metadata, state: null }, {
            ownershipProof: async (body: Body) => { expect(requests).toHaveLength(0); prepared = body; proof = await proofFor(body); return proof; },
            onOwnershipCreated: async (value: unknown) => { receipt = value; },
        });
        const session = await (await client()).getOrCreateSession(options);
        expect(prepared).toBeDefined();
        expect(requests).toEqual([{ ...prepared, ownershipProof: proof }]);
        expect(receipt).toMatchObject({ sessionId: 'created', ownershipBindingId: 'binding', registrationState: 'pending' });
        expect(session?.metadata).toEqual(metadata);
        expect(session).not.toHaveProperty('ownershipProof');
        expect(session).not.toHaveProperty('ownership');
    });
    it('carries execution and ownership proofs on the identical final body', async () => {
        const executionProof = HappySessionExecutionProofSchema.parse(sharedMachineRotationFixture.executionProof);
        let executionBody: unknown;
        await (await client()).getOrCreateSession({ tag: 'tag', metadata, state: null,
            executionProof: async body => { executionBody = body; return executionProof; },
            ownershipProof: async body => { expect(body).toBe(executionBody); return proofFor(body); },
        });
        expect(requests[0].executionProof).toEqual(executionProof);
        expect(requests[0].ownershipProof).toBeDefined();
    });
    it('does not POST if the ownership preparation callback rejects', async () => {
        await expect((await client()).getOrCreateSession({ tag: 'tag', metadata, state: null,
            ownershipProof: async () => { throw new Error('private preparation failure'); },
        })).rejects.toMatchObject({ commitIssued: false, message: 'Ownership-bound session creation failed' });
        expect(requests).toHaveLength(0);
    });
    it('preserves the legacy unsigned request shape', async () => {
        await (await client()).getOrCreateSession({ tag: 'tag', metadata, state: null });
        expect(Object.keys(requests[0]).sort()).toEqual(['agentState', 'dataEncryptionKey', 'metadata', 'tag']);
    });
    it.each([403, 409, 503])('does not downgrade proof rejection or expose request data (%s)', async code => {
        status = code;
        await expect((await client()).getOrCreateSession(Object.assign({ tag: 'tag', metadata, state: null }, {
            ownershipProof: proofFor,
        }))).rejects.toMatchObject({ message: 'Ownership-bound session creation failed', status: code });
        expect(requests).toHaveLength(1);
    });
    it('refuses a malformed proof before POST', async () => {
        await expect((await client()).getOrCreateSession(Object.assign({ tag: 'tag', metadata, state: null }, {
            ownershipProof: async () => ({ secret: 'malformed' }),
        }))).rejects.toThrow();
        expect(requests).toHaveLength(0);
    });
    it('refuses a proof for different ciphertext before POST', async () => {
        await expect((await client()).getOrCreateSession(Object.assign({ tag: 'tag', metadata, state: null }, {
            ownershipProof: async (body: Body) => ({ ...await proofFor(body), createBodyHash: 'c'.repeat(64) }),
        }))).rejects.toThrow();
        expect(requests).toHaveLength(0);
    });
    it('does not report owned success when an old server omits its receipt', async () => {
        missingReceipt = true;
        await expect((await client()).getOrCreateSession(Object.assign({ tag: 'tag', metadata, state: null }, {
            ownershipProof: proofFor,
        }))).rejects.toThrow('Ownership-bound session creation failed');
        expect(requests).toHaveLength(1);
    });
});

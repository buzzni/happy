import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from './api';
import { configuration } from '@/configuration';
import { sharedMachineRotationFixture, HappySessionExecutionProofSchema } from '@slopus/happy-wire';

const servers: Server[] = [];
const original = configuration.serverUrl;
afterEach(async () => {
    configuration.serverUrl = original;
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
});
describe('execution-bound prepared session creation', () => {
    it('sends the exact encrypted payload prepared before user authorization, without encrypting it again', async () => {
        let sent: Record<string, unknown> | null = null;
        const server = createServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            sent = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ session: { id: 'new-session', seq: 0, metadata: sent!.metadata, metadataVersion: 0, agentState: null, agentStateVersion: 0 } }));
        });
        servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing server');
        configuration.serverUrl = `http://127.0.0.1:${address.port}`;
        const api = await ApiClient.create({ token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) } });
        const metadata = { path: '/project', host: 'test', homeDir: '/test', happyHomeDir: '/test/.happy', happyLibDir: '/lib', happyToolsDir: '/tools' };
        const prepared = api.prepareSessionCreation({ tag: 'exact-tag', metadata, state: null });
        const options = { tag: 'exact-tag', metadata, state: null, prepared,
            executionProof: async () => HappySessionExecutionProofSchema.parse(sharedMachineRotationFixture.executionProof) };
        const session = await api.getOrCreateSession(options);
        expect(sent).toMatchObject(prepared.body);
        expect(session?.metadata).toEqual(metadata);
        expect(session?.encryptionKey).toEqual(prepared.encryptionKey);
    });
});

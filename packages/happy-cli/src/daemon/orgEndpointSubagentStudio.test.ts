import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { SignedSubagentRequestSchema, verifySubagentRequest } from '@slopus/happy-wire';
import { createOrgSubagentStudio } from './orgEndpointSubagentStudio';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });
async function fixture(reply: { status?: number; contentType?: string; body?: string } = {}) {
    let received: { path?: string; authorization?: string; body?: unknown } = {};
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
        res.writeHead(reply.status ?? 200, { 'Content-Type': reply.contentType ?? 'application/json' });
        res.end(reply.body ?? JSON.stringify({ version: 1, state: 'prepared' }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
    const origin = `http://127.0.0.1:${address.port}`, keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    const studio = createOrgSubagentStudio({ origin, machineId: 'machine', signingKey: keys.secretKey, bearer: () => 'machine-bearer', fetch,
        now: () => 1_800_000_000_000 });
    return { studio, received: () => received, origin, keys };
}
const parent = { sessionId: 'parent', launchId: 'launch' };
const request = { operationId: 'operation', digest: 'a'.repeat(64), endpointId: 'endpoint' };
describe('org subagent Studio protocol', () => {
    it('distinguishes an absent operation from an absent server route', async () => {
        const ctx = await fixture({ status: 404, body: JSON.stringify({ error: 'ORG_LLM_ENDPOINT_OPERATION_NOT_FOUND' }) });
        await expect(ctx.studio(parent, 'status', { operationId: 'operation', digest: request.digest })).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_OPERATION_NOT_FOUND' });
    });
    it('accepts a complete sixteen-target prepare larger than the legacy four-KiB report limit', async () => {
        const targets = Array.from({ length: 16 }, (_, index) => ({ id: `target-${index}`, url: `https://target-${index}.example/${'x'.repeat(1970)}` }));
        const answer = { version: 1, state: 'prepared', sync: { endpoint: { targets } } };
        const body = JSON.stringify(answer); expect(Buffer.byteLength(body)).toBeGreaterThan(4096); expect(Buffer.byteLength(body)).toBeLessThan(128 * 1024);
        const ctx = await fixture({ body });
        expect(await ctx.studio(parent, 'prepare', request)).toEqual(answer);
    });
    it('signs the exact method, path, origin, parent, machine and payload with the approved device key', async () => {
        const ctx = await fixture();
        expect(await ctx.studio(parent, 'prepare', request)).toEqual({ version: 1, state: 'prepared' });
        expect(ctx.received()).toMatchObject({ path: '/api/org-llm-endpoints/daemon/subagent-prepare', authorization: 'Bearer machine-bearer' });
        const signed = SignedSubagentRequestSchema.parse(ctx.received().body);
        expect(verifySubagentRequest(signed, Buffer.from(ctx.keys.publicKey).toString('base64url'))).toBe(true);
        expect(signed.body).toMatchObject({ audience: ctx.origin, machineId: 'machine', sourceSessionId: 'parent', launchId: 'launch', ...request });
        expect(JSON.stringify(ctx.received().body)).not.toContain('machine-bearer');
    });
    it.each([
        { status: 404, body: '{}' }, { status: 401, body: '{}' },
        { contentType: 'text/html', body: '<html>fallback</html>' }, { body: '{}' },
        { body: 'x'.repeat(128 * 1024 + 1) },
    ])('refuses an unsupported, unauthorized or invalid response: %j', async reply => {
        const ctx = await fixture(reply);
        await expect(ctx.studio(parent, 'prepare', request)).rejects.toThrow();
    });
    it('preserves a safe server refusal without exposing response text', async () => {
        const ctx = await fixture({ status: 403, body: JSON.stringify({ error: 'ORG_LLM_ENDPOINT_NOT_ASSIGNED', secret: 'private-value' }) });
        await expect(ctx.studio(parent, 'prepare', request)).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_NOT_ASSIGNED' });
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { stat, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OwnerRelayReplySchema, ownerRelayV1Fixture } from '@slopus/happy-wire';
import { startSessionOwnerContactLocal } from './sessionOwnerContactLocal';
import { startAgentBroker } from '../commands/agentBroker';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
const input = { v: 1, entry: 'chat', operation: 'lookup-readable-sessions', payload: { sessionIds: ['target'] } };
const reply = OwnerRelayReplySchema.parse(ownerRelayV1Fixture.vectors[0].reply);
function send(socketPath: string, body: unknown = input, headers: Record<string, string> = {}, path = '/owner-contact-v1', method = 'POST') {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ socketPath, path, method, headers, agent: false }, res => {
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    });
}
async function fixture(call = vi.fn(async (_raw: unknown) => reply)) {
    const close = vi.fn();
    const local = await startSessionOwnerContactLocal({ enabled: true, contact: { call, close } });
    if (!local) throw new Error('missing local port');
    cleanup.push(local.close);
    return { local, call, close, socket: local.environment.SAYCODE_OWNER_CONTACT_SOCKET };
}
describe.skipIf(process.platform === 'win32')('owner-contact-v1 local transport', () => {
    it('is default off without acquiring or closing contact resources', async () => {
        const contact = { call: vi.fn(), close: vi.fn() };
        expect(await startSessionOwnerContactLocal({ contact })).toBeNull();
        expect(contact.call).not.toHaveBeenCalled(); expect(contact.close).not.toHaveBeenCalled();
    });
    it('serves strict DTOs on a private socket and exposes only its discovery address', async () => {
        const h = await fixture();
        const response = await send(h.socket);
        expect(response.status).toBe(200); expect(JSON.parse(response.body)).toEqual(reply);
        expect(h.call).toHaveBeenCalledWith(input);
        expect(Object.keys(h.local.environment)).toEqual(['SAYCODE_OWNER_CONTACT_SOCKET']);
        expect((await stat(dirname(h.socket))).mode & 0o777).toBe(0o700);
        expect((await stat(h.socket)).mode & 0o777).toBe(0o600);
    });
    it.each(['sourceHubSessionId', 'callerBindingId', 'sourceAuthority', 'scope', 'depth', 'bearer'])('rejects %s injection before calling the host', async field => {
        const h = await fixture();
        expect((await send(h.socket, { ...input, [field]: 'forged' })).status).toBe(400);
        expect(h.call).not.toHaveBeenCalled();
    });
    it('refuses origins, arbitrary URLs, argv protocol and unbounded bodies', async () => {
        const h = await fixture();
        expect((await send(h.socket, input, { origin: 'https://evil.example' })).status).toBe(403);
        expect((await send(h.socket, input, {}, '/agent')).status).toBe(404);
        expect((await send(h.socket, input, {}, '/owner-contact-v1', 'GET')).status).toBe(404);
        expect((await send(h.socket, { version: 1, argv: ['stop', 'other'] })).status).toBe(400);
        expect((await send(h.socket, 'x'.repeat(65537))).status).toBe(413);
        expect((await send(h.socket, { ...input, payload: { sessionIds: Array.from({ length: 101 }, (_, i) => `${i}`) } })).status).toBe(400);
        expect(h.call).not.toHaveBeenCalled();
    });
    it('rejects invalid UTF-8 instead of changing text before signing', async () => {
        const h = await fixture();
        const bytes = Buffer.concat([Buffer.from('{"v":1,"entry":"chat","operation":"lookup-readable-sessions","payload":{"sessionIds":["'), Buffer.from([0xff]), Buffer.from('"]}}')]);
        expect((await send(h.socket, bytes)).status).toBe(400);
        expect(h.call).not.toHaveBeenCalled();
    });
    it('bounds an unresponsive adapter to 20 seconds at the socket', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let resolve!: (value: typeof reply) => void;
        try {
            const h = await fixture(vi.fn(() => new Promise<typeof reply>(r => { resolve = r; })));
            const pending = send(h.socket).catch(() => null);
            await vi.waitFor(() => expect(h.call).toHaveBeenCalledOnce());
            await vi.advanceTimersByTimeAsync(20_001);
            expect(await pending).toBeNull();
            resolve(reply);
            await h.local.close();
        } finally { vi.useRealTimers(); }
    });
    it('hides adapter exceptions and rejects invalid replies', async () => {
        const h = await fixture(vi.fn(async () => { throw new Error('bearer-secret'); }));
        const response = await send(h.socket);
        expect(response.status).toBe(503); expect(response.body).not.toContain('bearer-secret');
        h.call.mockResolvedValueOnce({ ...reply, secret: 'do-not-leak' } as unknown as typeof reply);
        const invalid = await send(h.socket);
        expect(invalid.status).toBe(503); expect(invalid.body).not.toContain('do-not-leak');
    });
    it('closes pending sockets promptly even when an adapter ignores cancellation, without late replies', async () => {
        let resolve!: (value: typeof reply) => void;
        const call = vi.fn(() => new Promise<typeof reply>(r => { resolve = r; }));
        const h = await fixture(call);
        const pending = send(h.socket).catch(() => null);
        await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
        await h.local.close(); await h.local.close();
        expect(h.close).toHaveBeenCalledOnce();
        expect(await pending).toBeNull();
        await expect(access(h.socket)).rejects.toThrow();
        await expect(access(dirname(h.socket))).rejects.toThrow();
        resolve(reply);
        await expect(send(h.socket)).rejects.toThrow();
    });
    it('bounds concurrent calls without proxying additional work', async () => {
        let resolve!: (value: typeof reply) => void;
        const pendingReply = new Promise<typeof reply>(r => { resolve = r; });
        const h = await fixture(vi.fn(() => pendingReply));
        const pending = Array.from({ length: 8 }, () => send(h.socket));
        await vi.waitFor(() => expect(h.call).toHaveBeenCalledTimes(8));
        expect((await send(h.socket)).status).toBe(429);
        resolve(reply);
        expect((await Promise.all(pending)).every(r => r.status === 200)).toBe(true);
    });
    it('keeps existing read and descendant-control dispatch usable with the owner port unavailable', async () => {
        const calls: string[][] = [];
        const broker = await startAgentBroker({ execute: async argv => { calls.push(argv); return { stdout: '{"ok":true}', exitCode: 0 }; } });
        cleanup.push(broker.close);
        const h = await fixture(vi.fn(async () => { throw new Error('owner-unavailable'); }));
        expect((await send(h.socket)).status).toBe(503);
        await h.local.close();
        for (const verb of ['read', 'wait', 'search', 'prompt', 'steer', 'stop']) {
            const response = await fetch(broker.environment.SAYCODE_AGENT_BROKER_URL, { method: 'POST',
                headers: { authorization: `Bearer ${broker.environment.SAYCODE_AGENT_BROKER_CAPABILITY}` },
                body: JSON.stringify({ version: 1, argv: [verb, 'existing-target'] }) });
            expect(response.status).toBe(200);
        }
        expect(calls.map(args => args[0])).toEqual(['read', 'wait', 'search', 'prompt', 'steer', 'stop']);
    });
});

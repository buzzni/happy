import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { AiUsageEventV1Schema, type AiUsageEventV1, type ProviderUsageEventV1 } from '@slopus/happy-wire';
import { SandboxConfigSchema } from '@/persistence';
import { eventually, SessionWriteScopeFixture } from '@/testing/sessionWriteScopeFixture';
import { createCodexUsageEvent } from './providerUsageAdapters';
import { ProviderUsageSpool } from './providerUsageSpool';

/** Count every HTTP delivery, without recipient-side dedup hiding server duplicates. */
async function recipient() {
    const secret = randomBytes(32).toString('hex');
    const arrivals: AiUsageEventV1[] = [];
    const refused: string[] = [];
    const server = createServer(async (request, response) => {
        try {
            let body = '';
            for await (const chunk of request) body += chunk;
            const timestamp = String(request.headers['x-saycode-usage-timestamp']);
            const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
            const parsed = AiUsageEventV1Schema.safeParse(JSON.parse(body));
            if (!parsed.success || request.headers['x-saycode-usage-signature'] !== signature) throw new Error('signature/schema');
            arrivals.push(parsed.data);
            response.writeHead(202).end();
        } catch { refused.push('signature/schema'); response.writeHead(400).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { secret, arrivals, refused,
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}/usage`,
        close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}

/** Real authenticated server ACKs, including the immutable event row ID on duplicate reports. */
async function duplicateAcks(fixture: SessionWriteScopeFixture, event: ProviderUsageEventV1) {
    const socket = io(fixture.serverUrl, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
        autoConnect: false, auth: { token: fixture.token, clientType: 'session-scoped', sessionId: event.sessionId } });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Recovery fixture socket unavailable')), 5000);
            socket.once('connect', () => { clearTimeout(timer); resolve(); });
            socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
            socket.connect();
        });
        const first = await socket.timeout(5000).emitWithAck('provider-usage-report', event);
        const second = await socket.timeout(5000).emitWithAck('provider-usage-report', event);
        expect(first).toMatchObject({ success: true, eventId: expect.any(String) });
        expect(second).toEqual(first);
    } finally { socket.disconnect(); }
}

describe.skipIf(process.env.HAPPY_PROVIDER_USAGE_INTEGRATION !== '1' || !['darwin', 'linux'].includes(process.platform))('daemon-only usage recovery', () => {
    it.each(['legacy', 'dataKey'] as const)('recovers an unacknowledged %s spool without resuming the owned session', async encryptionVariant => {
        const ledger = await recipient();
        const fixture = new SessionWriteScopeFixture({ provider: 'codex', encryptionVariant, usageIngest: ledger,
            databaseUrl: process.env.HAPPY_USAGE_DATABASE_URL });
        try {
            await fixture.start();
            const id = await fixture.spawnSession(fixture.project, SandboxConfigSchema.parse({ sessionIsolation: 'strict',
                networkMode: 'custom', allowedDomains: ['127.0.0.1', 'localhost', fixture.modelHost] }));
            await fixture.stopDaemon();
            expect(fixture.modelRequests).toEqual([]);
            expect((await fixture.session(id)).id).toBe(id);
            const recoveryKey = createHash('sha256').update('happy-usage-recovery-v1')
                .update(encryptionVariant === 'legacy' ? fixture.seed : fixture.machineKey).digest();
            const spool = new ProviderUsageSpool({ root: join(fixture.happyHome, 'usage-spool'), server: fixture.serverUrl,
                sessionId: id, key: fixture.sessionKey(id), variant: encryptionVariant, recoveryKey });
            const event = createCodexUsageEvent({ sessionId: id, responseId: `recovery-fixture-${randomUUID()}`,
                occurredAt: Date.now(), model: 'synthetic-recovery-fixture', usage: { inputTokens: 10, cachedInputTokens: 0,
                    cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 } });
            spool.put(event);
            expect(spool.load()).toEqual([event]);
            // The real disk files are ciphertext; no bearer or plaintext usage event is seeded.
            const files = await readdir(spool.directory);
            expect(files).toContain('identity.enc');
            expect(files.filter(file => file.endsWith('.json'))).toHaveLength(1);
            for (const file of files) {
                const sealed = await readFile(join(spool.directory, file), 'utf8');
                expect(sealed).not.toContain(event.sourceEventId);
                expect(sealed).not.toContain(fixture.token);
            }
            expect(ledger.arrivals).toEqual([]);

            // No resumeSession, spawnSession, prompt, or in-process recovery worker after restart.
            await fixture.startDaemon();
            await fixture.waitDaemonConnection(true);
            await eventually(async () => spool.load().length === 0 ? true : undefined, 'daemon recovered and ACKed spool', 45000);
            await eventually(async () => ledger.arrivals.length ? true : undefined, 'real outbox delivery', 30000);
            expect(await fixture.children()).toEqual([]);
            expect(ledger.arrivals).toEqual([{ ...event, happyAccountId: fixture.accountId }]);
            await duplicateAcks(fixture, event);

            // Simulate a crash after server acceptance but before local ACK cleanup: durable replay of the same ID.
            await fixture.stopDaemon();
            spool.put(event);
            expect(spool.load()).toEqual([event]);
            await fixture.startDaemon();
            await fixture.waitDaemonConnection(true);
            await eventually(async () => spool.load().length === 0 ? true : undefined, 'duplicate replay ACK cleanup', 45000);
            // Observe two complete 5-second outbox polling cycles after the final duplicate ACK.
            const until = Date.now() + 12000;
            await eventually(async () => {
                expect(ledger.arrivals).toEqual([{ ...event, happyAccountId: fixture.accountId }]);
                expect(await fixture.children()).toEqual([]);
                return Date.now() >= until ? true : undefined;
            }, 'no second outbox delivery or resumed child', 15000);
            expect(ledger.refused).toEqual([]);
            expect(fixture.modelRequests).toEqual([]);
            expect((await fixture.session(id)).id).toBe(id);
        } catch (error) {
            throw new Error(`${error}\n${await fixture.diagnostics()}`, { cause: error });
        } finally {
            try { await fixture.close(); } finally { await ledger.close(); }
        }
    }, 150000);
});

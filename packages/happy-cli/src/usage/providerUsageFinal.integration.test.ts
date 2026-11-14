/**
 * What the usage ledger receives for provider requests whose final usage is known in advance.
 *
 * The loopback model of `SessionWriteScopeFixture` answers every request with the same usage
 * (Claude: `message_start` output 0, then `message_delta` output 5; Codex: `response.completed`
 * 10 in / 5 out), so the expected ledger is the number of model requests times that — a reference
 * that does not pass through the collector under test. Real standalone server, daemon and provider
 * CLI; the ledger is a local endpoint the server's own outbox delivers to.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiUsageEventV1Schema, type AiUsageEventV1 } from '@slopus/happy-wire';
import { encrypt } from '@/api/encryption';
import { SandboxConfigSchema } from '@/persistence';
import { eventually, SessionWriteScopeFixture } from '@/testing/sessionWriteScopeFixture';

/** The usage the loopback model reports for one request, in ledger buckets. */
const REQUEST_USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15 };
/** Two runs of the server's outbox worker: anything stored has been delivered by then. */
const LEDGER_QUIET_MS = 12_000;

async function startLedger() {
    const secret = randomBytes(16).toString('hex');
    const events = new Map<string, AiUsageEventV1>();
    const refused: string[] = [];
    let lastArrival = Date.now();
    const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        const timestamp = String(request.headers['x-saycode-usage-timestamp']);
        const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
        const parsed = AiUsageEventV1Schema.safeParse(JSON.parse(body));
        if (request.headers['x-saycode-usage-signature'] !== signature || !parsed.success) {
            refused.push(parsed.success ? 'signature' : 'schema');
            response.writeHead(400).end();
            return;
        }
        // The receiving ledger keeps one row per source event id; a redelivery changes nothing.
        if (!events.has(parsed.data.sourceEventId)) {
            events.set(parsed.data.sourceEventId, parsed.data);
            lastArrival = Date.now();
        }
        response.writeHead(202).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        secret,
        refused,
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}/usage`,
        /** The session's rows once the ledger has stopped receiving. */
        async settled(sessionId: string) {
            lastArrival = Date.now();
            await eventually(async () => Date.now() - lastArrival >= LEDGER_QUIET_MS ? true : undefined, 'usage ledger quiet', 120_000);
            return [...events.values()].filter(event => event.sessionId === sessionId);
        },
        close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}

/** Lines of the owned CLI logs that say which thread path a turn took and what it found. */
async function codexThreadLog(fixture: SessionWriteScopeFixture): Promise<string[]> {
    const directory = join(fixture.happyHome, 'logs');
    const files = (await readdir(directory).catch(() => [])).sort();
    const lines = await Promise.all(files.map(async file => (await readFile(join(directory, file), 'utf8')).split('\n')));
    return lines.flat().flatMap(line => line.match(/Thread started|Thread resumed|Usage coverage gap(?! repeated)/)?.[0] ?? []);
}

type ClaudeUsage = { input_tokens: number; output_tokens: number };

/** Usage of every assistant row in the provider's own transcripts, by message id: written by Claude, not by Happy. */
async function claudeTranscriptUsage(fixture: SessionWriteScopeFixture): Promise<Record<string, ClaudeUsage[]>> {
    const projects = join(fixture.home, '.claude', 'projects');
    const usage: Record<string, ClaudeUsage[]> = {};
    for (const project of await readdir(projects).catch(() => [])) {
        for (const file of (await readdir(join(projects, project))).filter(name => name.endsWith('.jsonl'))) {
            for (const line of (await readFile(join(projects, project, file), 'utf8')).split('\n').filter(Boolean)) {
                const row = JSON.parse(line) as { type?: string; message?: { id?: string; usage?: ClaudeUsage } };
                if (row.type === 'assistant' && row.message?.id && row.message.usage) (usage[row.message.id] ??= []).push(row.message.usage);
            }
        }
    }
    return usage;
}

const config = (fixture: SessionWriteScopeFixture) => SandboxConfigSchema.parse({
    sessionIsolation: 'strict', networkMode: 'custom', allowedDomains: ['127.0.0.1', 'localhost', fixture.modelHost] });

describe.skipIf(process.env.HAPPY_PROVIDER_USAGE_INTEGRATION !== '1' || !['darwin', 'linux'].includes(process.platform))('provider usage against a known final', () => {
    it('claude: one ledger row per model request, carrying its final usage', async () => {
        const ledger = await startLedger();
        const fixture = new SessionWriteScopeFixture({ provider: 'claude', encryptionVariant: 'legacy', usageIngest: ledger, databaseUrl: process.env.HAPPY_USAGE_DATABASE_URL });
        try {
            await fixture.start();
            const id = await fixture.spawnSession(fixture.project, config(fixture));
            await fixture.send(id, 'scope-marker-usage-claude');
            await fixture.waitReply(id, 'scope-marker-usage-claude');

            const rows = await ledger.settled(id);
            const transcript = await claudeTranscriptUsage(fixture);
            expect(ledger.refused).toEqual([]);
            expect(fixture.modelRequests.length).toBeGreaterThan(0);
            // Outside the collector: the provider's own transcript ends each request on the final usage.
            expect(Object.values(transcript).map(usages => usages.at(-1))).toMatchObject(
                fixture.modelRequests.map(() => ({ input_tokens: REQUEST_USAGE.input, output_tokens: REQUEST_USAGE.output })));
            // One row per request, named by the provider's message id, with the usage the response ended on —
            // not the `message_start` output (0 here) the assistant message is first handed over with.
            expect(rows.map(row => row.sourceEventId)).toEqual(Object.keys(transcript).map(messageId => `${id}:anthropic:${messageId}`));
            expect(rows.map(row => ({ tokens: row.tokens, quality: row.quality })))
                .toEqual(fixture.modelRequests.map(() => ({ tokens: REQUEST_USAGE, quality: 'exact' })));
        } catch (error) {
            throw new Error(`${error}\n${await fixture.diagnostics()}`, { cause: error });
        } finally {
            await fixture.close();
            await ledger.close();
        }
    });

    it('codex: new, warm and cold resumed threads report every response exactly once', async () => {
        const ledger = await startLedger();
        const fixture = new SessionWriteScopeFixture({ provider: 'codex', encryptionVariant: 'legacy', usageIngest: ledger, databaseUrl: process.env.HAPPY_USAGE_DATABASE_URL });
        const turn = async (id: string, marker: string, meta: Record<string, unknown> = {}) => {
            await fixture.http(`/v3/sessions/${id}/messages`, { messages: [{ localId: randomUUID(),
                content: Buffer.from(encrypt(fixture.sessionKey(id), 'legacy', { role: 'user', content: { type: 'text', text: marker },
                    meta: { permissionMode: 'yolo', model: fixture.modelName, ...meta } })).toString('base64') }] });
            await fixture.waitReply(id, marker);
            return { rows: await ledger.settled(id), requests: fixture.modelRequests.length, log: await codexThreadLog(fixture) };
        };
        try {
            await fixture.start();
            const id = await fixture.spawnSession(fixture.project, config(fixture));

            const started = await turn(id, 'scope-marker-usage-start');
            expect(started.log).toEqual(['Thread started']);
            expect(started.requests).toBeGreaterThan(0);
            expect(started.rows.map(row => row.tokens)).toEqual(Array.from({ length: started.requests }, () => REQUEST_USAGE));

            // Other developer instructions make the running process resume its own live thread.
            const warm = await turn(id, 'scope-marker-usage-warm', { saycodeSystemPromptEnabled: false });
            expect(warm.log).toEqual(['Thread started', 'Thread resumed']);
            expect(warm.requests).toBeGreaterThan(started.requests);
            expect(warm.rows.map(row => row.tokens)).toEqual(Array.from({ length: warm.requests }, () => REQUEST_USAGE));

            // A new process resuming the stored thread reads native request records, excluding history.
            await fixture.stopDaemon();
            await fixture.startDaemon();
            expect(await fixture.resumeSession(id)).toBe(id);
            const cold = await turn(id, 'scope-marker-usage-cold', { saycodeSystemPromptEnabled: false });
            const coldLog = cold.log.slice(warm.log.length);
            expect(cold.requests).toBeGreaterThan(warm.requests);
            expect(coldLog[0]).toBe('Thread resumed');
            expect(coldLog.filter(line => line !== 'Thread resumed')).toEqual([]);
            expect(cold.rows.map(row => row.tokens)).toEqual(Array.from({ length: cold.requests }, () => REQUEST_USAGE));
            expect(new Set(cold.rows.map(row => row.sourceEventId)).size).toBe(cold.requests);
            expect(ledger.refused).toEqual([]);
        } catch (error) {
            throw new Error(`${error}\n${await fixture.diagnostics()}`, { cause: error });
        } finally {
            await fixture.close();
            await ledger.close();
        }
    });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from './codexAppServerClient';
import { CodexSideQuestionBridge } from './codexSideQuestion';

// Opt in with HAPPY_CODEX_SIDE_NATIVE_TESTS=1 and Codex 0.166.0 on PATH.
// Only the local mock Responses endpoint is used; no provider credentials are needed.
describe.runIf(process.env.HAPPY_CODEX_SIDE_NATIVE_TESTS === '1')('native side app-server boundaries', () => {
    it('suppresses legacy notify and multi-agent advertisement and dispatch in both profiles', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-codex-side-'));
        const marker = join(root, 'notify-marker');
        const requests: { tools: { name?: string; type?: string }[]; inherited: boolean }[] = [];
        const dispatched: string[] = [];
        const server = createServer(async (req, res) => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            if (!req.url?.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const tools = body.tools ?? [];
            const side = JSON.stringify(body.input).includes('Side conversation boundary.');
            requests.push({ tools, inherited: JSON.stringify(body.input).includes('Parent reference text') });
            const n = requests.length;
            // First answer normally to exercise notify, then probe dispatch with a nonexistent agent.
            const collab = side && n === 3 && tools.some((tool: { name?: string }) => tool.name === 'multi_agent_v1');
            const item = collab
                ? { id: `fc_${n}`, type: 'function_call', status: 'completed', name: 'wait_agent', namespace: 'multi_agent_v1', call_id: `call_${n}`, arguments: JSON.stringify({ targets: ['00000000-0000-0000-0000-000000000000'], timeout_ms: 10000 }) }
                : { id: `msg_${n}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'The answer.', annotations: [] }], phase: 'final_answer' };
            const response = { id: `resp_${n}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: 2 } } };
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const events = [
                { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
                { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
                ...(!collab ? [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'The answer.' }] : []),
                { type: 'response.output_item.done', output_index: 0, item },
                { type: 'response.completed', response },
            ];
            for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
        });
        const parent = new CodexAppServerClient();
        const bridge = new CodexSideQuestionBridge({
            source: () => ({ threadId: parent.threadId, rolloutPath: parent.threadRolloutPath, cwd: root, model: 'gpt-5.4', effort: null, sandboxManagedByHappy: false }),
            launch: () => parent.prepareSideAppServer(),
            connect: async (launch, cwd) => {
                const { spawnCodexSideAppServer } = await import('./codexSideQuestion');
                const connection = await spawnCodexSideAppServer(launch, cwd);
                connection.onNotification((method, raw) => {
                    const params = raw as { item?: { type?: string } };
                    if (method === 'item/started' && params.item?.type === 'collabAgentToolCall') dispatched.push(params.item.type);
                });
                return connection;
            },
        });
        try {
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const port = (server.address() as { port: number }).port;
            await writeFile(join(root, 'config.toml'), [
                'model = "gpt-5.4"',
                'model_provider = "mock"',
                `notify = ${JSON.stringify([process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'notify\\n')`])}`,
                '[features]',
                'multi_agent = true',
                'shell_snapshot = false',
                'enable_request_compression = false',
                '[model_providers.mock]',
                'name = "mock"',
                `base_url = "http://127.0.0.1:${port}/v1"`,
                'wire_api = "responses"',
                'request_max_retries = 0',
                'stream_max_retries = 0',
                'requires_openai_auth = false',
            ].join('\n'));
            for (const key of ['HOME', 'CODEX_HOME', 'CODEX_MULTI_AUTH_DIR']) vi.stubEnv(key, root);
            vi.stubEnv('CODEX_SQLITE_HOME', join(root, 'sqlite'));
            for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']) vi.stubEnv(key, undefined);
            await parent.connect();
            await parent.startThread({ cwd: root, model: 'gpt-5.4', approvalPolicy: 'never', sandbox: 'read-only' });
            await parent.sendTurnAndWait('Parent reference text');
            await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('notify\n'));

            for (const toolProfile of ['none', 'read-only'] as const) {
                const result = await bridge.ask('What did the user ask?', { toolProfile, timeoutMs: 15000 });
                expect.soft(result).toMatchObject({ ok: true, answer: 'The answer.', toolProfile, deniedRequests: 0 });
            }
            expect(requests).toHaveLength(3);
            expect(requests[0].tools.map(tool => tool.name)).toContain('multi_agent_v1');
            expect.soft(requests[1].tools).toEqual([]);
            for (const request of requests.slice(1)) {
                expect(request.inherited).toBe(true);
                expect.soft(request.tools.map(tool => tool.name)).not.toContain('multi_agent_v1');
            }
            expect.soft(dispatched).toEqual([]);
            expect.soft(await readFile(marker, 'utf8')).toBe('notify\n');
            // The parent still owns its original notification configuration after both side processes exit.
            await parent.sendTurnAndWait('One more parent answer');
            await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('notify\nnotify\n'));
        } finally {
            bridge.dispose();
            await parent.disconnect();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    }, 45000);
});

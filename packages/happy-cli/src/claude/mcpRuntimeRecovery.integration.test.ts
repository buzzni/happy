import { afterEach, describe, expect, it } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { getIntegrationEnv } from '@/testing/currentIntegrationEnv';
import { FakeStreamableHttpMcpServer } from '@/testing/fakeStreamableHttpMcpServer';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { query } from './sdk';
import { McpRuntimeRecovery } from './mcpRuntimeRecovery';

const integrationEnv = getIntegrationEnv();
const servers: FakeStreamableHttpMcpServer[] = [];

afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers.length = 0;
});

async function waitForStatus(run: Query, serverName: string, expected: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const status = (await run.mcpServerStatus()).find((entry) => entry.name === serverName);
        if (status?.status === expected) {
            return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${serverName} status ${expected}`);
}

describe('MCP runtime recovery (real Claude SDK)', { timeout: 60_000 }, () => {
    it('recovers tools/list on the same query after a Streamable HTTP server restart', async () => {
        const server = new FakeStreamableHttpMcpServer();
        servers.push(server);
        await server.start();

        const prompt = new PushableAsyncIterable<SDKMessage>();
        const run = query({
            prompt,
            options: {
                cwd: integrationEnv.projectPath,
                maxTurns: 1,
                mcpServers: {
                    fixture: { type: 'http', url: server.url },
                },
            },
        });
        const consume = (async () => {
            for await (const _message of run) {
                // Iteration starts and keeps the same SDK query alive for control requests.
            }
        })();
        prompt.push({
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: 'Reply exactly ready.' },
        });

        try {
            const connected = await waitForStatus(run, 'fixture', 'connected');
            expect(connected.tools?.map((tool) => tool.name)).toContain('read_fixture');

            await server.stop();
            await expect(run.reconnectMcpServer('fixture')).rejects.toThrow();
            await waitForStatus(run, 'fixture', 'failed');

            await server.start();
            const recovery = new McpRuntimeRecovery(run, { backoffMs: 50 });
            await recovery.recoverFailedServers();

            const recovered = await waitForStatus(run, 'fixture', 'connected');
            expect(recovered.tools?.map((tool) => tool.name)).toContain('read_fixture');
        } finally {
            prompt.end();
            run.close();
            await consume.catch(() => {});
        }
    });
});

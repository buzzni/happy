import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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
    it('excludes blank synced plugin URLs before connection while keeping configured plugins connected', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-empty-plugin-'));
        const server = new FakeStreamableHttpMcpServer();
        servers.push(server);
        await server.start();
        vi.stubEnv('CLAUDE_CONFIG_DIR', root);
        writeFileSync(join(root, 'settings.json'), JSON.stringify({ disableClaudeAiConnectors: true }));
        try {
            for (const excluded of [false, true]) {
                const plugin = join(root, excluded ? 'plugins/synced/account/fixture' : 'fixture');
                mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
                writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
                writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: {
                    empty: { type: 'http', url: '' },
                    configured: { type: 'http', url: server.url },
                } }));
                const prompt = new PushableAsyncIterable<SDKMessage>();
                const run = query({ prompt, options: {
                    cwd: root,
                    settingSources: [],
                    // Load the fixture explicitly, without a cloud account or model request.
                    spawnClaudeCodeProcess: options => spawn(options.command, [...options.args, '--plugin-dir', plugin], {
                        cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'],
                    }),
                } });
                try {
                    await waitForStatus(run, 'plugin:fixture:configured', 'connected');
                    const empty = (await run.mcpServerStatus()).find(s => s.name === 'plugin:fixture:empty');
                    if (excluded) expect(empty).toBeUndefined();
                    else expect(empty?.status).toBe('failed');
                } finally {
                    prompt.end();
                    run.close();
                }
            }
        } finally {
            vi.unstubAllEnvs();
            rmSync(root, { recursive: true, force: true });
        }
    });

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

import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeStreamableHttpMcpServer } from './fakeStreamableHttpMcpServer';

const servers: FakeStreamableHttpMcpServer[] = [];

afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers.length = 0;
});

describe('FakeStreamableHttpMcpServer', () => {
    it('supports tools/list after restarting on the same URL', async () => {
        const server = new FakeStreamableHttpMcpServer();
        servers.push(server);

        await server.start();
        const originalUrl = server.url;
        const firstClient = new Client({ name: 'happy-recovery-test', version: '1.0.0' });
        await firstClient.connect(new StreamableHTTPClientTransport(new URL(server.url)));
        expect((await firstClient.listTools()).tools.map((tool) => tool.name)).toContain('read_fixture');

        await server.stop();
        await expect(firstClient.listTools()).rejects.toThrow();

        await server.start();
        expect(server.url).toBe(originalUrl);
        const recoveredClient = new Client({ name: 'happy-recovery-test', version: '1.0.0' });
        await recoveredClient.connect(new StreamableHTTPClientTransport(new URL(server.url)));
        expect((await recoveredClient.listTools()).tools.map((tool) => tool.name)).toContain('read_fixture');

        await firstClient.close();
        await recoveredClient.close();
    });
});

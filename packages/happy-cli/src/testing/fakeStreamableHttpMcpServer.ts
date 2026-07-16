import Fastify, { type FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export class FakeStreamableHttpMcpServer {
    private app: FastifyInstance | null = null;
    private port: number | null = null;

    get url(): string {
        if (this.port === null) {
            throw new Error('Fake MCP server has not been started');
        }
        return `http://127.0.0.1:${this.port}/mcp`;
    }

    async start(): Promise<void> {
        if (this.app) {
            return;
        }

        const app = Fastify({ forceCloseConnections: true });
        app.all('/mcp', async (request, reply) => {
            const server = new McpServer({ name: 'happy-recovery-fixture', version: '1.0.0' });
            server.registerTool('read_fixture', {
                description: 'Return a static fixture value',
                annotations: { readOnlyHint: true },
                inputSchema: {},
            }, async () => ({
                content: [{ type: 'text', text: 'fixture-ready' }],
            }));

            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await server.connect(transport);
            reply.hijack();
            reply.raw.on('close', () => {
                void transport.close();
                void server.close();
            });
            await transport.handleRequest(request.raw, reply.raw, request.body);
        });

        await app.listen({ host: '127.0.0.1', port: this.port ?? 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') {
            await app.close();
            throw new Error('Fake MCP server did not bind a TCP port');
        }
        this.port = address.port;
        this.app = app;
    }

    async stop(): Promise<void> {
        const app = this.app;
        this.app = null;
        await app?.close();
    }
}

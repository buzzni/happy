/**
 * Happy MCP STDIO Bridge
 *
 * Minimal STDIO-to-HTTP MCP bridge. It forwards tools/list and tools/call to
 * an existing HTTP MCP server using StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPPY_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`. Additional request headers
 * can be supplied as JSON through `HAPPY_HTTP_MCP_HEADERS`.
 *
 * Tool policy (aplus-dev-studio specs/agent-tool-policy R8, R9): when the entry carries the policy
 * env (`toolPolicyAdapterEnv`), every `tools/call` is decided by the session first, with the tool's
 * `tools/list` annotations, and each listing is reported for the coverage audit.
 *
 * `--cua-proxy -- <command> [args...]` runs the cua-driver shadow proxy instead (toolPolicy/cuaProxy).
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { unixMcpFetch } from '@/claude/utils/unixMcpFetch';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { cuaUpstreamEnv, parseCuaProxyArgv, startCuaProxy } from '@/toolPolicy/cuaProxy';
import { toolPolicyClientFromEnv } from '@/toolPolicy/policyClient';

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  const proxied = parseCuaProxyArgv(process.argv.slice(2));
  if (proxied) {
    const proxy = startCuaProxy({
      upstream: { ...proxied, env: cuaUpstreamEnv(process.env) },
      policy: toolPolicyClientFromEnv(process.env, 'cua-proxy'),
      input: process.stdin,
      output: process.stdout,
      onExit: (code) => process.exit(code),
    });
    process.once('SIGTERM', () => proxy.stop());
    process.once('SIGINT', () => proxy.stop());
    return;
  }

  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const socketPath = process.env.SAYCODE_MCP_SOCKET;
  const baseUrl = socketPath ? 'http://localhost/' : urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || '';
  const requestHeaders = process.env.HAPPY_HTTP_MCP_HEADERS
    ? JSON.parse(process.env.HAPPY_HTTP_MCP_HEADERS) as Record<string, string>
    : undefined;

  // `http://localhost/` is the socket sentinel; without the socket env it would dial localhost:80.
  if (!socketPath && baseUrl === 'http://localhost/') {
    process.stderr.write('[happy-mcp] Missing SAYCODE_MCP_SOCKET for the session socket; the agent did not forward the bridge env\n');
    process.exit(2);
  }

  if (socketPath && !process.env.SAYCODE_MCP_TOKEN) {
    process.stderr.write('[happy-mcp] Missing SAYCODE_MCP_TOKEN for the session socket; the agent did not forward the bridge env\n');
    process.exit(2);
  }

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happy-mcp] Missing target URL. Set HAPPY_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;
  let httpClientReady: Promise<Client> | null = null;
  let closing = false;

  async function ensureHttpClient(): Promise<Client> {
    if (closing) throw new Error('MCP bridge is closing');
    if (httpClientReady) return httpClientReady;
    const client = new Client(
      { name: 'happy-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: requestHeaders ? { headers: requestHeaders } : undefined,
      fetch: socketPath ? unixMcpFetch(socketPath, process.env.SAYCODE_MCP_TOKEN ?? '') : undefined,
    });
    // Retain the client before connect: stdin may close during initialization.
    httpClient = client;
    httpClientReady = client.connect(transport).then(() => client).catch(async (error) => {
      await client.close();
      httpClient = null;
      httpClientReady = null;
      throw error;
    });
    return httpClientReady;
  }

  const server = new Server(
    { name: 'Happy MCP Bridge', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const policy = toolPolicyClientFromEnv(process.env, 'bridge');
  const annotations = new Map<string, Record<string, unknown> | undefined>();
  const listTools = async (params: Parameters<Client['listTools']>[0]) => {
    const client = await ensureHttpClient();
    const listed = await client.listTools(params);
    for (const tool of listed.tools) annotations.set(tool.name, tool.annotations);
    policy?.toolsListed(listed.tools.map((tool) => ({ name: tool.name, annotations: tool.annotations })));
    return listed;
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await listTools(request.params) as any;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const client = await ensureHttpClient();
    if (policy) {
      const { name, arguments: args, _meta: meta } = request.params;
      // The annotations decide R8.2; a call before any listing must not be judged without them.
      if (!annotations.has(name)) await listTools(undefined).catch(() => undefined);
      const toolUseId = typeof meta?.['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId']
        : typeof meta?.callId === 'string' ? meta.callId : undefined;
      const hints = annotations.get(name);
      const verdict = await policy.decide({
        tool: name,
        args: args ?? {},
        ...(toolUseId ? { toolUseId } : {}),
        ...(hints ? { annotations: { readOnlyHint: hints.readOnlyHint as boolean | undefined, destructiveHint: hints.destructiveHint as boolean | undefined } } : {}),
      }, extra.signal);
      if (verdict.kind === 'deny') return { content: [{ type: 'text', text: verdict.reason }], isError: true };
    }
    return await client.callTool(request.params) as any;
  });

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // A dead parent must not leave this bridge alive on an HTTP stream or a
    // stalled connection. Only this process and its own transports are closed.
    const deadline = setTimeout(() => {
      process.stderr.write('[happy-mcp] Shutdown timed out\n');
      process.exit(1);
    }, 3000);
    const results = await Promise.allSettled([server.close(), httpClient?.close()]);
    clearTimeout(deadline);
    const failed = results.some(result => result.status === 'rejected');
    if (failed) process.stderr.write('[happy-mcp] Transport shutdown failed\n');
    process.exit(failed ? 1 : 0);
  };
  // StdioServerTransport does not treat stdin EOF as transport closure.
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await server.connect(stdio);
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[happy-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});

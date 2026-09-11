import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function upstream(options: { stallInitialize?: boolean } = {}) {
  const streams = new Set<ServerResponse>();
  let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      streams.add(res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      res.on('close', () => streams.delete(res));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    requests++;
    if (message.method === 'initialize' && options.stallInitialize) return;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: [{ name: 'fixture-tool', description: 'test', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return { url: `http://127.0.0.1:${address.port}/mcp`, streams, requests: () => requests };
}

function bridge(url: string, packaged = false) {
  const entry = packaged ? [resolve('bin/happy-mcp.mjs')] : ['--import', 'tsx', resolve('src/codex/happyMcpStdioBridge.ts')];
  const child = spawn(process.execPath, [...entry, '--url', url], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HAPPY_HTTP_MCP_HEADERS: '' },
  });
  let output = '';
  let stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const send = (value: object) => child.stdin.write(JSON.stringify(value) + '\n');
  return { child, send, output: () => output, stderr: () => stderr };
}

async function initialize(b: ReturnType<typeof bridge>) {
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  } });
  await expect.poll(b.output).toContain('"id":1');
  b.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await expect.poll(b.output).toContain('fixture-tool');
}

function isRunning(child: ChildProcessWithoutNullStreams) {
  return child.exitCode === null && child.signalCode === null;
}

describe('Happy MCP bridge process lifetime', () => {
  it('exits on EOF before opening any upstream connection', async () => {
    const http = await upstream();
    const b = bridge(http.url);
    b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } });
    await expect.poll(b.output).toContain('"id":1');
    b.child.stdin.end();
    await expect.poll(() => isRunning(b.child)).toBe(false);
    expect(b.child.exitCode).toBe(0);
    expect(http.requests()).toBe(0);
  });

  it.each([false, true])('exits after EOF and preserves a peer bridge (packaged=%s)', async (packaged) => {
    const http = await upstream();
    const owner = bridge(http.url, packaged);
    const peer = bridge(http.url);
    await initialize(owner);
    await initialize(peer);
    await expect.poll(() => http.streams.size).toBe(2);
    owner.child.stdin.end();
    await expect.poll(() => isRunning(owner.child), { timeout: 3000 }).toBe(false);
    expect(owner.child.exitCode).toBe(0);
    await expect.poll(() => http.streams.size).toBe(1);
    expect(isRunning(peer.child)).toBe(true);
    peer.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    await expect.poll(() => {
      const response = peer.output().split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).find(message => message.id === 3);
      return response?.result?.tools?.some((tool: { name: string }) => tool.name === 'fixture-tool');
    }).toBe(true);
    expect(owner.stderr()).toBe('');
  }, 15000);

  it('exits when stdin closes during HTTP initialization', async () => {
    const http = await upstream({ stallInitialize: true });
    const b = bridge(http.url);
    b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } });
    await expect.poll(b.output).toContain('"id":1');
    b.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await expect.poll(http.requests).toBe(1);
    b.child.stdin.end();
    await expect.poll(() => isRunning(b.child), { timeout: 4000 }).toBe(false);
    expect(b.child.exitCode).toBe(0);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('closes its HTTP stream on %s', async (signal) => {
    const http = await upstream();
    const b = bridge(http.url);
    await initialize(b);
    await expect.poll(() => http.streams.size).toBe(1);
    b.child.kill(signal);
    await expect.poll(() => isRunning(b.child)).toBe(false);
    expect(b.child.exitCode).toBe(0);
    await expect.poll(() => http.streams.size).toBe(0);
  });
});

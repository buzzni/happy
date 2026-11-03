import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createReservationNativeBroker, type ReservationBrokerInput } from './reservationNativeBroker';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(): ReservationBrokerInput {
  return { runId: 'run', agent: 'claude', model: 'chosen-model', ai: { baseUrl: 'https://provider.invalid', headers: { Authorization: 'Bearer raw-ai-secret' } },
    connectors: {}, connectorPolicy: 'none', requiredConnectors: [], authorize: vi.fn(async () => {}), execute: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })), fetch: vi.fn() };
}
async function connected(input: ReservationBrokerInput) {
  const broker = await createReservationNativeBroker(input); cleanup.push(broker.close);
  const client = new Client({ name: 'test', version: '1' }); cleanup.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${broker.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${broker.token}` } } }));
  return { broker, client };
}
it('admits every tool call under the current epoch and exposes no raw credential or Happy chat creation tool', async () => {
  const input = fixture(), { broker, client } = await connected(input);
  const listed = await client.listTools();
  expect(listed.tools.map(tool => tool.name)).toEqual(['reservation_exec']);
  expect(JSON.stringify(listed)).not.toContain('raw-ai-secret');
  expect((await client.callTool({ name: 'reservation_exec', arguments: { command: 'pwd' } })).isError).not.toBe(true);
  expect(input.execute).toHaveBeenCalledWith('pwd', expect.any(AbortSignal));
  vi.mocked(input.authorize).mockRejectedValue(new Error('revoked'));
  await expect(client.callTool({ name: 'reservation_exec', arguments: { command: 'another' } })).rejects.toThrow();
  expect(input.execute).toHaveBeenCalledOnce();
  expect(await fetch(`http://127.0.0.1:${broker.port}/mcp`, { method: 'POST' }).then(value => value.status)).toBe(401);
});
it('keeps task tokens in the host and fills the exact task envelope with a stable idempotency key', async () => {
  const input = fixture(); input.task = { taskId: 'task', type: 'pr_review.v1', agentRunId: 'agent-run', claimToken: 'raw-task-secret', completeToken: 'raw-complete-secret', controlUrl: 'https://task.invalid/api/agent-tasks', input: {}, context: [] };
  vi.mocked(input.fetch!).mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  const { client } = await connected(input), args = { operation: 'complete', result: { findings: [] } };
  await client.callTool({ name: 'reservation_agent_task', arguments: args }); await client.callTool({ name: 'reservation_agent_task', arguments: args });
  const bodies = vi.mocked(input.fetch!).mock.calls.map(call => JSON.parse(call[1]!.body as string));
  expect(bodies[0]).toMatchObject({ version: 1, token: 'raw-complete-secret', agentRunId: 'agent-run', result: { findings: [] } });
  expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
  expect(JSON.stringify(await client.listTools())).not.toContain('raw-task-secret');
});
it('refuses another model before contacting the upstream and substitutes selected host credentials', async () => {
  const input = fixture(); vi.mocked(input.fetch!).mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  const { broker } = await connected(input);
  const request = (model: string) => fetch(`http://127.0.0.1:${broker.port}/ai/v1/messages`, { method: 'POST', headers: { Authorization: `Bearer ${broker.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [] }) });
  expect((await request('other-model')).status).toBe(403); expect(input.fetch).not.toHaveBeenCalled();
  expect((await request('chosen-model')).status).toBe(200);
  expect(input.fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer raw-ai-secret' }) }));
});
it('never offers publish to a read-only review and refuses a moved head before creating any GitHub objects', async () => {
  const input = fixture(); input.github = { repository: 'owner/repo', token: 'raw-github-secret', number: 12, headSha: 'a'.repeat(40), mode: 'review' };
  const review = await connected(input); expect((await review.client.listTools()).tools.map(value => value.name)).not.toContain('reservation_github_publish_fix');
  const applyInput = { ...input, github: { ...input.github, mode: 'apply' as const } };
  vi.mocked(input.fetch!).mockResolvedValue(new Response(JSON.stringify({ state: 'open', head: { sha: 'b'.repeat(40), ref: 'feature' } }), { status: 200 }));
  const apply = await connected(applyInput);
  await expect(apply.client.callTool({ name: 'reservation_github_publish_fix', arguments: { title: 'fix', body: 'body', message: 'fix', files: [{ path: 'file.ts', contentBase64: 'eA==' }] } })).rejects.toThrow();
  expect(input.fetch).toHaveBeenCalledTimes(1); expect(vi.mocked(input.fetch!).mock.calls[0][1]?.method).toBe('GET');
});

it.each(['apply', 'issue'] as const)('recovers lost publication ACKs idempotently within its fixed GitHub %s target', async mode => {
  const input = fixture(), base = 'a'.repeat(40), tree = 'c'.repeat(40), commit = 'd'.repeat(40);
  input.github = { repository: 'owner/repo', token: 'raw-github-secret', number: 12, headSha: base, mode };
  let branchCreated = false, prCreated = false;
  const branch = `${mode === 'issue' ? 'issue-fix' : 'review-fix'}/12-aaaaaaa`, baseRef = mode === 'issue' ? 'main' : 'feature';
  const pr = { html_url: 'https://github.com/owner/repo/pull/99', head: { sha: commit, ref: branch }, base: { ref: baseRef } };
  vi.mocked(input.fetch!).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname.replace('/repos/owner/repo', ''), method = options?.method;
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path === '/issues/12') return ok({ state: 'open' });
    if (path === '') return ok({ default_branch: 'main' });
    if (path === '/branches/main') return ok({ commit: { sha: base } });
    if (path === '/pulls/12') return ok({ state: 'open', head: { sha: base, ref: 'feature', repo: { full_name: 'owner/repo' } } });
    if (path === '/git/commits/' + base) return ok({ tree: { sha: 'b'.repeat(40) } });
    if (path === '/git/blobs') return ok({ sha: 'b'.repeat(40) });
    if (path === '/git/trees') return ok({ sha: tree });
    if (path === '/git/commits' && method === 'POST') return ok({ sha: commit });
    if (path === '/git/commits/' + commit) return ok({ tree: { sha: tree }, parents: [{ sha: base }], message: 'fix' });
    if (path.startsWith('/git/ref/heads/')) return branchCreated ? ok({ object: { sha: commit } }) : new Response('{}', { status: 404 });
    if (path === '/git/refs' && method === 'POST') { branchCreated = true; throw new TypeError('lost ref ACK'); }
    if (path === '/pulls' && method === 'GET') return ok(prCreated ? [pr] : []);
    if (path === '/pulls' && method === 'POST') { prCreated = true; throw new TypeError('lost PR ACK'); }
    throw new Error('Unexpected fixture route: ' + path);
  });
  const { client } = await connected(input), args = { title: 'fix', body: 'details', message: 'fix', files: [{ path: 'src/file.ts', contentBase64: 'eA==' }] };
  const first = await client.callTool({ name: 'reservation_github_publish_fix', arguments: args });
  expect(JSON.stringify(first)).toContain('https://github.com/owner/repo/pull/99');
  expect(JSON.stringify(first)).not.toContain('raw-github-secret');
  const count = vi.mocked(input.fetch!).mock.calls.length;
  expect(await client.callTool({ name: 'reservation_github_publish_fix', arguments: args })).toEqual(first);
  expect(input.fetch).toHaveBeenCalledTimes(count);
  expect(vi.mocked(input.fetch!).mock.calls.filter(call => call[1]?.method === 'POST' && String(call[0]).endsWith('/git/refs'))).toHaveLength(1);
  await expect(client.callTool({ name: 'reservation_github_publish_fix', arguments: { ...args, message: 'different result' } })).rejects.toThrow();
});

it.each(['optional', 'required'] as const)('preserves the %s connector failure policy without exposing credentials', async connectorPolicy => {
  const server = createServer((_request, response) => response.writeHead(401).end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const input = { ...fixture(), connectorPolicy, requiredConnectors: connectorPolicy === 'required' ? ['github'] : [],
    connectors: { github: { type: 'http' as const, url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer connector-host-secret' } } } };
  try {
    if (connectorPolicy === 'required') await expect(createReservationNativeBroker(input)).rejects.toThrow('RESERVATION_CONNECTOR_UNAVAILABLE');
    else { const { client } = await connected(input); expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['reservation_exec']); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('enforces the existing tool policy using the original connector tool name before forwarding', async () => {
  const source = fixture(), upstream = await connected(source);
  const executed = fixture(), policy = { decide: vi.fn(async () => ({ kind: 'deny' as const, reason: 'needs person', reasonCode: 'unattended' })), toolsListed: vi.fn() };
  const input = { ...executed, policy, connectorPolicy: 'required' as const, requiredConnectors: ['github'], connectors: { github: { type: 'http' as const,
    url: `http://127.0.0.1:${upstream.broker.port}/mcp`, headers: { Authorization: `Bearer ${upstream.broker.token}` } } } };
  const downstream = await connected(input), tool = (await downstream.client.listTools()).tools.find(tool => tool.name.startsWith('connector_'))!;
  await expect(downstream.client.callTool({ name: tool.name, arguments: { command: 'pwd' } })).rejects.toThrow();
  expect(policy.decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'mcp__github__reservation_exec', toolInput: { command: 'pwd' }, origin: 'bridge' }), expect.any(AbortSignal));
  expect(source.execute).not.toHaveBeenCalled();
});

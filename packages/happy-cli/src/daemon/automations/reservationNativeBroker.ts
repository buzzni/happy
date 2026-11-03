import type { ToolPolicyGate } from '@/toolPolicy/policyGate';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { AutomationAgentTaskDispatch } from './automationAgentTaskBridge';

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const taskInput = z.object({ operation: z.enum(['start', 'heartbeat', 'complete', 'fail']), result: z.unknown().optional(), reason: z.string().max(2000).optional() }).strict();
const execInput = z.object({ command: z.string().min(1).max(64000) }).strict();
const publishInput = z.object({ title: z.string().min(1).max(240), body: z.string().max(64000), message: z.string().min(1).max(4000),
  files: z.array(z.object({ path: z.string().min(1).max(4096).refine(value => !value.startsWith('/') && !value.split('/').some(part => ['..', '.git', ''].includes(part)) && !/[\x00-\x1f]/.test(value)),
    mode: z.enum(['100644', '100755', '120000']).default('100644'), contentBase64: z.string().max(2 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).nullable() }).strict()).min(1).max(200),
}).strict();
type GithubScope = { token: string; repository: string; number: number; headSha: string; mode: 'review' | 'apply' | 'issue'; origin?: string };
export type ReservationBrokerInput = {
  policy?: ToolPolicyGate;
  runId: string; agent: 'claude' | 'codex'; model: string;
  /** Credentials are obtained from the selected AI account by the trusted host, never from the model. */
  ai: { baseUrl: string; headers: Record<string, string> };
  github?: GithubScope; task?: AutomationAgentTaskDispatch | null;
  connectors: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>;
  connectorPolicy: 'none' | 'optional' | 'required'; requiredConnectors: string[];
  authorize(): Promise<void>;
  execute(command: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  fetch?: typeof fetch;
};

async function body(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > 16 * 1024 * 1024) throw new Error('RESERVATION_REQUEST_LIMIT'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function equalSecret(value: string | undefined, expected: string): boolean {
  const a = Buffer.from(value ?? ''), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b);
}

/** Raw AI/GitHub/task/connector credentials stay in this host process. Only one revocable broker capability leaves it. */
export async function createReservationNativeBroker(input: ReservationBrokerInput) {
  const token = randomBytes(32).toString('base64url'), controller = new AbortController(), fetchImpl = input.fetch ?? fetch;
  const clients: Client[] = [], tools: Tool[] = [], calls = new Map<string, (args: unknown) => Promise<unknown>>();
  let closed = false, aiActive = 0, toolActive = 0;
  const publications = new Map<string, Promise<unknown>>();
  const admit = async () => { if (closed || controller.signal.aborted) throw new Error('RESERVATION_AUTHORITY_LOST'); await input.authorize(); if (closed) throw new Error('RESERVATION_AUTHORITY_LOST'); };
  const knownSecrets = [token, ...Object.values(input.ai.headers), input.github?.token, input.task?.claimToken, input.task?.completeToken,
    ...Object.values(input.connectors).flatMap(value => Object.values(value.headers ?? {}))].filter((value): value is string => !!value && value.length >= 8).flatMap(value => [value, value.replace(/^Bearer\s+/i, '')]);
  const redact = (value: unknown) => {
    let encoded = JSON.stringify(value); for (const secret of knownSecrets) encoded = encoded.split(secret).join('[REDACTED]'); return JSON.parse(encoded);
  };
  const register = (name: string, description: string, inputSchema: Tool['inputSchema'], call: (args: unknown) => Promise<unknown>) => {
    if (calls.has(name)) throw new Error('RESERVATION_TOOL_COLLISION'); tools.push({ name, description, inputSchema }); calls.set(name, call);
  };
  register('reservation_exec', 'Run a command only in this reservation worktree. No host credentials are inherited.',
    { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    async args => input.execute(execInput.parse(args).command, controller.signal));
  if (input.task) register('reservation_agent_task', 'Start, heartbeat, complete or fail this one assigned AgentTask. Supply the result object directly; credentials and retry envelopes are filled by the host.',
    { type: 'object', properties: { operation: { type: 'string', enum: ['start', 'heartbeat', 'complete', 'fail'] }, result: {}, reason: { type: 'string' } }, required: ['operation'], additionalProperties: false }, async args => {
      const value = taskInput.parse(args), task = input.task!;
      if (value.operation === 'complete' && value.result === undefined || value.operation === 'fail' && !value.reason) throw new Error('RESERVATION_TASK_INPUT_INVALID');
      const payload = { version: 1, token: value.operation === 'complete' ? task.completeToken : task.claimToken, agentRunId: task.agentRunId,
        ...(value.operation === 'complete' || value.operation === 'fail' ? { idempotencyKey: createHash('sha256').update(JSON.stringify([input.runId, value])).digest('hex') } : {}),
        ...(value.operation === 'complete' ? { result: value.result } : value.operation === 'fail' ? { reason: value.reason } : {}) };
      await admit();
      const response = await fetchImpl(`${task.controlUrl}/${encodeURIComponent(task.taskId)}/${value.operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), redirect: 'error' });
      const result = await response.json().catch(() => ({})); return { status: response.status, ok: response.ok, result: redact(result) };
    });
  const github = async (method: string, path: string, payload?: unknown): Promise<any> => {
    const scope = input.github!; await admit();
    const response = await fetchImpl(`${scope.origin ?? 'https://api.github.com'}/repos/${scope.repository}${path}`, { method,
      headers: { Authorization: `Bearer ${scope.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), redirect: 'error' });
    if (!response.ok) throw new Error(`RESERVATION_GITHUB_HTTP_${response.status}`);
    return response.json();
  };
  if (input.github) {
    const scope = input.github;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository) || !Number.isSafeInteger(scope.number) || scope.number <= 0 || !sha.safeParse(scope.headSha).success) throw new Error('RESERVATION_GITHUB_SCOPE_INVALID');
    register('reservation_github_read', 'Read only this reservation pull request or issue. Other repositories and numbers cannot be selected.',
      { type: 'object', properties: { view: { type: 'string', enum: ['details', 'files', 'comments'] } }, additionalProperties: false }, async args => {
        const value = z.object({ view: z.enum(['details', 'files', 'comments']).default('details') }).strict().parse(args ?? {});
        if (scope.mode === 'issue') return github('GET', `/issues/${scope.number}${value.view === 'comments' ? '/comments' : ''}`);
        return github('GET', `/pulls/${scope.number}${value.view === 'files' ? '/files' : value.view === 'comments' ? '/comments' : ''}`);
      });
    if (scope.mode === 'apply' || scope.mode === 'issue') register('reservation_github_publish_fix', 'Publish reviewed changes to a review-fix branch and a stacked pull request. The reviewed PR head must still match the pinned SHA. Never pushes to the reviewed branch.',
      { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, message: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, mode: { type: 'string', enum: ['100644', '100755', '120000'] }, contentBase64: { type: ['string', 'null'] } }, required: ['path', 'contentBase64'] } } }, required: ['title', 'body', 'message', 'files'], additionalProperties: false }, async args => {
        const value = publishInput.parse(args);
        if (new Set(value.files.map(file => file.path)).size !== value.files.length) throw new Error('RESERVATION_DUPLICATE_PATH');
        const publicationKey = createHash('sha256').update(JSON.stringify(value)).digest('hex');
        const existingPublication = publications.get(publicationKey); if (existingPublication) return existingPublication;
        if (publications.size) throw new Error('RESERVATION_PUBLICATION_ALREADY_SELECTED');
        const publish = (async () => {
        const readTarget = async () => {
          if (scope.mode !== 'issue') {
            const pr = await github('GET', `/pulls/${scope.number}`);
            if (pr.state !== 'open' || pr.head?.sha !== scope.headSha || typeof pr.head?.ref !== 'string' || pr.head?.repo?.full_name && pr.head.repo.full_name !== scope.repository) throw new Error('RESERVATION_GITHUB_HEAD_CHANGED');
            return pr.head.ref as string;
          }
          const issue = await github('GET', `/issues/${scope.number}`), repository = await github('GET', '');
          if (issue.state !== 'open' || issue.pull_request || typeof repository.default_branch !== 'string') throw new Error('RESERVATION_GITHUB_HEAD_CHANGED');
          const branch = await github('GET', `/branches/${encodeURIComponent(repository.default_branch)}`);
          if (branch.commit?.sha !== scope.headSha) throw new Error('RESERVATION_GITHUB_HEAD_CHANGED');
          return repository.default_branch as string;
        };
        const base = await readTarget();
        const commit = await github('GET', `/git/commits/${scope.headSha}`);
        const tree: Array<Record<string, unknown>> = [];
        for (const file of value.files) {
          if (file.contentBase64 === null) tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: null });
          else { const blob = await github('POST', '/git/blobs', { content: file.contentBase64, encoding: 'base64' }); tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: sha.parse(blob.sha) }); }
        }
        const createdTree = await github('POST', '/git/trees', { base_tree: sha.parse(commit.tree?.sha), tree });
        const createdCommit = await github('POST', '/git/commits', { message: value.message, tree: sha.parse(createdTree.sha), parents: [scope.headSha] });
        // Check again immediately before creating any visible branch/PR.
        if (await readTarget() !== base) throw new Error('RESERVATION_GITHUB_HEAD_CHANGED');
        const branch = `${scope.mode === 'issue' ? 'issue-fix' : 'review-fix'}/${scope.number}-${scope.headSha.slice(0, 7)}`;
        const refPath = '/git/ref/heads/' + branch.split('/').map(encodeURIComponent).join('/');
        const readRef = async () => { try { return await github('GET', refPath); } catch (error) { if ((error as Error).message === 'RESERVATION_GITHUB_HTTP_404') return null; throw error; } };
        let reference = await readRef();
        if (!reference) {
          try { reference = await github('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: sha.parse(createdCommit.sha) }); }
          catch (error) { reference = await readRef(); if (!reference) throw error; }
        }
        const refSha = sha.parse(reference.object?.sha), selected = await github('GET', `/git/commits/${refSha}`);
        if (selected.tree?.sha !== createdTree.sha || selected.parents?.length !== 1 || selected.parents[0].sha !== scope.headSha || selected.message !== value.message) throw new Error('RESERVATION_GITHUB_BRANCH_CONFLICT');
        if (await readTarget() !== base) throw new Error('RESERVATION_GITHUB_HEAD_CHANGED');
        const query = `/pulls?state=open&head=${encodeURIComponent(scope.repository.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(base)}`;
        const findPr = async () => {
          const matches = await github('GET', query);
          if (!Array.isArray(matches) || matches.length > 1) throw new Error('RESERVATION_GITHUB_PR_CONFLICT');
          const candidate = matches[0];
          if (candidate && (candidate.head?.sha !== refSha || candidate.head?.ref !== branch || candidate.base?.ref !== base)) throw new Error('RESERVATION_GITHUB_PR_CONFLICT');
          return candidate;
        };
        let result = await findPr();
        if (!result) {
          try { result = await github('POST', '/pulls', { title: value.title, head: branch, base,
            body: `${value.body}\n\n${scope.mode === 'issue' ? 'Issue' : 'Review follow-up'}: https://github.com/${scope.repository}/${scope.mode === 'issue' ? 'issues' : 'pull'}/${scope.number}\nPinned head: ${scope.headSha}` }); }
          catch (error) { result = await findPr(); if (!result) throw error; }
        }
        return { fixBranch: branch, fixPrUrl: result.html_url, sha: refSha };
        })();
        publications.set(publicationKey, publish);
        try { return await publish; } catch (error) { publications.delete(publicationKey); throw error; }

      });
  }
  try {
    if (input.connectorPolicy === 'none' && input.requiredConnectors.length) throw new Error('RESERVATION_CONNECTOR_POLICY_INVALID');
    if (input.connectorPolicy !== 'none') for (const [name, config] of Object.entries(input.connectors)) {
      const client = new Client({ name: 'saycode-reservation', version: '1' }); clients.push(client);
      let listed: Awaited<ReturnType<Client['listTools']>>;
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
        listed = await client.listTools();
        if (input.connectorPolicy === 'required' && input.requiredConnectors.includes(name) && !listed.tools.length) throw new Error();
      } catch {
        await client.close().catch(() => {});
        if (input.connectorPolicy === 'required') throw new Error('RESERVATION_CONNECTOR_UNAVAILABLE');
        continue;
      }
      input.policy?.toolsListed(listed.tools.map(tool => ({ name: `mcp__${name}__${tool.name}`, annotations: tool.annotations })));
      for (const tool of listed.tools) {
        const exposed = `connector_${createHash('sha256').update(name + ':' + tool.name).digest('hex').slice(0, 24)}`;
        register(exposed, `${name}: ${tool.description ?? tool.name}`, tool.inputSchema, async args => {
          const verdict = await input.policy?.decide({ toolName: `mcp__${name}__${tool.name}`, toolInput: args, origin: 'bridge', annotations: tool.annotations }, controller.signal);
          if (verdict?.kind === 'deny' || verdict?.kind === 'ask') throw new Error('RESERVATION_TOOL_POLICY_DENIED');
          await admit(); return client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { signal: controller.signal });
        });
      }
    }
    if (input.connectorPolicy === 'required' && (!input.requiredConnectors.length || !Object.keys(input.connectors).length)) throw new Error('RESERVATION_CONNECTOR_REQUIRED');
  } catch (error) { await Promise.allSettled(clients.map(client => client.close())); throw error; }
  const server = createServer(async (request, response) => {
    try {
      if (!equalSecret(request.headers.authorization?.replace(/^Bearer /, ''), token) && !equalSecret(request.headers['x-api-key'] as string | undefined, token)) { response.writeHead(401).end(); return; }
      await admit();
      if (request.url?.startsWith('/ai/')) { if (aiActive >= 4) { response.writeHead(429).end(); return; } aiActive++; try { await proxyAi(request, response); } finally { aiActive--; } return; }
      if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
      const mcp = new Server({ name: 'saycode-reservation', version: '1' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      mcp.setRequestHandler(CallToolRequestSchema, async value => {
        if (toolActive >= 8) throw new Error('RESERVATION_REQUEST_LIMIT');
        toolActive++; try {
        await admit(); const call = calls.get(value.params.name); if (!call) throw new Error('RESERVATION_TOOL_DENIED');
        const result = redact(await call(value.params.arguments ?? {}));
        return result && Array.isArray(result.content) ? result : json(result);
        } finally { toolActive--; }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport); await transport.handleRequest(request, response, request.method === 'POST' ? await body(request) : undefined);
    } catch { if (!response.headersSent) response.writeHead(403); response.end(); }
  });
  const proxyAi = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url!.slice(3);
    if (!['/v1/messages', '/v1/messages/count_tokens', '/responses', '/v1/responses', '/models', '/v1/models'].includes(path)) throw new Error('RESERVATION_AI_ROUTE_DENIED');
    const value = request.method === 'POST' ? await body(request) : undefined;
    if (value && value.model !== input.model && !(input.agent === 'claude' && ['sonnet', 'opus', 'haiku'].includes(input.model) && new RegExp('^claude-' + input.model + '-[A-Za-z0-9.-]+$').test(value.model))) throw new Error('RESERVATION_AI_MODEL_DENIED');
    const target = new URL(input.ai.baseUrl);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) throw new Error('RESERVATION_AI_ORIGIN_DENIED');
    target.pathname = target.pathname.replace(/\/$/, '') + path;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...input.ai.headers };
    for (const name of ['anthropic-version', 'anthropic-beta', 'openai-beta', 'accept']) if (typeof request.headers[name] === 'string') headers[name] = headers[name] ? headers[name] + ',' + request.headers[name] : request.headers[name] as string;
    const upstream = await fetchImpl(target, { method: request.method, headers, ...(value ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]), redirect: 'error' });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
    if (!upstream.body) { response.end(); return; }
    for await (const chunk of upstream.body as any) { if (closed || response.destroyed) break; if (!response.write(chunk)) await Promise.race([once(response, 'drain'), once(response, 'close')]); }
    response.end();
  };
  server.maxConnections = 32; server.headersTimeout = 10000; server.requestTimeout = 30000;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); }); }
  catch { await Promise.allSettled(clients.map(client => client.close())); throw new Error('RESERVATION_BROKER_UNAVAILABLE'); }
  const port = (server.address() as { port: number }).port;
  return { token, port, tools: tools.map(tool => tool.name),
    /** Native config contains only this one run capability, never underlying credentials. */
    url: `http://host.docker.internal:${port}`,
    close: async () => { closed = true; controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await Promise.allSettled(clients.map(client => client.close())); },
  };
}

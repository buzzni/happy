import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { decryptScriptValue, encryptScriptValue, openScriptValueForMachine } from '@slopus/happy-wire';
import { createScriptAutomationTools, resolveScriptAutomationScope, runScriptAutomationTool } from './scriptAutomationTools';
const runtime = vi.hoisted(() => ({ credentials: vi.fn(), machineCredentials: vi.fn(async (): Promise<unknown> => null), settings: vi.fn(async () => ({})), refresh: vi.fn(async () => false), machineKey: vi.fn() }));
vi.mock('@/resume/localHappyAgentAuth', () => ({ readLocalHappyAgentCredentials: runtime.credentials }));
vi.mock('@/persistence', async () => ({ ...await vi.importActual<typeof import('@/persistence')>('@/persistence'), readCredentials: runtime.machineCredentials, readSettings: runtime.settings }));
vi.mock('@/daemon/automations/machineAutomationKey', () => ({ readMachineAutomationKey: runtime.machineKey }));
vi.mock('@/aplus/refreshMcpCallerGrant', () => ({ refreshMcpCallerGrantIfExpiring: runtime.refresh }));
let directory: string;
const pair = nacl.box.keyPair();
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'script-agent-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function setup(localAutomationKey?: nacl.BoxKeyPair) {
  const rows: any[] = [];
  const request = vi.fn(async (body: any): Promise<any> => {
    if (body.operation === 'target') return { machineId: 'machine', automationProtocolVersion: 5, machineKeyVersion: 1, viewerKeyVersion: 1,
      viewerPublicKey: Buffer.from(pair.publicKey).toString('base64'), machinePublicKey: Buffer.from(pair.publicKey).toString('base64') };
    if (body.operation === 'list') return { automations: rows };
    if (body.operation === 'upsert') {
      const r = body.registration;
      const row = { id: 'same-admin-id', projectId: 'project', revision: 1, generation: 1, ...r };
      rows.splice(0, rows.length, row);
      return { automation: row };
    }
    throw new Error('unexpected request');
  });
  const tools = createScriptAutomationTools({ projectId: 'project', directory, viewerKeyPair: pair, request,
    ...(localAutomationKey ? { localAutomationKey } : {}) });
  return { tools, request, rows };
}
it('encrypts the local bundle and preserves the same admin ID when the registration is retried', async () => {
  const source = 'console.log("collected")';
  await writeFile(join(directory, 'collect.mjs'), source);
  const { tools, request } = setup();
  const input = { operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath: 'collect.mjs', name: 'Collect', schedule: null };
  expect(await tools.execute(input)).toMatchObject({ id: 'same-admin-id', revision: 1 });
  expect(await tools.execute(input)).toMatchObject({ id: 'same-admin-id', revision: 1 });
  const writes = request.mock.calls.filter(([body]) => body.operation === 'upsert');
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(writes)).not.toContain(source);
  const registration = writes[0][0].registration;
  expect(decryptScriptValue({ encrypted: registration.artifact, recipient: 'machine', secretKey: pair.secretKey,
    context: { projectId: 'project', resourceId: registration.admission.artifactId, purpose: 'artifact' } })).toEqual({ source });
  expect(await tools.execute({ operation: 'list' })).toMatchObject([{ id: 'same-admin-id', name: 'Collect' }]);
})
it('rejects files outside the project and a symlink escape before registering any code', async () => {
  const { tools, request } = setup();
  await symlink('/etc/hosts', join(directory, 'escape.mjs'));
  for (const sourcePath of ['/etc/hosts', '../outside.mjs', 'escape.mjs']) {
    await expect(tools.execute({ operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath, name: 'Collect', schedule: null })).rejects.toThrow();
  }
  expect(request.mock.calls.some(([body]) => body.operation === 'upsert')).toBe(false);
})
it('cannot silently overwrite an intervening revision', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const { tools, rows, request } = setup();
  const input = { operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath: 'collect.mjs', name: 'Collect', schedule: null };
  await tools.execute(input);
  rows[0].revision = 3;
  await expect(tools.execute(input)).rejects.toThrow('REVISION_CONFLICT');
  expect(request.mock.calls.filter(([body]) => body.operation === 'upsert')).toHaveLength(1);
})

it('fetches encrypted logs only when one run is explicitly requested', async () => {
  const encrypted = encryptScriptValue({ value: { log: 'done', truncated: false },
    context: { projectId: 'project', resourceId: 'run-1', purpose: 'log' }, viewerPublicKey: pair.publicKey, machinePublicKey: pair.publicKey });
  const request = vi.fn(async (body: any) => body.operation === 'runs' && body.runId
    ? { logCiphertext: JSON.stringify(encrypted) }
    : { runs: [{ id: 'run-1', status: 'COMPLETED', hasLog: true }] });
  const tools = createScriptAutomationTools({ projectId: 'project', directory, viewerKeyPair: pair, request });

  expect(await tools.execute({ operation: 'list_runs', automationId: 'automation' })).toEqual([{ id: 'run-1', status: 'COMPLETED', hasLog: true }]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await tools.execute({ operation: 'list_runs', automationId: 'automation', runId: 'run-1' })).toEqual([
    { id: 'run-1', status: 'COMPLETED', hasLog: true, log: { log: 'done', truncated: false } },
  ]);
  expect(request).toHaveBeenLastCalledWith({ operation: 'runs', automationId: 'automation', runId: 'run-1' });
})

/*
 * aplus-dev-studio specs/e2ee-machine-control-boundary R13 — the agent cannot sign as
 * the customer, but code it registers for its own machine is sealed by that machine's
 * automation key, which the daemon trusts for scripts.
 */
async function registered(localAutomationKey: nacl.BoxKeyPair) {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const { tools, request } = setup(localAutomationKey);
  await tools.execute({ operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath: 'collect.mjs', name: 'Collect', schedule: null });
  const registration = request.mock.calls.find(([body]) => body.operation === 'upsert')![0].registration;
  const open = (encrypted: unknown, resourceId: string, purpose: 'configuration' | 'artifact') => openScriptValueForMachine({
    encrypted: encrypted as never, context: { projectId: 'project', resourceId, purpose }, secretKey: pair.secretKey });
  return [open(registration.encrypted, 'collect', 'configuration'), open(registration.artifact, registration.admission.artifactId, 'artifact')];
}
it('seals the settings and code for its own machine with that machine\'s automation key', async () => {
  for (const opened of await registered(pair)) {
    expect(opened).toMatchObject({ ok: true, authentication: { kind: 'authenticated', senderPublicKey: pair.publicKey } });
  }
});
it('seals anonymously when the target is another machine, whose key it does not hold', async () => {
  for (const opened of await registered(nacl.box.keyPair())) {
    expect(opened).toMatchObject({ ok: true, authentication: { kind: 'anonymous' } });
  }
});

const grantWith = (payload: Record<string, unknown>) => `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

it('uses the project scope from the MCP config URL', () => {
  expect(resolveScriptAutomationScope('https://saycode.ai/api/me/mcp-config?project_id=P-1', grantWith({ projectId: 'P-1', personalChatId: null }))).toBe('P-1');
});

it('uses the Chat scope from a Chat session grant when the config URL has no project', () => {
  expect(resolveScriptAutomationScope('https://saycode.ai/api/me/mcp-config', grantWith({ projectId: null, personalChatId: 'C-1' }))).toBe('chat:C-1');
});

it('has no scope when neither the config URL nor the grant names a project or Chat', () => {
  expect(resolveScriptAutomationScope('https://saycode.ai/api/me/mcp-config', grantWith({ projectId: null, personalChatId: null }))).toBeNull();
  expect(resolveScriptAutomationScope('https://saycode.ai/api/me/mcp-config', 'not-a-grant')).toBeNull();
  expect(resolveScriptAutomationScope('https://saycode.ai/api/me/mcp-config', undefined)).toBeNull();
});

function runtimeFixture() {
  runtime.credentials.mockReturnValue({ token: 'fixture-only-token', secret: nacl.randomBytes(32), contentKeyPair: pair });
  runtime.machineCredentials.mockResolvedValue(null);
  runtime.settings.mockResolvedValue({});
  runtime.refresh.mockClear();
  runtime.machineKey.mockReturnValue(null);
  vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.fixture/api/me/mcp-config?project_id=project');
  vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', grantWith({ projectId: 'project' }));
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  return { fetch, session: { directory, machineId: 'pc' } };
}

it('uses dataKey machine credentials and the refreshed caller grant for script list', async () => {
  const f = runtimeFixture();
  runtime.credentials.mockReturnValue(null);
  runtime.machineCredentials.mockResolvedValue({ token: 'machine-token', encryption: { type: 'dataKey', publicKey: pair.publicKey, machineKey: nacl.randomBytes(32) } });
  runtime.machineKey.mockReturnValue({ ...pair, registeredKeyVersion: 1 });
  f.fetch.mockImplementation(async (url: URL) => String(url).endsWith('/automation-reader-key')
    ? Response.json({ machineId: 'pc', machineAccountId: 'account', publicKey: Buffer.from(pair.publicKey).toString('base64'), keyVersion: 1 })
    : Response.json({ automations: [] }));
  expect(await runScriptAutomationTool({ operation: 'list' }, f.session)).toEqual([]);
  expect(runtime.refresh).toHaveBeenCalledWith('machine-token', 'pc');
  expect(f.fetch).toHaveBeenCalledTimes(2);
  const [url, init] = f.fetch.mock.calls[1];
  expect(String(url)).toBe('http://studio.fixture/api/automation/script-management');
  expect(init.headers).toMatchObject({ Authorization: 'Bearer machine-token', 'X-Aplus-Caller-Grant': process.env.HAPPY_APLUS_MCP_CALLER_GRANT });
  expect(JSON.parse(init.body)).toEqual({ projectId: 'project', machineId: 'pc', request: { operation: 'list' } });
});

it('requires a registered automation key for dataKey credentials before any server access', async () => {
  const f = runtimeFixture(); runtime.credentials.mockReturnValue(null);
  runtime.machineCredentials.mockResolvedValue({ token: 'machine-token', encryption: { type: 'dataKey', publicKey: pair.publicKey, machineKey: nacl.randomBytes(32) } });
  for (const key of [null, { ...pair, registeredKeyVersion: 0 }]) {
    runtime.machineKey.mockReturnValue(key);
    await expect(runScriptAutomationTool({ operation: 'list' }, f.session)).rejects.toThrow('SCRIPT_MACHINE_KEY_REQUIRED');
  }
  expect(runtime.refresh).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});

it('distinguishes missing script configuration, machine identity, credentials and grant before a request', async () => {
  const f = runtimeFixture();
  vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', '');
  await expect(runScriptAutomationTool({ operation: 'list' }, f.session)).rejects.toThrow('SCRIPT_CONFIG_REQUIRED');
  vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.fixture/api/me/mcp-config?project_id=project');
  await expect(runScriptAutomationTool({ operation: 'list' }, { directory })).rejects.toThrow('SCRIPT_MACHINE_CONTEXT_REQUIRED');
  runtime.credentials.mockReturnValue(null);
  await expect(runScriptAutomationTool({ operation: 'list' }, f.session)).rejects.toThrow('SCRIPT_CREDENTIALS_REQUIRED');
  runtime.credentials.mockReturnValue({ token: 'fixture-only-token', secret: nacl.randomBytes(32), contentKeyPair: pair });
  vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', '');
  await expect(runScriptAutomationTool({ operation: 'list' }, f.session)).rejects.toThrow('SCRIPT_CALLER_GRANT_REQUIRED');
  expect(runtime.refresh).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});


function machineFixture(mode: 'compat' | 'strict' = 'strict') {
  const viewer = nacl.box.keyPair(), machine = nacl.box.keyPair();
  const rows: any[] = [];
  const target = { machineId: 'pc', machineAccountId: 'account', automationProtocolVersion: 5, machineKeyVersion: 2, viewerKeyVersion: 1,
    viewerPublicKey: Buffer.from(viewer.publicKey).toString('base64'), machinePublicKey: Buffer.from(machine.publicKey).toString('base64') };
  let encryptedLog: unknown;
  const request = vi.fn(async (input: any): Promise<any> => {
    if (input.operation === 'target') return target;
    if (input.operation === 'list') return { automations: rows };
    if (input.operation === 'upsert') {
      const row = { id: 'script-1', projectId: 'project', ...target, revision: rows.length ? rows[0].revision + 1 : 1, generation: 1, ...input.registration };
      rows.splice(0, rows.length, row); return { automation: row };
    }
    if (input.operation === 'runs') return input.runId ? { logCiphertext: JSON.stringify(encryptedLog) } : { runs: [{ id: 'run-1', status: 'COMPLETED' }] };
    if (input.operation === 'run') return { accepted: true };
    throw new Error('unexpected request');
  });
  const tools = createScriptAutomationTools({ projectId: 'project', directory, viewerPublicKey: viewer.publicKey,
    machineReader: { machineId: 'pc', machineAccountId: 'account', mode, key: { ...machine, registeredKeyVersion: 2 } },
    request });
  const input = { operation: 'upsert', registrationKey: 'collect', expectedRevision: 0, sourcePath: 'collect.mjs', name: 'Collect', schedule: null };
  const log = (resourceId = 'run-1') => {
    encryptedLog = encryptScriptValue({ value: { log: 'done' }, context: { projectId: 'project', resourceId, purpose: 'log' }, viewerPublicKey: viewer.publicKey, machinePublicKey: machine.publicKey });
  };
  return { tools, request, rows, target, input, viewer, machine, log };
}

it('registers, reads, retries, toggles and opens logs without the viewer private key', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const f = machineFixture();
  expect(await f.tools.execute(f.input)).toMatchObject({ id: 'script-1', name: 'Collect' });
  expect(await f.tools.execute(f.input)).toMatchObject({ revision: 1 });
  expect(f.request.mock.calls.filter(([request]) => request.operation === 'upsert')).toHaveLength(1);
  f.request.mockClear();
  expect(await f.tools.execute({ operation: 'list' })).toMatchObject([{ name: 'Collect' }]);
  expect(f.request.mock.calls.map(([request]) => request.operation)).toEqual(['list']);
  expect(await f.tools.execute({ operation: 'get', automationId: 'script-1' })).toMatchObject({ name: 'Collect' });
  const row = f.rows[0];
  expect(openScriptValueForMachine({ encrypted: row.artifact, context: { projectId: 'project', resourceId: row.admission.artifactId, purpose: 'artifact' }, secretKey: f.machine.secretKey }))
    .toMatchObject({ ok: true, payload: { source: 'console.log(1)' }, authentication: { kind: 'authenticated', senderPublicKey: f.machine.publicKey } });
  expect(decryptScriptValue({ encrypted: row.encrypted, context: { projectId: 'project', resourceId: 'collect', purpose: 'configuration' }, recipient: 'viewer', secretKey: f.viewer.secretKey })).toMatchObject({ name: 'Collect' });
  expect(await f.tools.execute({ operation: 'set_enabled', automationId: 'script-1', expectedRevision: 1, enabled: false })).toMatchObject({ paused: true });
  f.log();
  expect(await f.tools.execute({ operation: 'list_runs', automationId: 'script-1', runId: 'run-1' })).toMatchObject([{ log: { log: 'done' } }]);
});

it('rejects other project/machine/account/key rows before mutations or log requests', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const f = machineFixture(); await f.tools.execute(f.input); const original = { ...f.rows[0] };
  for (const patch of [{ projectId: 'other' }, { machineId: 'other' }, { machineId: undefined }, { machineAccountId: 'other' }, { machineKeyVersion: 3 },
    { machinePublicKey: null }, { machinePublicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64') },
    { viewerPublicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64') }]) {
    f.rows[0] = { ...original, ...patch };
    for (const operation of [{ operation: 'list' }, { operation: 'set_enabled', automationId: 'script-1', expectedRevision: 1, enabled: false },
      { operation: 'run', automationId: 'script-1', input: {}, idempotencyKey: 'once' }, { operation: 'list_runs', automationId: 'script-1', runId: 'run-1' }]) {
      f.request.mockClear(); await expect(f.tools.execute(operation)).rejects.toThrow();
      expect(f.request.mock.calls.map(([request]) => request.operation)).toEqual(['list']);
    }
  }
});

it('rejects mismatched target machine/account/key/version before uploading code', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  for (const patch of [{ machineId: 'other' }, { machineAccountId: 'other' }, { machineKeyVersion: 3 }, { machinePublicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64') },
    { viewerPublicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64') }]) {
    const f = machineFixture(); Object.assign(f.target, patch); await expect(f.tools.execute(f.input)).rejects.toThrow();
    expect(f.request.mock.calls.some(([request]) => request.operation === 'upsert')).toBe(false);
  }
});

it('fails closed on corrupted machine ciphertext, untrusted senders and wrong log context', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const f = machineFixture(); await f.tools.execute(f.input);
  const encrypted = f.rows[0].encrypted;
  const context = { projectId: 'project', resourceId: 'collect', purpose: 'configuration' as const };
  const value = decryptScriptValue({ encrypted, context, recipient: 'viewer', secretKey: f.viewer.secretKey });
  for (const changed of [
    { ...encrypted, machineKeyEnvelope: Buffer.from(nacl.randomBytes(105)).toString('base64') },
    encryptScriptValue({ value, context, viewerPublicKey: f.viewer.publicKey, machinePublicKey: f.machine.publicKey, sender: nacl.box.keyPair() }),
    encryptScriptValue({ value, context, viewerPublicKey: f.viewer.publicKey, machinePublicKey: f.machine.publicKey }),
  ]) {
    f.rows[0].encrypted = changed; await expect(f.tools.execute({ operation: 'list' })).rejects.toThrow();
  }
  f.rows[0].encrypted = encrypted; f.log('other-run');
  await expect(f.tools.execute({ operation: 'list_runs', automationId: 'script-1', runId: 'run-1' })).rejects.toThrow('SCRIPT_DECRYPT_FAILED');
});


it('rejects stale or unavailable server reader keys before script management', async () => {
  const f = runtimeFixture(); runtime.credentials.mockReturnValue(null);
  runtime.machineCredentials.mockResolvedValue({ token: 'machine-token', encryption: { type: 'dataKey', publicKey: pair.publicKey, machineKey: nacl.randomBytes(32) } });
  runtime.machineKey.mockReturnValue({ ...pair, registeredKeyVersion: 1 });
  const key = { machineId: 'pc', machineAccountId: 'account', publicKey: Buffer.from(pair.publicKey).toString('base64'), keyVersion: 1 };
  for (const patch of [{ machineId: 'other' }, { publicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64') }, { keyVersion: 2 }]) {
    f.fetch.mockReset().mockResolvedValue(Response.json({ ...key, ...patch }));
    await expect(runScriptAutomationTool({ operation: 'list' }, f.session)).rejects.toThrow('SCRIPT_MACHINE_KEY_MISMATCH');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  }
  f.fetch.mockReset().mockResolvedValue(Response.json({}, { status: 503 }));
  await expect(runScriptAutomationTool({ operation: 'list' }, f.session)).rejects.toThrow('SCRIPT_MACHINE_KEY_UNAVAILABLE');
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it('keeps the caller grant mandatory for dataKey credentials before reader-key requests', async () => {
  const f = runtimeFixture(); runtime.credentials.mockReturnValue(null);
  runtime.machineCredentials.mockResolvedValue({ token: 'machine-token', encryption: { type: 'dataKey', publicKey: pair.publicKey, machineKey: nacl.randomBytes(32) } });
  runtime.machineKey.mockReturnValue({ ...pair, registeredKeyVersion: 1 });
  vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', '');
  await expect(runScriptAutomationTool({ operation: 'list' }, f.session)).rejects.toThrow('SCRIPT_CALLER_GRANT_REQUIRED');
  expect(f.fetch).not.toHaveBeenCalled();
});


it('runs the complete dataKey entry point through reader verification, registration, list and logs', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const runtimeState = runtimeFixture(), f = machineFixture();
  runtime.credentials.mockReturnValue(null);
  runtime.machineCredentials.mockResolvedValue({ token: 'machine-token', encryption: { type: 'dataKey', publicKey: f.viewer.publicKey, machineKey: nacl.randomBytes(32) } });
  runtime.machineKey.mockReturnValue({ ...f.machine, registeredKeyVersion: 2 });
  runtimeState.fetch.mockImplementation(async (url: URL, init: RequestInit) => {
    if (String(url).endsWith('/automation-reader-key')) return Response.json({ machineId: 'pc', machineAccountId: 'account', publicKey: Buffer.from(f.machine.publicKey).toString('base64'), keyVersion: 2 });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ projectId: 'project', machineId: 'pc' });
    expect(init.redirect).toBe('error');
    return Response.json(await f.request(body.request));
  });
  expect(await runScriptAutomationTool(f.input, runtimeState.session)).toMatchObject({ id: 'script-1', revision: 1 });
  expect(await runScriptAutomationTool({ operation: 'list' }, runtimeState.session)).toMatchObject([{ name: 'Collect' }]);
  f.log();
  expect(await runScriptAutomationTool({ operation: 'list_runs', automationId: 'script-1', runId: 'run-1' }, runtimeState.session)).toMatchObject([{ log: { log: 'done' } }]);
});

it('keeps legacy credentials on the existing viewer path without reader-key requests', async () => {
  const f = runtimeFixture(); f.fetch.mockResolvedValue(Response.json({ automations: [] }));
  expect(await runScriptAutomationTool({ operation: 'list' }, f.session)).toEqual([]);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(String(f.fetch.mock.calls[0][0])).toBe('http://studio.fixture/api/automation/script-management');
});

it('accepts customer-authenticated configuration and preserves anonymous compat semantics', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  for (const mode of ['compat', 'strict'] as const) {
    const f = machineFixture(mode); await f.tools.execute(f.input);
    const context = { projectId: 'project', resourceId: 'collect', purpose: 'configuration' as const };
    const value = decryptScriptValue({ encrypted: f.rows[0].encrypted, context, recipient: 'viewer', secretKey: f.viewer.secretKey });
    f.rows[0].encrypted = encryptScriptValue({ value, context, viewerPublicKey: f.viewer.publicKey, machinePublicKey: f.machine.publicKey, sender: f.viewer });
    expect(await f.tools.execute({ operation: 'list' })).toMatchObject([{ name: 'Collect' }]);
    f.rows[0].encrypted = encryptScriptValue({ value, context, viewerPublicKey: f.viewer.publicKey, machinePublicKey: f.machine.publicKey });
    if (mode === 'compat') expect(await f.tools.execute({ operation: 'list' })).toMatchObject([{ name: 'Collect' }]);
    else await expect(f.tools.execute({ operation: 'list' })).rejects.toThrow('PAYLOAD_SENDER_ANONYMOUS');
  }
});


it('rejects invalid MCP config destinations before grant refresh or network access', async () => {
  const f = runtimeFixture();
  for (const url of ['file:///api/me/mcp-config', 'https://user:pass@studio.fixture/api/me/mcp-config', 'https://studio.fixture/other']) {
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', url);
    await expect(runScriptAutomationTool({ operation: 'list' }, f.session)).rejects.toThrow('SCRIPT_CONFIG_INVALID');
  }
  expect(runtime.refresh).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});


it('validates an existing registration scope before updating at the expected revision', async () => {
  await writeFile(join(directory, 'collect.mjs'), 'console.log(1)');
  const f = machineFixture(); await f.tools.execute(f.input);
  f.rows[0].machineId = 'other'; f.request.mockClear();
  await expect(f.tools.execute({ ...f.input, expectedRevision: 1 })).rejects.toThrow('SCRIPT_MACHINE_KEY_MISMATCH');
  expect(f.request.mock.calls.map(([request]) => request.operation)).toEqual(['target', 'list']);
});

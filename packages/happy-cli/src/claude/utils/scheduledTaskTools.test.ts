import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { encryptAutomationPayload, type AutomationCryptoAdapter } from '@slopus/happy-wire';
import { createScheduledTaskTools, runScheduledTaskTool } from './scheduledTaskTools';
import { openServerAutomationPayload } from '@/daemon/automations/serverAutomationCache';
import { encryptWithDataKey, encryptLegacy } from '@/api/encryption';

const runtime = vi.hoisted(() => ({ key: vi.fn(), credentials: vi.fn(), machineCredentials: vi.fn(async (): Promise<unknown> => null), refresh: vi.fn(async () => false), configuration: { machineControl: 'legacy', serverUrl: 'http://happy.fixture' } }));
vi.mock('@/resume/localHappyAgentAuth', () => ({ readLocalHappyAgentCredentials: runtime.credentials }));
vi.mock('@/daemon/automations/machineAutomationKey', () => ({ readMachineAutomationKey: runtime.key }));
vi.mock('@/persistence', async () => ({ ...await vi.importActual<typeof import('@/persistence')>('@/persistence'), readCredentials: runtime.machineCredentials }));
vi.mock('@/aplus/refreshMcpCallerGrant', () => ({ refreshMcpCallerGrantIfExpiring: runtime.refresh }));
vi.mock('@/configuration', async () => {
  const actual = await vi.importActual<{ configuration: object }>('@/configuration');
  Object.assign(runtime.configuration, { ...actual.configuration, ...runtime.configuration });
  return { ...actual, configuration: runtime.configuration };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); runtime.configuration.machineControl = 'legacy'; });

const viewer = nacl.box.keyPair(), machine = nacl.box.keyPair();
const create = { operation: 'create', registrationKey: 'reservation-request-001', name: '상태 확인', prompt: '접속 상태를 확인해줘', schedule: { kind: 'interval', minutes: 15 } };
function fixture(machineReader = false) {
  const rows: any[] = []; let loseCreate = false, loseUpdate = false;
  const request = vi.fn(async (input: any): Promise<any> => {
    if (input.operation === 'target' || input.operation === 'read_target') return { machineAccountId: 'owner', machineId: 'pc', machinePublicKey: Buffer.from(machine.publicKey).toString('base64'),
      machineKeyVersion: 1, viewerPublicKey: Buffer.from(viewer.publicKey).toString('base64'), viewerKeyVersion: 1, automationProtocolVersion: 4 };
    if (input.operation === 'list') return { automations: rows };
    if (input.operation === 'get_registration') return { automation: rows.find(row => row.key === input.registrationKey) ?? null };
    if (input.operation === 'get') return { automation: rows.find(row => row.id === input.automationId) ?? null };
    if (input.operation === 'create') {
      let row = rows.find(row => row.key === input.registrationKey);
      if (!row) { row = { ...input.encrypted, id: 'reservation', projectId: 'chat:chat', ownerAccountId: 'owner', machineAccountId: 'owner', machineId: 'pc',
        key: input.registrationKey, revision: 2, generation: 2, paused: false, runRequestedAt: null, enabledAt: 1, appliedRevision: 0, appliedAt: null, createdAt: 1, updatedAt: 1 }; rows.push(row); }
      if (loseCreate) { loseCreate = false; throw new Error('SCHEDULED_TASK_UNAVAILABLE'); }
      return { automation: row };
    }
    if (input.operation === 'set_paused') {
      const row = rows.find(row => row.id === input.automationId);
      if (row.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT');
      row.paused = input.paused; row.revision++; row.generation++;
      if (loseUpdate) { loseUpdate = false; throw new Error('SCHEDULED_TASK_UNAVAILABLE'); }
      return { automation: row };
    }
    throw new Error('unexpected-request');
  });
  const ensureExecutionSupported = vi.fn(async () => {});
  const tools = createScheduledTaskTools({ projectId: 'chat:chat', sessionId: 'session', machineId: 'pc', directory: '/work/chat', ...(machineReader ? { viewerPublicKey: viewer.publicKey, machineKey: { ...machine, registeredKeyVersion: 1 } } : { viewerKeyPair: viewer }), request, ensureExecutionSupported });
  return { tools, rows, request, ensureExecutionSupported, loseCreate: () => { loseCreate = true; }, loseUpdate: () => { loseUpdate = true; } };
}

const testCrypto: AutomationCryptoAdapter = {
  randomBytes: length => nacl.randomBytes(length),
  secretBoxSeal: (value, key) => { const nonce = nacl.randomBytes(24); return new Uint8Array([...nonce, ...nacl.secretbox(value, nonce, key)]); },
  secretBoxOpen: (value, key) => nacl.secretbox.open(value.subarray(24), value.subarray(0, 24), key),
  boxSeal: (value, key) => { const pair = nacl.box.keyPair(), nonce = nacl.randomBytes(24); return new Uint8Array([...pair.publicKey, ...nonce, ...nacl.box(value, nonce, key, pair.secretKey)]); },
  boxOpen: (value, key) => nacl.box.open(value.subarray(56), value.subarray(32, 56), value.subarray(0, 32), key),
  sha256: async value => new Uint8Array(createHash('sha256').update(value).digest()),
  encodeBase64: (value, urlSafe) => Buffer.from(value).toString(urlSafe ? 'base64url' : 'base64'),
  decodeBase64: value => new Uint8Array(Buffer.from(value, 'base64')),
};

async function isolated(f: ReturnType<typeof fixture>, signed = false, patch = {}, sender = viewer) {
  await f.tools.execute(create);
  const encrypted = await encryptAutomationPayload({ payload: { name: create.name, prompt: create.prompt,
    schedule: { kind: 'interval', minutes: 15 }, directory: '/work/chat', conversation: { sessionId: 'session' },
    agent: 'codex', scriptCommand: null, suppressSilent: false, contextPolicy: { kind: 'isolated', reference: null },
    ...(signed ? { seal: { version: 1 as const, machineId: 'pc', projectId: 'chat:chat', automationKey: 'reservation-request-001', sealedAt: 1 } } : {}), ...patch },
    viewer: { publicKey: viewer.publicKey, keyVersion: 1 }, machine: { publicKey: machine.publicKey, keyVersion: 1 },
    ...(signed ? { sender } : {}), crypto: testCrypto });
  Object.assign(f.rows[0], encrypted);
  f.ensureExecutionSupported.mockClear(); f.request.mockClear();
}

describe('current-Chat scheduled task tools', () => {
  it('encrypts one ordinary reservation for the existing viewer and machine and leaves models to the conversation', async () => {
    const f = fixture();
    expect(await f.tools.execute(create)).toMatchObject({ id: 'reservation', paused: false, revision: 2, runnerApplied: false, executionConfirmed: false });
    const written = f.request.mock.calls.find(([request]) => request.operation === 'create')![0].encrypted;
    expect(JSON.stringify(written)).not.toContain(create.prompt);
    const opening = openServerAutomationPayload({ ...written, automationId: 'reservation', revision: 2, generation: 2, enabledAt: 1 }, machine.secretKey);
    expect(opening).toMatchObject({ ok: true, payload: { prompt: create.prompt, conversation: { sessionId: 'session' }, agent: null, scriptCommand: null } });
    if (opening.ok) expect(opening.payload).not.toHaveProperty('model');
    expect(await f.tools.execute({ operation: 'list' })).toMatchObject([{ id: 'reservation', prompt: create.prompt }]);
    f.rows[0].appliedRevision = 2;
    expect(await f.tools.execute({ operation: 'get', automationId: 'reservation' })).toMatchObject({ runnerApplied: true, executionConfirmed: false });
  });
  it('recovers a lost create response and never recreates or resumes an existing registration on retry', async () => {
    const f = fixture(); f.loseCreate();
    expect(await f.tools.execute(create)).toMatchObject({ id: 'reservation', paused: false });
    f.rows[0].paused = true; f.rows[0].revision++;
    expect(await f.tools.execute(create)).toMatchObject({ id: 'reservation', paused: true });
    expect(f.rows).toHaveLength(1); expect(f.request.mock.calls.filter(([r]) => r.operation === 'create')).toHaveLength(1);
    await expect(f.tools.execute({ ...create, prompt: '다른 요청' })).rejects.toThrow('REGISTRATION_CONFLICT');
  });
  it('pauses/resumes through revision CAS, recovers an acknowledged state and rejects stale revisions', async () => {
    const f = fixture(); await f.tools.execute(create); f.loseUpdate();
    expect(await f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: true })).toMatchObject({ paused: true, revision: 3 });
    expect(await f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 3, paused: false })).toMatchObject({ paused: false, revision: 4 });
    await expect(f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: true })).rejects.toThrow('REVISION_CONFLICT');
    expect(f.rows[0].paused).toBe(false);
  });
  it('retains a pending registration and retries binding with the same ciphertext before activation', async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    let unavailable = true;
    f.request.mockImplementation(async input => {
      if (input.operation === 'complete_registration') {
        expect(input.payloadCiphertext).toBe(f.rows[0].payloadCiphertext);
        if (unavailable) throw new Error('SCHEDULED_TASK_BINDING_PENDING');
        f.rows[0].revision = 2; f.rows[0].paused = false;
        return { automation: f.rows[0] };
      }
      const result = await original(input);
      if (input.operation === 'create') { f.rows[0].revision = 1; f.rows[0].paused = true; throw new Error('SCHEDULED_TASK_BINDING_PENDING'); }
      return result;
    });
    await expect(f.tools.execute(create)).rejects.toThrow('SCHEDULED_TASK_PREPARATION_PENDING');
    await expect(f.tools.execute(create)).rejects.toThrow('SCHEDULED_TASK_PREPARATION_PENDING');
    unavailable = false;
    expect(await f.tools.execute(create)).toMatchObject({ paused: false, revision: 2 });
    expect(f.rows).toHaveLength(1);
    expect(f.request.mock.calls.filter(([r]) => r.operation === 'create')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([r]) => r.operation === 'complete_registration')).toHaveLength(2);
  });
  it('refuses unsupported execution before bootstrap/write and leaves pause available', async () => {
    const f = fixture(); f.ensureExecutionSupported.mockRejectedValue(new Error('SCHEDULED_TASK_RUNNER_UNSUPPORTED'));
    await expect(f.tools.execute(create)).rejects.toThrow('SCHEDULED_TASK_RUNNER_UNSUPPORTED');
    expect(f.request).not.toHaveBeenCalled();
    f.ensureExecutionSupported.mockResolvedValue(); await f.tools.execute(create);
    f.ensureExecutionSupported.mockRejectedValue(new Error('SCHEDULED_TASK_RUNNER_UNSUPPORTED'));
    expect(await f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: true })).toMatchObject({ paused: true });
    await expect(f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 3, paused: false })).rejects.toThrow('SCHEDULED_TASK_RUNNER_UNSUPPORTED');
  });
  it('refuses foreign scope rows, caller overrides and malformed or ambiguous requests', async () => {
    const f = fixture(); await f.tools.execute(create); f.rows[0].projectId = 'chat:other';
    await expect(f.tools.execute({ operation: 'get', automationId: 'reservation' })).rejects.toThrow('SCHEDULED_TASK_SCOPE_MISMATCH');
    for (const input of [{ ...create, chatId: 'other' }, { ...create, model: 'override' }, { ...create, schedule: { kind: 'interval', minutes: 1 } }, { operation: 'set_paused', paused: true }]) {
      await expect(f.tools.execute(input)).rejects.toThrow();
    }
  });
  it('does not overwrite a mismatched viewer key or report failed activation as a registered schedule', async () => {
    const f = fixture();
    f.request.mockImplementation(async input => input.operation === 'get_registration' ? { automation: null } : { machineAccountId: 'owner', machineId: 'pc',
      machinePublicKey: Buffer.from(machine.publicKey).toString('base64'), machineKeyVersion: 1, viewerPublicKey: Buffer.from(machine.publicKey).toString('base64'), viewerKeyVersion: 1 });
    await expect(f.tools.execute(create)).rejects.toThrow('SCHEDULED_TASK_VIEWER_KEY_MISMATCH');
    expect(f.request.mock.calls.some(([r]) => ['create', 'viewer_key'].includes(r.operation))).toBe(false);
  });
  it('recovers a lost or concurrent viewer key receipt only when rereading confirms the same key', async () => {
    for (const conflict of [false, true]) {
      const f = fixture(), original = f.request.getMockImplementation()!;
      let registered = false;
      f.request.mockImplementation(async input => {
        if (input.operation === 'viewer_key') { registered = true; throw new Error('VIEWER_KEY_VERSION_CONFLICT'); }
        const response = await original(input);
        if (input.operation === 'target') response.viewerPublicKey = !registered ? null : Buffer.from(conflict ? machine.publicKey : viewer.publicKey).toString('base64');
        return response;
      });
      if (conflict) {
        await expect(f.tools.execute(create)).rejects.toThrow('SCHEDULED_TASK_VIEWER_KEY_MISMATCH');
        expect(f.request.mock.calls.some(([r]) => r.operation === 'create')).toBe(false);
      } else expect(await f.tools.execute(create)).toMatchObject({ id: 'reservation', paused: false });
      expect(f.request.mock.calls.filter(([r]) => r.operation === 'viewer_key')).toHaveLength(1);
    }
  });
});

describe('scheduled tool runtime authority and runner capability', () => {
  const session = { sessionId: 'session', directory: '/work/chat', machineId: 'pc' };
  function runtimeFixture(metadata: unknown) {
    const secret = nacl.randomBytes(32), calls: { url: string; init?: RequestInit }[] = [];
    runtime.credentials.mockReturnValue({ token: 'fixture-only-token', secret, contentKeyPair: viewer });
    const grant = Buffer.from(JSON.stringify({ personalChatId: 'chat', projectId: null, exp: Date.now() + 86400000 })).toString('base64url') + '.fixture-signature';
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.fixture/api/me/mcp-config');
    vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', grant);
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(String(url).includes('/v1/machines/')
        ? { machine: { id: 'pc', metadata: Buffer.from(encryptLegacy(metadata, secret)).toString('base64') } }
        : { automations: [] }), { status: 200 });
    }));
    return { calls, grant };
  }
  it('carries actual session authority and a refreshed grant only to the configured Studio origin', async () => {
    const f = runtimeFixture({});
    runtime.refresh.mockImplementationOnce(async () => { process.env.HAPPY_APLUS_MCP_CALLER_GRANT = f.grant + '-refreshed'; return true; });
    expect(await runScheduledTaskTool({ operation: 'list' }, session)).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('http://studio.fixture/api/automation/scheduled-management');
    expect(f.calls[0].init).toMatchObject({ redirect: 'error', headers: { 'X-Aplus-Caller-Grant': f.grant + '-refreshed', Authorization: 'Bearer fixture-only-token', 'X-Saycode-Scheduled-Task-Payloads': '4,6' } });
    expect(JSON.parse(f.calls[0].init!.body as string)).toEqual({ machineId: 'pc', sessionId: 'session', request: { operation: 'list' } });
  });
  it('refuses unsupported/strict machines before any management write or bootstrap', async () => {
    for (const support of [{ conversation: false, serverBacked: true }, { conversation: true, serverBacked: true, authenticatedEnvelopes: { required: true } }]) {
      const f = runtimeFixture({ automationSupport: support });
      await expect(runScheduledTaskTool(create, session)).rejects.toThrow(support.conversation ? 'SCHEDULED_TASK_SEALING_UNSUPPORTED' : 'SCHEDULED_TASK_RUNNER_UNSUPPORTED');
      expect(f.calls.map(call => call.url)).toEqual(['http://happy.fixture/v1/machines/pc']);
    }
    const f = runtimeFixture({ automationSupport: { conversation: true, serverBacked: true } });
    runtime.configuration.machineControl = 'strict';
    await expect(runScheduledTaskTool(create, session)).rejects.toThrow('SCHEDULED_TASK_SEALING_UNSUPPORTED');
    expect(f.calls).toEqual([]);
  });
  it('refuses project configuration and unavailable local key credentials without a remote request', async () => {
    const f = runtimeFixture({});
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.fixture/api/me/mcp-config?project_id=other');
    await expect(runScheduledTaskTool(create, session)).rejects.toThrow('SCHEDULED_TASK_CHAT_REQUIRED');
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.fixture/api/me/mcp-config');
    runtime.credentials.mockReturnValue(null);
    runtime.machineCredentials.mockResolvedValue(null);
    await expect(runScheduledTaskTool(create, session)).rejects.toThrow('SCHEDULED_TASK_CREDENTIALS_REQUIRED');
    expect(f.calls).toEqual([]);
  });
  it('identifies dataKey-only credentials before grant refresh or any remote call', async () => {
    const f = runtimeFixture({});
    runtime.credentials.mockReturnValue(null);
    runtime.machineCredentials.mockResolvedValue({ token: 'fixture-only-token', encryption: { type: 'dataKey', publicKey: machine.publicKey, machineKey: nacl.randomBytes(32) } });
    runtime.refresh.mockClear();
    await expect(runScheduledTaskTool({ operation: 'list' }, session)).rejects.toThrow('SCHEDULED_TASK_MACHINE_KEY_REQUIRED');
    expect(runtime.refresh).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it('distinguishes missing config, machine identity and caller grant before a remote call', async () => {
    const f = runtimeFixture({});
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', '');
    await expect(runScheduledTaskTool({ operation: 'list' }, session)).rejects.toThrow('SCHEDULED_TASK_CONFIG_REQUIRED');
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.fixture/api/me/mcp-config');
    await expect(runScheduledTaskTool({ operation: 'list' }, { ...session, machineId: '' })).rejects.toThrow('SCHEDULED_TASK_MACHINE_CONTEXT_REQUIRED');
    vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', '');
    runtime.refresh.mockClear();
    await expect(runScheduledTaskTool({ operation: 'list' }, session)).rejects.toThrow('SCHEDULED_TASK_CALLER_GRANT_REQUIRED');
    expect(runtime.refresh).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
});

it('creates, reads and retries with only the account public key and existing machine key', async () => {
  const f = fixture(true); f.loseCreate();
  expect(await f.tools.execute(create)).toMatchObject({ id: 'reservation', prompt: create.prompt });
  expect(await f.tools.execute(create)).toMatchObject({ id: 'reservation' });
  expect(await f.tools.execute({ operation: 'list' })).toMatchObject([{ prompt: create.prompt }]);
  const viewerReader = createScheduledTaskTools({ projectId: 'chat:chat', sessionId: 'session', machineId: 'pc', directory: '/work/chat', viewerKeyPair: viewer, request: f.request, ensureExecutionSupported: f.ensureExecutionSupported });
  expect(await viewerReader.execute({ operation: 'get', automationId: 'reservation' })).toMatchObject({ prompt: create.prompt });
  expect(f.request.mock.calls.filter(([r]) => r.operation === 'create')).toHaveLength(1);
});
it('rejects stale machine keys before encrypted writes or opening a row', async () => {
  const f = fixture(true), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => { const value = await original(input); if (input.operation === 'target' || input.operation === 'read_target') value.machineKeyVersion = 2; return value; });
  await expect(f.tools.execute(create)).rejects.toThrow('SCHEDULED_TASK_MACHINE_KEY_MISMATCH');
  expect(f.request.mock.calls.some(([r]) => ['create', 'viewer_key', 'target'].includes(r.operation))).toBe(false);
});

it('runs the dataKey Project transport without an account private key', async () => {
  const f = fixture(true), machineKey = nacl.randomBytes(32);
  runtime.credentials.mockReturnValue(null);
  runtime.machineCredentials.mockResolvedValue({ token: 'fixture-token', encryption: { type: 'dataKey', publicKey: viewer.publicKey, machineKey } });
  runtime.key.mockReturnValue({ ...machine, registeredKeyVersion: 1 });
  vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.fixture/api/me/mcp-config?project_id=project');
  vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', Buffer.from(JSON.stringify({ personalChatId: null, projectId: 'project' })).toString('base64url') + '.signature');
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).endsWith('/automation-reader-key')) return Response.json({ machineId: 'pc', machineAccountId: 'owner', publicKey: Buffer.from(machine.publicKey).toString('base64'), keyVersion: 1 });
    if (String(url).includes('/v1/machines/')) return Response.json({ machine: { id: 'pc', metadata: Buffer.from(encryptWithDataKey({ automationSupport: { conversation: true, serverBacked: true } }, machineKey)).toString('base64') } });
    const body = JSON.parse(init.body);
    expect(body.projectId).toBe('project');
    const result = await f.request(body.request);
    if (result.automation) result.automation.projectId = 'project';
    return Response.json(result);
  }));
  expect(await runScheduledTaskTool(create, { sessionId: 'session', machineId: 'pc', directory: '/work/chat' })).toMatchObject({ id: 'reservation', prompt: create.prompt });
});

it('keeps simultaneous machine-reader creates on one reservation and does not expose another Project session', async () => {
  const f = fixture(true);
  const results = await Promise.all([f.tools.execute(create), f.tools.execute(create)]);
  expect(results).toHaveLength(2); expect(f.rows).toHaveLength(1);
  const other = createScheduledTaskTools({ projectId: 'project', sessionId: 'other-session', machineId: 'pc', directory: '/work/chat',
    viewerPublicKey: viewer.publicKey, machineKey: { ...machine, registeredKeyVersion: 1 }, request: f.request, ensureExecutionSupported: f.ensureExecutionSupported });
  f.rows[0].projectId = 'project';
  await expect(other.execute({ operation: 'get', automationId: 'reservation' })).rejects.toThrow('SCHEDULED_TASK_SCOPE_MISMATCH');
});


describe('isolated scheduled-task management', () => {
  it('lists mixed legacy/isolated rows and opens both anonymous and signed v6 with viewer or machine credentials', async () => {
    for (const machineReader of [false, true]) for (const signed of [false, true]) {
      const f = fixture(machineReader); await isolated(f, signed);
      const legacy = fixture(machineReader); await legacy.tools.execute(create);
      f.rows.push({ ...legacy.rows[0], id: 'legacy' });
      expect(await f.tools.execute({ operation: 'list' })).toMatchObject([
        { id: 'reservation', executionContext: { kind: 'isolated', reference: null } },
        { id: 'legacy', executionContext: { kind: 'continued' } },
      ]);
      expect(await f.tools.execute({ operation: 'get', automationId: 'reservation' })).toMatchObject({ id: 'reservation', prompt: create.prompt });
    }
  });
  it('pauses and recovers a lost v6 receipt once and gates resume against isolated support', async () => {
    const f = fixture(true); await isolated(f, true); f.loseUpdate();
    const cipher = f.rows[0].payloadCiphertext;
    expect(await f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: true })).toMatchObject({ paused: true, revision: 3 });
    expect(f.ensureExecutionSupported).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([r]) => r.operation === 'set_paused')).toHaveLength(1);
    f.ensureExecutionSupported.mockRejectedValueOnce(new Error('SCHEDULED_TASK_RUNNER_UNSUPPORTED'));
    await expect(f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 3, paused: false })).rejects.toThrow('SCHEDULED_TASK_RUNNER_UNSUPPORTED');
    expect(f.rows[0]).toMatchObject({ paused: true, revision: 3, payloadCiphertext: cipher });
    expect(await f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 3, paused: false })).toMatchObject({ paused: false, revision: 4 });
    expect(f.ensureExecutionSupported).toHaveBeenLastCalledWith(6);
    expect(f.rows[0].payloadCiphertext).toBe(cipher);
  });
  it('refuses cross-conversation resume and foreign scope without a mutation', async () => {
    for (const patch of [{ directory: '/other' }, { conversation: { sessionId: 'old-session' } }]) {
      const f = fixture(); await isolated(f, false, patch); f.rows[0].paused = true;
      await expect(f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: false })).rejects.toThrow(patch.directory ? 'SCHEDULED_TASK_SCOPE_MISMATCH' : 'CHAT_SESSION_CHANGED');
      expect(f.request.mock.calls.some(([r]) => r.operation === 'set_paused')).toBe(false);
    }
  });
  it('rejects a changed payload version in a pause acknowledgment before decrypting or reporting success', async () => {
    for (const version of [4, 6]) {
      const f = fixture(); if (version === 6) await isolated(f); else await f.tools.execute(create);
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async input => {
        const result = await original(input);
        return input.operation === 'set_paused' ? { automation: { ...result.automation, payloadVersion: version === 4 ? 6 : 4 } } : result;
      });
      await expect(f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: true })).rejects.toThrow('SCHEDULED_TASK_RESPONSE_INVALID');
    }
  });
  it('never reinterprets v6 as a create registration and preserves scope and authenticated-envelope binding', async () => {
    const f = fixture(true); await isolated(f, true);
    await expect(f.tools.execute(create)).rejects.toThrow('REGISTRATION_CONFLICT');
    expect(f.request.mock.calls.some(([r]) => ['create', 'complete_registration'].includes(r.operation))).toBe(false);
    f.rows[0].payloadCiphertext = Buffer.from([1, ...new Uint8Array(55).fill(3)]).toString('base64');
    await expect(f.tools.execute({ operation: 'get', automationId: 'reservation' })).rejects.toThrow('automation-decrypt-failed');
  });
});


it('reads a web-authored v6 machine copy when its viewer key differs from the PC customer key', async () => {
  const f = fixture(), customer = nacl.box.keyPair(); await isolated(f, true, {}, customer);
  const reader = createScheduledTaskTools({ projectId: 'chat:chat', sessionId: 'session', machineId: 'pc', directory: '/work/chat',
    viewerPublicKey: customer.publicKey, machineKey: { ...machine, registeredKeyVersion: 1 }, request: f.request, ensureExecutionSupported: f.ensureExecutionSupported });
  expect(await reader.execute({ operation: 'get', automationId: 'reservation' })).toMatchObject({ prompt: create.prompt });
  expect(await reader.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: true })).toMatchObject({ paused: true });
  await expect(reader.execute(create)).rejects.toThrow('REGISTRATION_CONFLICT');
  f.request.mockClear();
  await expect(reader.execute({ ...create, registrationKey: 'separate-new-request-001' })).rejects.toThrow('SCHEDULED_TASK_VIEWER_KEY_MISMATCH');
  expect(f.request.mock.calls.some(([r]) => ['create', 'viewer_key', 'complete_registration'].includes(r.operation))).toBe(false);
})
it('rejects signed definitions sealed for another machine or project before a pause mutation', async () => {
  for (const patch of [{ machineId: 'other', projectId: 'chat:chat' }, { machineId: 'pc', projectId: 'chat:other' }]) {
    const f = fixture(true); await isolated(f, true, { seal: { version: 1, automationKey: 'reservation-request-001', sealedAt: 1, ...patch } });
    await expect(f.tools.execute({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: true })).rejects.toThrow('SCHEDULED_TASK_SCOPE_MISMATCH');
    expect(f.request.mock.calls.some(([r]) => r.operation === 'set_paused')).toBe(false);
  }
})
it('resumes signed v6 on strict PCs only with exact isolation capability and the current machine reader key', async () => {
  for (const variant of ['ready', 'missing-capability', 'wrong-key'] as const) {
    const f = fixture(true); await isolated(f, true); f.rows[0].paused = true;
    const metadataKey = nacl.randomBytes(32);
    runtime.credentials.mockReturnValue(null);
    runtime.machineCredentials.mockResolvedValue({ token: 'fixture-token', encryption: { type: 'dataKey', publicKey: viewer.publicKey, machineKey: metadataKey } });
    runtime.key.mockReturnValue({ ...machine, registeredKeyVersion: 1 }); runtime.configuration.machineControl = 'strict';
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.fixture/api/me/mcp-config');
    vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', Buffer.from(JSON.stringify({ personalChatId: 'chat', projectId: null })).toString('base64url') + '.fixture-signature');
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).endsWith('/automation-reader-key')) return Response.json({ machineId: 'pc', publicKey: Buffer.from(machine.publicKey).toString('base64'), keyVersion: variant === 'wrong-key' ? 2 : 1 });
      if (String(url).includes('/v1/machines/')) return Response.json({ machine: { id: 'pc', metadata: Buffer.from(encryptWithDataKey({ automationSupport: {
        conversation: true, serverBacked: true, contextIsolationVersion: variant === 'missing-capability' ? 0 : 1, authenticatedEnvelopes: { required: true },
      } }, metadataKey)).toString('base64') } });
      expect(init.headers['X-Saycode-Scheduled-Task-Payloads']).toBe('4,6');
      return Response.json(await f.request(JSON.parse(init.body).request));
    }));
    const result = runScheduledTaskTool({ operation: 'set_paused', automationId: 'reservation', expectedRevision: 2, paused: false }, { sessionId: 'session', machineId: 'pc', directory: '/work/chat' });
    if (variant === 'ready') expect(await result).toMatchObject({ paused: false, revision: 3 });
    else await expect(result).rejects.toThrow(variant === 'wrong-key' ? 'SCHEDULED_TASK_MACHINE_KEY_MISMATCH' : 'SCHEDULED_TASK_RUNNER_UNSUPPORTED');
    expect(f.request.mock.calls.filter(([r]) => r.operation === 'set_paused')).toHaveLength(variant === 'ready' ? 1 : 0);
  }
})

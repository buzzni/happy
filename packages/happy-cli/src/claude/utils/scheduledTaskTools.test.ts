import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createScheduledTaskTools, runScheduledTaskTool } from './scheduledTaskTools';
import { openServerAutomationPayload } from '@/daemon/automations/serverAutomationCache';
import { encryptLegacy } from '@/api/encryption';

const runtime = vi.hoisted(() => ({ credentials: vi.fn(), refresh: vi.fn(async () => false), configuration: { machineControl: 'legacy', serverUrl: 'http://happy.fixture' } }));
vi.mock('@/resume/localHappyAgentAuth', () => ({ readLocalHappyAgentCredentials: runtime.credentials }));
vi.mock('@/aplus/refreshMcpCallerGrant', () => ({ refreshMcpCallerGrantIfExpiring: runtime.refresh }));
vi.mock('@/configuration', async () => {
  const actual = await vi.importActual<{ configuration: object }>('@/configuration');
  Object.assign(runtime.configuration, { ...actual.configuration, ...runtime.configuration });
  return { ...actual, configuration: runtime.configuration };
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); runtime.configuration.machineControl = 'legacy'; });

const viewer = nacl.box.keyPair(), machine = nacl.box.keyPair();
const create = { operation: 'create', registrationKey: 'reservation-request-001', name: '상태 확인', prompt: '접속 상태를 확인해줘', schedule: { kind: 'interval', minutes: 15 } };
function fixture() {
  const rows: any[] = []; let loseCreate = false, loseUpdate = false;
  const request = vi.fn(async (input: any): Promise<any> => {
    if (input.operation === 'target') return { machineAccountId: 'owner', machineId: 'pc', machinePublicKey: Buffer.from(machine.publicKey).toString('base64'),
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
  const tools = createScheduledTaskTools({ projectId: 'chat:chat', sessionId: 'session', machineId: 'pc', directory: '/work/chat', viewerKeyPair: viewer, request, ensureExecutionSupported });
  return { tools, rows, request, ensureExecutionSupported, loseCreate: () => { loseCreate = true; }, loseUpdate: () => { loseUpdate = true; } };
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
    expect(f.calls[0].init).toMatchObject({ redirect: 'error', headers: { 'X-Aplus-Caller-Grant': f.grant + '-refreshed', Authorization: 'Bearer fixture-only-token' } });
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
    await expect(runScheduledTaskTool(create, session)).rejects.toThrow('SCHEDULED_TASK_CONTEXT_REQUIRED');
    expect(f.calls).toEqual([]);
  });
});

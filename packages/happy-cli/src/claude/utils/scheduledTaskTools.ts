import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nacl from 'tweetnacl';
import * as z from 'zod';
import { automationPublicSchema, automationTargetSchema, decryptAutomationPayload, encryptAutomationPayload,
  scheduledTaskToolRequestSchema, type AutomationCryptoAdapter, type AutomationPublic, type ScheduledManagementRequest } from '@slopus/happy-wire';
import { readLocalHappyAgentCredentials } from '@/resume/localHappyAgentAuth';
import { readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { decodeBase64, decryptLegacy } from '@/api/encryption';
import { refreshMcpCallerGrantIfExpiring } from '@/aplus/refreshMcpCallerGrant';

export { scheduledTaskToolRequestSchema } from '@slopus/happy-wire';
const crypto: AutomationCryptoAdapter = {
  randomBytes: length => nacl.randomBytes(length),
  secretBoxSeal: (value, key) => { const nonce = nacl.randomBytes(24); return new Uint8Array([...nonce, ...nacl.secretbox(value, nonce, key)]); },
  secretBoxOpen: (value, key) => nacl.secretbox.open(value.subarray(24), value.subarray(0, 24), key),
  boxSeal: (value, key) => { const pair = nacl.box.keyPair(), nonce = nacl.randomBytes(24); return new Uint8Array([...pair.publicKey, ...nonce, ...nacl.box(value, nonce, key, pair.secretKey)]); },
  boxOpen: (value, key) => nacl.box.open(value.subarray(56), value.subarray(32, 56), value.subarray(0, 32), key),
  sha256: async value => new Uint8Array(createHash('sha256').update(value).digest()),
  encodeBase64: (value, urlSafe) => Buffer.from(value).toString(urlSafe ? 'base64url' : 'base64'),
  decodeBase64: value => new Uint8Array(Buffer.from(value, 'base64')),
};
const rowResponse = z.object({ automation: automationPublicSchema.nullable() });
export function createScheduledTaskTools(options: {
  projectId: string; sessionId: string; machineId: string; directory: string; viewerKeyPair: nacl.BoxKeyPair;
  request(input: ScheduledManagementRequest): Promise<unknown>;
  ensureExecutionSupported(): Promise<void>;
}) {
  async function payload(row: AutomationPublic) {
    if (row.projectId !== options.projectId || row.machineId !== options.machineId || row.payloadVersion !== 4) throw new Error('SCHEDULED_TASK_SCOPE_MISMATCH');
    const value = await decryptAutomationPayload({ ...row, keyEnvelope: row.viewerKeyEnvelope, recipientSecretKey: options.viewerKeyPair.secretKey, crypto });
    if (!value.conversation || value.directory !== options.directory) throw new Error('SCHEDULED_TASK_SCOPE_MISMATCH');
    return value;
  }
  async function summary(row: AutomationPublic) {
    const value = await payload(row);
    return { id: row.id, name: value.name, prompt: value.prompt, schedule: value.schedule, paused: row.paused, revision: row.revision,
      conversationSessionId: value.conversation!.sessionId, currentConversation: value.conversation!.sessionId === options.sessionId,
      timeZone: 'execution-pc', runnerApplied: row.appliedRevision === row.revision, appliedRevision: row.appliedRevision, executionConfirmed: false };
  }
  async function read(automationId: string) {
    const row = rowResponse.parse(await options.request({ operation: 'get', automationId })).automation;
    if (!row || row.id !== automationId) throw new Error('SCHEDULED_TASK_NOT_FOUND');
    await payload(row); return row;
  }
  async function registration(registrationKey: string) {
    const row = rowResponse.parse(await options.request({ operation: 'get_registration', registrationKey })).automation;
    if (row) await payload(row);
    return row;
  }
  return { async execute(raw: unknown): Promise<unknown> {
    const input = scheduledTaskToolRequestSchema.parse(raw);
    if (input.operation === 'list') {
      const rows = z.object({ automations: z.array(automationPublicSchema) }).parse(await options.request(input)).automations;
      return Promise.all(rows.map(summary));
    }
    if (input.operation === 'get') return summary(await read(input.automationId));
    if (input.operation === 'set_paused') {
      if (!input.paused) await options.ensureExecutionSupported();
      const before = await read(input.automationId);
      if (before.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT');
      if (!input.paused && (await payload(before)).conversation!.sessionId !== options.sessionId) throw new Error('CHAT_SESSION_CHANGED');
      if (before.paused === input.paused) return summary(before);
      let row: AutomationPublic;
      try {
        const response = rowResponse.parse(await options.request(input)).automation;
        if (!response) throw new Error('SCHEDULED_TASK_UNAVAILABLE'); row = response;
      } catch (error) {
        const recovered = await read(input.automationId).catch(() => null);
        if (!recovered || recovered.revision !== before.revision + 1 || recovered.paused !== input.paused
          || recovered.payloadCiphertext !== before.payloadCiphertext || recovered.viewerKeyEnvelope !== before.viewerKeyEnvelope) throw error;
        row = recovered;
      }
      if (row.id !== before.id || row.revision !== before.revision + 1 || row.paused !== input.paused
        || row.payloadCiphertext !== before.payloadCiphertext) throw new Error('SCHEDULED_TASK_RESPONSE_INVALID');
      return summary(row);
    }
    await options.ensureExecutionSupported();
    const intended = { name: input.name, prompt: input.prompt, schedule: input.schedule, directory: options.directory,
      conversation: { sessionId: options.sessionId }, agent: null, scriptCommand: null, suppressSilent: false };
    const matching = async (row: AutomationPublic) => {
      if (!isDeepStrictEqual(await payload(row), intended)) throw new Error('REGISTRATION_CONFLICT');
      return row;
    };
    const existing = await registration(input.registrationKey);
    if (existing) {
      await matching(existing);
      // An explicitly paused/edited reservation is never reactivated by retrying create.
      if (existing.revision !== 1 || !existing.paused) return summary(existing);
      let completed: AutomationPublic | null;
      try { completed = rowResponse.parse(await options.request({ operation: 'complete_registration', registrationKey: input.registrationKey, payloadCiphertext: existing.payloadCiphertext })).automation; }
      catch { completed = await registration(input.registrationKey); }
      if (!completed) throw new Error('SCHEDULED_TASK_UNAVAILABLE');
      await matching(completed);
      if (completed.revision === 1 && completed.paused) throw new Error('SCHEDULED_TASK_PREPARATION_PENDING');
      return summary(completed);
    }
    let encrypted: z.infer<typeof import('@slopus/happy-wire').scheduledTaskEncryptedCreateSchema>;
    {
      let target = automationTargetSchema.parse(await options.request({ operation: 'target' }));
      const publicKey = Buffer.from(options.viewerKeyPair.publicKey).toString('base64');
      if (target.machineId !== options.machineId) throw new Error('SCHEDULED_TASK_SCOPE_MISMATCH');
      if (!target.viewerPublicKey) {
        try { await options.request({ operation: 'viewer_key', expectedKeyVersion: target.viewerKeyVersion, publicKey }); }
        catch { /* A lost receipt or concurrent writer may have installed this key; verify the exact key below. */ }
        target = automationTargetSchema.parse(await options.request({ operation: 'target' }));
      }
      if (target.machineId !== options.machineId || target.viewerPublicKey !== publicKey) throw new Error('SCHEDULED_TASK_VIEWER_KEY_MISMATCH');
      encrypted = { ...await encryptAutomationPayload({ payload: intended, viewer: { publicKey: options.viewerKeyPair.publicKey, keyVersion: target.viewerKeyVersion },
        machine: { publicKey: crypto.decodeBase64(target.machinePublicKey), keyVersion: target.machineKeyVersion }, crypto }), payloadVersion: 4, paused: true };
    }
    let row: AutomationPublic;
    try {
      const response = rowResponse.parse(await options.request({ operation: 'create', registrationKey: input.registrationKey, encrypted })).automation;
      if (!response) throw new Error('SCHEDULED_TASK_UNAVAILABLE'); row = await matching(response);
    } catch (error) {
      const recovered = await registration(input.registrationKey).catch(() => null);
      if (!recovered) throw error;
      row = await matching(recovered);
    }
    if (row.revision === 1 && row.paused) throw new Error('SCHEDULED_TASK_PREPARATION_PENDING');
    return summary(row);
  } };
}

export async function runScheduledTaskTool(raw: unknown, session: { sessionId: string; directory: string; machineId?: string }) {
  const configured = process.env.HAPPY_APLUS_MCP_CONFIG_URL, credentials = readLocalHappyAgentCredentials();
  const machineId = session.machineId ?? (await readSettings()).machineId;
  if (!configured || !credentials || !machineId) throw new Error('SCHEDULED_TASK_CONTEXT_REQUIRED');
  const url = new URL(configured);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/api/me/mcp-config' || url.searchParams.has('project_id')) throw new Error('SCHEDULED_TASK_CHAT_REQUIRED');
  await refreshMcpCallerGrantIfExpiring(credentials.token, machineId);
  const callerGrant = process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
  let chatId: string | undefined;
  try { chatId = z.object({ personalChatId: z.string().min(1).max(200), projectId: z.null() }).parse(JSON.parse(Buffer.from(callerGrant?.split('.')[0] ?? '', 'base64url').toString('utf8'))).personalChatId; }
  catch { throw new Error('SCHEDULED_TASK_CHAT_REQUIRED'); }
  const tools = createScheduledTaskTools({ projectId: `chat:${chatId}`, sessionId: session.sessionId, directory: session.directory, machineId,
    viewerKeyPair: credentials.contentKeyPair,
    ensureExecutionSupported: async () => {
      if (configuration.machineControl === 'strict') throw new Error('SCHEDULED_TASK_SEALING_UNSUPPORTED');
      const response = await fetch(`${configuration.serverUrl}/v1/machines/${encodeURIComponent(machineId)}`, {
        headers: { Authorization: `Bearer ${credentials.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('SCHEDULED_TASK_RUNNER_UNSUPPORTED');
      const machine = z.object({ machine: z.object({ id: z.string(), metadata: z.string() }) }).parse(await response.json()).machine;
      if (machine.id !== machineId) throw new Error('SCHEDULED_TASK_SCOPE_MISMATCH');
      const metadata = decryptLegacy(decodeBase64(machine.metadata), credentials.secret);
      if (metadata?.automationSupport?.conversation !== true || metadata?.automationSupport?.serverBacked !== true) throw new Error('SCHEDULED_TASK_RUNNER_UNSUPPORTED');
      if (metadata.automationSupport.authenticatedEnvelopes?.required) throw new Error('SCHEDULED_TASK_SEALING_UNSUPPORTED');
    },
    request: async request => {
      const response = await fetch(new URL('/api/automation/scheduled-management', url), { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${credentials.token}`, 'X-Aplus-Caller-Grant': callerGrant!, 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId, sessionId: session.sessionId, request }), signal: AbortSignal.timeout(15000) });
      const value = await response.json() as { error?: unknown };
      if (!response.ok) throw new Error(typeof value.error === 'string' && /^[A-Z0-9_-]{1,100}$/.test(value.error) ? value.error : 'SCHEDULED_TASK_UNAVAILABLE');
      return value;
    },
  });
  return tools.execute(raw);
}

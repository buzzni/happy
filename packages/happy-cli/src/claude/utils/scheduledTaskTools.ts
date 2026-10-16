import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nacl from 'tweetnacl';
import * as z from 'zod';
import { automationPublicSchema, automationTargetSchema, decryptAutomationPayload, encryptAutomationPayload,
  scheduledManagementAutomationSchema, scheduledTaskToolRequestSchema, type AutomationCryptoAdapter, type AutomationPublic, type ScheduledManagementRequest } from '@slopus/happy-wire';
import { readLocalHappyAgentCredentials } from '@/resume/localHappyAgentAuth';
import { configuration } from '@/configuration';
import { decodeBase64, decryptLegacy, decryptWithDataKey } from '@/api/encryption';
import { refreshMcpCallerGrantIfExpiring } from '@/aplus/refreshMcpCallerGrant';
import { readCredentials } from '@/persistence';
import { readMachineAutomationKey } from '@/daemon/automations/machineAutomationKey';

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
export function createScheduledTaskTools(options: {
  projectId: string; sessionId: string; machineId: string; directory: string;
  viewerKeyPair?: nacl.BoxKeyPair; viewerPublicKey?: Uint8Array; machineKey?: { publicKey: Uint8Array; secretKey: Uint8Array; registeredKeyVersion: number };
  request(input: ScheduledManagementRequest): Promise<unknown>;
  ensureExecutionSupported(): Promise<void>;
}) {
  const viewerPublicKey = options.viewerKeyPair?.publicKey ?? options.viewerPublicKey;
  if (!viewerPublicKey || (!options.viewerKeyPair && !options.machineKey)) throw new Error('SCHEDULED_TASK_CREDENTIALS_REQUIRED');
  const responseRow = options.machineKey ? scheduledManagementAutomationSchema : automationPublicSchema;
  const rowResponse = z.object({ automation: responseRow.nullable() });
  function verifyMachine(target: z.infer<typeof automationTargetSchema>) {
    if (target.machineId !== options.machineId) throw new Error('SCHEDULED_TASK_SCOPE_MISMATCH');
    if (options.machineKey && (target.machinePublicKey !== crypto.encodeBase64(options.machineKey.publicKey)
      || target.machineKeyVersion !== options.machineKey.registeredKeyVersion)) throw new Error('SCHEDULED_TASK_MACHINE_KEY_MISMATCH');
  }
  async function payload(row: AutomationPublic) {
    if (row.projectId !== options.projectId || row.machineId !== options.machineId || row.payloadVersion !== 4) throw new Error('SCHEDULED_TASK_SCOPE_MISMATCH');
    let keyEnvelope = row.viewerKeyEnvelope, secretKey = options.viewerKeyPair?.secretKey;
    if (options.machineKey) {
      const target = automationTargetSchema.parse(await options.request({ operation: 'read_target' }));
      verifyMachine(target);
      if (target.viewerPublicKey !== crypto.encodeBase64(viewerPublicKey!) || row.machineKeyVersion !== target.machineKeyVersion
        || row.machineAccountId !== target.machineAccountId) throw new Error('SCHEDULED_TASK_MACHINE_KEY_MISMATCH');
      keyEnvelope = scheduledManagementAutomationSchema.parse(row).machineKeyEnvelope;
      secretKey = options.machineKey.secretKey;
    }
    const value = await decryptAutomationPayload({ ...row, keyEnvelope, recipientSecretKey: secretKey!, crypto });
    if (!value.conversation || value.directory !== options.directory
      || !options.projectId.startsWith('chat:') && value.conversation.sessionId !== options.sessionId) throw new Error('SCHEDULED_TASK_SCOPE_MISMATCH');
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
      const rows = z.object({ automations: z.array(responseRow) }).parse(await options.request(input)).automations;
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
      let rawTarget: unknown;
      if (options.machineKey) {
        try { rawTarget = await options.request({ operation: 'read_target' }); }
        catch (error) {
          if (!(error instanceof Error) || !['NOT_FOUND', 'AUTOMATION_TARGET_UNAVAILABLE'].includes(error.message)) throw error;
          rawTarget = await options.request({ operation: 'target' });
        }
      } else rawTarget = await options.request({ operation: 'target' });
      let target = automationTargetSchema.parse(rawTarget);
      const publicKey = Buffer.from(viewerPublicKey).toString('base64');
      verifyMachine(target);
      if (!target.viewerPublicKey) {
        try { await options.request({ operation: 'viewer_key', expectedKeyVersion: target.viewerKeyVersion, publicKey }); }
        catch { /* A lost receipt or concurrent writer may have installed this key; verify the exact key below. */ }
        target = automationTargetSchema.parse(await options.request({ operation: options.machineKey ? 'read_target' : 'target' }));
      }
      verifyMachine(target);
      if (target.machineId !== options.machineId || target.viewerPublicKey !== publicKey) throw new Error('SCHEDULED_TASK_VIEWER_KEY_MISMATCH');
      encrypted = { ...await encryptAutomationPayload({ payload: intended, viewer: { publicKey: viewerPublicKey, keyVersion: target.viewerKeyVersion },
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

export async function runScheduledTaskTool(raw: unknown, session: { sessionId: string; directory: string; machineId: string }) {
  const configured = process.env.HAPPY_APLUS_MCP_CONFIG_URL, credentials = readLocalHappyAgentCredentials();
  const machineId = session.machineId;
  if (!configured) throw new Error('SCHEDULED_TASK_CONFIG_REQUIRED');
  if (!machineId) throw new Error('SCHEDULED_TASK_MACHINE_CONTEXT_REQUIRED');
  const dataCredentials = credentials ? null : await readCredentials();
  const encryption = dataCredentials?.encryption.type === 'dataKey' ? dataCredentials.encryption : null;
  if (!credentials && !encryption) throw new Error('SCHEDULED_TASK_CREDENTIALS_REQUIRED');
  const machineKey = encryption ? readMachineAutomationKey(configuration.automationKeyFile) : undefined;
  if (encryption && (!machineKey || machineKey.registeredKeyVersion < 1)) throw new Error('SCHEDULED_TASK_MACHINE_KEY_REQUIRED');
  const token = credentials?.token ?? dataCredentials!.token;
  const url = new URL(configured);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/api/me/mcp-config') throw new Error('SCHEDULED_TASK_CHAT_REQUIRED');
  const projectId = url.searchParams.get('project_id');
  if (!process.env.HAPPY_APLUS_MCP_CALLER_GRANT) throw new Error('SCHEDULED_TASK_CALLER_GRANT_REQUIRED');
  await refreshMcpCallerGrantIfExpiring(token, machineId);
  const callerGrant = process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
  if (!callerGrant) throw new Error('SCHEDULED_TASK_CALLER_GRANT_REQUIRED');
  let scope: string;
  try {
    const claim = z.object({ personalChatId: z.string().min(1).max(200).nullable(), projectId: z.string().min(1).max(200).nullable() })
      .parse(JSON.parse(Buffer.from(callerGrant.split('.')[0], 'base64url').toString('utf8')));
    if (projectId ? claim.projectId !== projectId || claim.personalChatId !== null : claim.projectId !== null || !claim.personalChatId) throw new Error();
    scope = projectId ?? `chat:${claim.personalChatId}`;
  } catch { throw new Error('SCHEDULED_TASK_CHAT_REQUIRED'); }
  const tools = createScheduledTaskTools({ projectId: scope, sessionId: session.sessionId, directory: session.directory, machineId,
    ...(credentials ? { viewerKeyPair: credentials.contentKeyPair } : { viewerPublicKey: encryption!.publicKey, machineKey: machineKey! }),
    ensureExecutionSupported: async () => {
      if (configuration.machineControl === 'strict') throw new Error('SCHEDULED_TASK_SEALING_UNSUPPORTED');
      const response = await fetch(`${configuration.serverUrl}/v1/machines/${encodeURIComponent(machineId)}`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('SCHEDULED_TASK_RUNNER_UNSUPPORTED');
      const machine = z.object({ machine: z.object({ id: z.string(), metadata: z.string() }) }).parse(await response.json()).machine;
      if (machine.id !== machineId) throw new Error('SCHEDULED_TASK_SCOPE_MISMATCH');
      const metadata = credentials ? decryptLegacy(decodeBase64(machine.metadata), credentials.secret) : decryptWithDataKey(decodeBase64(machine.metadata), encryption!.machineKey);
      if (metadata?.automationSupport?.conversation !== true || metadata?.automationSupport?.serverBacked !== true) throw new Error('SCHEDULED_TASK_RUNNER_UNSUPPORTED');
      if (metadata.automationSupport.authenticatedEnvelopes?.required) throw new Error('SCHEDULED_TASK_SEALING_UNSUPPORTED');
      if (machineKey) {
        const response = await fetch(`${configuration.serverUrl}/v1/machines/${encodeURIComponent(machineId)}/automation-reader-key`, {
          headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('SCHEDULED_TASK_MACHINE_KEY_UNAVAILABLE');
        const key = z.object({ machineId: z.string(), publicKey: z.string(), keyVersion: z.number().int().positive() }).parse(await response.json());
        if (key.machineId !== machineId || key.publicKey !== crypto.encodeBase64(machineKey.publicKey)
          || key.keyVersion !== machineKey.registeredKeyVersion) throw new Error('SCHEDULED_TASK_MACHINE_KEY_MISMATCH');
      }
    },
    request: async request => {
      const response = await fetch(new URL('/api/automation/scheduled-management', url), { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'X-Aplus-Caller-Grant': callerGrant!, 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId, sessionId: session.sessionId, ...(projectId ? { projectId, directory: session.directory } : {}), request }), signal: AbortSignal.timeout(15000) });
      const value = await response.json() as { error?: unknown };
      if (!response.ok) throw new Error(typeof value.error === 'string' && /^[A-Z0-9_-]{1,100}$/.test(value.error) ? value.error : 'SCHEDULED_TASK_UNAVAILABLE');
      return value;
    },
  });
  return tools.execute(raw);
}

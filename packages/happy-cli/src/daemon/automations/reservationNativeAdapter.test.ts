import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reservationLeaseViewSchema } from '@slopus/happy-wire';
import { ReservationRunJournal } from './reservationRunJournal';
import { runReservationConversationTurn } from './reservationConversationTurn';
import { createReservationNativeAdapter, type ReservationNativeHost } from './reservationNativeAdapter';
const f = vi.hoisted(() => ({ events: [] as string[], workspace: vi.fn(), provider: vi.fn(), prepare: vi.fn(), stop: vi.fn(), flush: vi.fn(), ai: vi.fn(), execute: vi.fn(), cleanup: vi.fn() }));
vi.mock('./reservationNativeContainer', () => ({ reservationDocker: { command: vi.fn() }, ReservationNativeContainers: class {
  prepare = f.prepare; stop = f.stop; renew = vi.fn(); execute = f.execute; engine = async () => 'engine'; cleanupPreparation = f.cleanup;
} }));
vi.mock('./reservationNativeWorkspace', () => ({ reservationGitCommonDirectory: async (path: string) => path,
  findReservationNativeTranscript: async () => '/selected-native-only.jsonl', prepareReservationNativeWorkspace: f.workspace,
  prepareReservationNativeNetwork: async (input: any) => { const network = { name: 'private', close: async () => { f.events.push('network-closed'); } }; input.onPrepared(network); return network; },
}));
vi.mock('./reservationNativeAuth', () => ({ resolveReservationNativeAuth: f.ai, resolveReservationNativeGithub: vi.fn() }));
vi.mock('./reservationNativeBroker', () => ({ createReservationNativeBroker: async () => ({ url: 'http://scope.invalid', token: 'opaque', close: async () => { f.events.push('revoked'); } }) }));
vi.mock('./agentTaskReviewObjects', () => ({ readWorkspaceHeadSha: async () => 'a'.repeat(40) }));
vi.mock('./reservationNativeProvider', () => ({ runReservationNativeProvider: f.provider }));
vi.mock('@/api/apiSession', () => ({ ApiSessionClient: class {
  readonly rpcHandlerManager = { registerHandler: vi.fn() };
  keepAlive = (thinking: boolean) => { f.events.push('thinking:' + thinking); };
  sendAgentMessage = (_agent: string, data: any) => { f.events.push(data.type); };
  sendClaudeSessionMessage = vi.fn(); flushForShutdown = f.flush;
  readReservationStoredOutput = async () => { f.events.push('read-only-storage-receipt'); return { stored: true }; };
  close = async () => { f.events.push('output-closed'); };
} }));
let root: string;
const nativeId = '12345678-1234-4234-8234-123456789abc';
const runtime = { launchId: 'container', processGroupId: 12, processStartId: 'start' };
beforeEach(async () => {
  vi.clearAllMocks(); f.events.length = 0; root = await realpath(await mkdtemp(join(tmpdir(), 'reservation-adapter-')));
  f.ai.mockImplementation(async () => { f.events.push('ai-auth'); return { baseUrl: 'https://provider.invalid', headers: { Authorization: 'Bearer selected-secret' }, close: async () => { f.events.push('auth-closed'); } }; });
  await writeFile(join(root, 'tool.env'), 'HOME=/home/reservation');
  f.cleanup.mockImplementation(async () => { f.events.push('preparation-whole-exit'); });
  f.execute.mockImplementation(async () => { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }); setTimeout(() => { child.stdout.end('unchanged'); child.stderr.end(); child.emit('close', 0); }, 0); return child; });
  f.workspace.mockResolvedValue({ directory: root, mounts: [], envFile: '/native.env', toolEnvFile: join(root, 'tool.env'), mcpConfig: '/mcp.json',
    commit: async () => { f.events.push('native-state-stored'); }, close: async () => { f.events.push('workspace-closed'); } });
  f.prepare.mockImplementation(async (input: any) => { f.events.push('parked'); return { ...runtime, id: 'container', engine: 'engine', scope: input.scope }; });
  f.stop.mockImplementation(async () => { f.events.push('whole-exit'); return { exited: true, runtime }; });
  f.flush.mockImplementation(async () => { f.events.push('output-stored'); return { stored: true }; });
  f.provider.mockImplementation(async (_containers: unknown, _handle: unknown, input: any) => { f.events.push('native-resume:' + input.nativeId); await input.output({ provider: 'codex', raw: {}, text: 'Final answer', final: true }); return { outcome: 'WOKE' }; });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture(payload: Record<string, unknown> = {}) {
  const journal = new ReservationRunJournal(join(root, 'journal.json'));
  let state: 'PREPARING' | 'RUNNING' | 'SETTLING' | 'RELEASED' = 'PREPARING', descriptorHash = '';
  const host: ReservationNativeHost = {
    accountId: 'owner', machineId: 'machine', token: 'happy-host-only', serverUrl: 'https://server.invalid', image: 'sha256:' + 'f'.repeat(64), directory: root,
    resolve: async id => ({ session: { id, seq: 7, encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', metadata: { path: root, flavor: 'codex', codexThreadId: nativeId, currentModelCode: 'model' } as any, metadataVersion: 1, agentState: null, agentStateVersion: 1 },
      home: root, environment: {}, running: false, processedSeq: 7 }),
    aiEnvironment: async () => ({}), connectors: async () => ({}), checkpoint: async () => ({ ok: true }),
    transport: { claim: vi.fn(), start: vi.fn(), heartbeat: async () => ({ ok: true }), report: vi.fn() },
    lease: async request => {
      f.events.push(request.operation);
      if (request.operation === 'acquire') descriptorHash = request.descriptorHash;
      if (request.operation === 'activate') state = 'RUNNING';
      if (request.operation === 'settle' || request.operation === 'recover') state = 'SETTLING';
      if (request.operation === 'release') { expect(request.proof.status).toBe(f.events.includes('whole-exit') ? 'exited' : 'not-started'); state = 'RELEASED'; }
      return { ok: true, value: reservationLeaseViewSchema.parse({ runId: 'run', sessionId: 'same', epoch: 'epoch', descriptorHash, expectedSeq: 7, state, expiresAt: Date.now() + 90000, leaseDurationMs: 90000, messageAuthorization: 'epoch.' + 'a'.repeat(43) }) };
    },
    deliver: async input => { f.events.push('delivered:' + input.sessionId); return { ok: true }; },
    recordExit: (runId, proof) => { f.events.push('exit-journaled'); journal.cleaned(runId, { stored: false, proof }); },
    commitCursor: async id => { f.events.push('cursor:' + id); },
  };
  const adapter = createReservationNativeAdapter(host);
  const descriptor = await adapter.describe({ automationId: 'automation', generation: 1, runId: 'run', sessionId: 'same', executionDirectory: root,
    payload: { name: 'GH review', prompt: 'work', agent: 'codex', directory: root, schedule: { kind: 'github', minutes: 15 }, scriptCommand: null, suppressSilent: false, ...payload } as any, mcpContext: null, agentTaskDispatch: null });
  const contentCiphertext = await adapter.encryptPrompt('same', 'run', 'Work in this chat');
  const run = (prepareDelivery?: Parameters<typeof runReservationConversationTurn>[0]['prepareDelivery']) => runReservationConversationTurn({ prepareDelivery, descriptor, claimToken: 'claim-host-only', contentCiphertext }, journal.bind(descriptor, 'claim-host-only', adapter.dependencies({ descriptor, claimToken: 'claim-host-only' })));
  return { adapter, host, descriptor, journal, run };
}
it('connects a parked native resume to the exact chat and releases only after kernel exit and durable storage', async () => {
  const { adapter, journal, run } = await fixture();
  expect(await run()).toEqual({ ok: true, sessionId: 'same', outcome: 'WOKE' });
  const index = (value: string) => f.events.indexOf(value);
  expect(index('parked')).toBeLessThan(index('activate'));
  expect(index('delivered:same')).toBeLessThan(index('native-resume:' + nativeId));
  expect(index('revoked')).toBeLessThan(index('whole-exit'));
  expect(index('whole-exit')).toBeLessThan(index('native-state-stored'));
  expect(index('output-stored')).toBeLessThan(index('cursor:same'));
  expect(index('network-closed')).toBeLessThan(index('release'));
  expect(adapter.takeResult('run')).toEqual({ finalAnswer: 'Final answer', silent: false });
  expect(journal.pending()).toEqual([]);
});
it('retains the exit receipt on an unknown storage ACK and retries cleanup without another native turn', async () => {
  const { adapter, journal, host, run } = await fixture(); f.flush.mockResolvedValueOnce({ stored: false });
  expect(await run()).toEqual({ ok: false, error: 'RESERVATION_CLEANUP_UNCONFIRMED' });
  expect(journal.pending()[0]).toMatchObject({ stored: false, proof: { status: 'exited', ...runtime } });
  await journal.recover({ now: Date.now, lease: host.lease as never, finish: row => adapter.recover(row) });
  expect(journal.pending()).toEqual([]); expect(f.provider).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1);
  expect(adapter.takeResult('run')).toBeUndefined(); expect(f.events).toContain('read-only-storage-receipt');
});
it('stores the failed turn and closes thinking state after an exact native resume fails', async () => {
  const { journal, run } = await fixture(); f.provider.mockRejectedValueOnce(new Error('native failed'));
  expect(await run()).toMatchObject({ ok: false });
  expect(f.events).toContain('turn_aborted'); expect(f.events).toContain('thinking:false');
  expect(f.events).toContain('native-state-stored'); expect(f.events).toContain('cursor:same'); expect(journal.pending()).toEqual([]);
});

it('cancels the active native turn in place and keeps the journal until cleanup completes', async () => {
  const { adapter, journal, run } = await fixture();
  f.provider.mockImplementationOnce(async (_containers: unknown, _handle: unknown, input: any) => new Promise((_, reject) => {
    input.signal.addEventListener('abort', () => reject(new Error('user stopped')), { once: true });
  }));
  const completion = run(); await vi.waitFor(() => expect(f.provider).toHaveBeenCalledTimes(1));
  expect(adapter.cancel('another-chat')).toBe(false); expect(adapter.cancel('same')).toBe(true);
  expect(journal.pending()).toHaveLength(1);
  expect(await completion).toMatchObject({ ok: false });
  expect(f.events).toContain('whole-exit'); expect(f.events).toContain('thinking:false'); expect(journal.pending()).toEqual([]);
});

it('does not deliver a prompt or start a provider when stopped while the native scope is being prepared', async () => {
  const { adapter, journal, run } = await fixture();
  f.prepare.mockImplementationOnce(async (input: any) => { adapter.cancel('same'); return { ...runtime, id: 'container', engine: 'engine', scope: input.scope }; });
  expect(await run()).toMatchObject({ ok: false });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.events).not.toContain('delivered:same');
  expect(f.events).toContain('whole-exit'); expect(journal.pending()).toEqual([]);
});

it('runs change detection without provider credentials and releases a quiet unchanged run in place', async () => {
  const { adapter, journal, run } = await fixture({ monitorCommand: 'check', reservation: { version: 1, stateKey: 'A'.repeat(43) + '=', commands: { allowedOrigins: [], privateOrigins: [] } } });
  const result = await run(async () => {
    expect(await adapter.runScript!({ runId: 'run', command: 'check', notepad: { cursor: '17' } })).toEqual({ ok: true, stdout: 'unchanged' });
    return { kind: 'skip', outcome: 'NO_CHANGE' };
  });
  expect(result).toEqual({ ok: true, sessionId: 'same', outcome: 'NO_CHANGE' });
  expect(f.ai).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  expect(f.events).not.toContain('delivered:same'); expect(f.events).toContain('preparation-whole-exit');
  expect(f.workspace.mock.calls[0][0]).toMatchObject({ commandsOnly: true, broker: { url: '', token: '' } });
  expect(journal.pending()).toEqual([]);
});
it('proves command descendants gone before obtaining AI credentials for a changed result', async () => {
  const { run } = await fixture({ monitorCommand: 'check', reservation: { version: 1, stateKey: 'A'.repeat(43) + '=', commands: { allowedOrigins: [], privateOrigins: [] } } });
  expect(await run(async () => ({ kind: 'deliver', contentCiphertext: 'changed', confirm: async () => {} }))).toMatchObject({ ok: true, outcome: 'WOKE' });
  expect(f.events.indexOf('preparation-whole-exit')).toBeLessThan(f.events.indexOf('ai-auth'));
  expect(f.provider).toHaveBeenCalledTimes(1);
});
it('keeps the chat fenced if command kernel cleanup is unconfirmed and never obtains AI credentials', async () => {
  const { journal, run } = await fixture({ monitorCommand: 'check', reservation: { version: 1, stateKey: 'A'.repeat(43) + '=', commands: { allowedOrigins: [], privateOrigins: [] } } });
  f.cleanup.mockRejectedValue(new Error('engine unavailable'));
  expect(await run(async () => ({ kind: 'skip', outcome: 'NO_CHANGE' }))).toEqual({ ok: false, error: 'RESERVATION_CLEANUP_UNCONFIRMED' });
  expect(f.ai).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  expect(journal.pending()[0]).toMatchObject({ state: 'SETTLING', launchIntent: false, preparation: { engineId: 'engine' } });
});

it('cancels during monitor preparation without issuing AI credentials or delivering a message', async () => {
  const { adapter, journal, run } = await fixture({ monitorCommand: 'check', reservation: { version: 1, stateKey: 'A'.repeat(43) + '=', commands: { allowedOrigins: [], privateOrigins: [] } } });
  f.prepare.mockImplementationOnce(async (input: any) => { adapter.cancel('same'); return { ...runtime, id: 'container', engine: 'engine', scope: input.scope }; });
  expect(await run(async () => ({ kind: 'skip', outcome: 'NO_CHANGE' }))).toMatchObject({ ok: false });
  expect(f.ai).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled(); expect(f.events).not.toContain('delivered:same');
  expect(f.events).toContain('preparation-whole-exit'); expect(journal.pending()).toEqual([]);
});
it('recovers a journaled preparation launch without resuming the native chat', async () => {
  const { host } = await fixture();
  const restarted = createReservationNativeAdapter(host);
  const proof = await restarted.recover({ runId: 'run', sessionId: 'same', epoch: 'epoch', descriptorHash: 'b'.repeat(64), launchIntent: false, preparation: { engineId: 'engine' } });
  expect(proof).toMatchObject({ stored: true, proof: { status: 'not-started', epoch: 'epoch', descriptorHash: 'b'.repeat(64) } });
  expect(f.cleanup).toHaveBeenCalledWith(expect.objectContaining({ role: 'preparation', runId: 'run', sessionId: 'same' }), 'engine');
  expect(f.ai).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
});

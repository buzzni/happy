import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReservationRunJournal } from './reservationRunJournal';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reservation-journal-')); roots.push(root);
  const file = join(root, 'turns.json');
  const run = { automationId: 'a', generation: 1, runId: 'r', sessionId: 'same-chat', descriptorHash: 'a'.repeat(64), claimToken: 'daemon-secret', expectedSeq: 7 };
  return { file, run, journal: new ReservationRunJournal(file) };
}
it('persists launch intent before native start and keeps unknown launches blocked after restart', () => {
  const f = fixture(); f.journal.begin(f.run); f.journal.checkpoint('r', 'PREPARING', 'epoch'); f.journal.launching('r');
  expect(() => f.journal.begin(f.run)).toThrow('RESERVATION_JOURNAL_RECOVERY_REQUIRED');
  const restarted = new ReservationRunJournal(f.file);
  expect(restarted.blocks('a', 'same-chat')).toBe(true);
  expect(restarted.pending()).toMatchObject([{ runId: 'r', state: 'PREPARING', launchIntent: true, epoch: 'epoch' }]);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.file, 'utf8')).not.toContain('messageAuthorization');
});
it('replays only settlement with the exact persisted proof; it never restarts or redelivers a turn', async () => {
  const f = fixture(); f.journal.begin(f.run); f.journal.checkpoint('r', 'PREPARING', 'epoch'); f.journal.launching('r');
  const runtime = { launchId: 'l', processGroupId: 12, processStartId: 'start' }; f.journal.launched('r', runtime);
  const proof = { ...runtime, status: 'exited' as const, epoch: 'epoch', descriptorHash: f.run.descriptorHash, verifiedAt: 1000 };
  f.journal.cleaned('r', { stored: true, proof });
  const lease = vi.fn(async (request: any) => ({ ok: true, value: { epoch: request.epoch, state: request.operation === 'release' ? 'RELEASED' : 'SETTLING' } })); const finish = vi.fn();
  await new ReservationRunJournal(f.file).recover({ lease, finish, now: () => 1000 });
  expect(lease.mock.calls.map(call => (call as any)[0].operation)).toEqual(['settle', 'release']);
  expect(lease).toHaveBeenLastCalledWith(expect.objectContaining({ proof }));
  expect(finish).not.toHaveBeenCalled(); expect(new ReservationRunJournal(f.file).blocks('a', 'same-chat')).toBe(false);
});
it('keeps SETTLING on a mismatched or absent exit receipt and rejects corrupted files', async () => {
  const f = fixture(); f.journal.begin(f.run); f.journal.checkpoint('r', 'PREPARING', 'epoch'); f.journal.launching('r');
  const finish = vi.fn(async () => ({ stored: true, proof: null }));
  await f.journal.recover({ lease: vi.fn(async () => ({ ok: true })), finish, now: () => 1000 });
  expect(f.journal.pending()[0].state).toBe('SETTLING');
  expect(f.journal.blocks('a', 'same-chat')).toBe(true);
  writeFileSync(f.file, '{broken'); expect(() => new ReservationRunJournal(f.file).pending()).toThrow('RESERVATION_JOURNAL_INVALID');
});
it('retains the receipt when release ACK is lost and refuses another run or epoch in the same slot', async () => {
  const f = fixture(); f.journal.begin(f.run); f.journal.checkpoint('r', 'PREPARING', 'epoch');
  expect(() => f.journal.begin({ ...f.run, runId: 'other' })).toThrow('RESERVATION_JOURNAL_BUSY');
  expect(() => f.journal.checkpoint('r', 'RUNNING', 'foreign')).toThrow('RESERVATION_JOURNAL_CONTEXT_MISMATCH');
  await f.journal.recover({ lease: vi.fn(async request => ({ ok: request.operation !== 'release', value: { epoch: request.epoch, state: 'SETTLING' } })), finish: vi.fn(), now: () => 1000 });
  expect(new ReservationRunJournal(f.file).pending()[0]).toMatchObject({ state: 'SETTLING', proof: { status: 'not-started', epoch: 'epoch' } });
});

it('recovers an unknown acquire response only by withdrawing the matching original authority', async () => {
  const f = fixture(); f.journal.begin(f.run);
  const lease = vi.fn(async (request: any) => ({ ok: true, value: { epoch: 'recovered-epoch', runId: 'r', sessionId: 'same-chat', descriptorHash: f.run.descriptorHash, state: request.operation === 'release' ? 'RELEASED' : 'SETTLING' } }));
  await f.journal.recover({ lease, finish: vi.fn(), now: () => 1000 });
  expect(lease.mock.calls.map(call => call[0].operation)).toEqual(['recover', 'settle', 'release']);
  expect(f.journal.pending()).toEqual([]);
});
it('retains unknown acquisition on an unconfirmed absence, but clears a proven never-launched absence', async () => {
  const f = fixture(); f.journal.begin(f.run);
  await f.journal.recover({ lease: async () => ({ ok: false, error: 'ack-timeout' }), finish: vi.fn(), now: () => 1000 });
  expect(f.journal.pending()).toHaveLength(1);
  await f.journal.recover({ lease: async () => ({ ok: false, error: 'reservation-not-found' }), finish: vi.fn(), now: () => 1000 });
  expect(f.journal.pending()).toEqual([]);
});

it('replays a native refusal receipt without mistaking launch intent for proof that a process ran', async () => {
  const f = fixture(); f.journal.begin(f.run); f.journal.checkpoint('r', 'PREPARING', 'epoch'); f.journal.launching('r');
  const proof = { status: 'not-started' as const, epoch: 'epoch', descriptorHash: f.run.descriptorHash, verifiedAt: 1000 };
  f.journal.cleaned('r', { stored: true, proof });
  const finish = vi.fn();
  await f.journal.recover({ lease: async request => ({ ok: true, value: { epoch: 'epoch', state: request.operation === 'release' ? 'RELEASED' : 'SETTLING' } }), finish, now: () => 1000 });
  expect(finish).not.toHaveBeenCalled(); expect(f.journal.pending()).toEqual([]);
});

it('records each coordinator boundary durably before native start and removes it only after release', async () => {
  const { runReservationConversationTurn } = await import('./reservationConversationTurn');
  const f = fixture(); let hash = '';
  const descriptor: import('./reservationConversationTurn').ReservationTurnDescriptor = { version: 1, automationId: 'a', generation: 1, runId: 'r', sessionId: 'same-chat', machineId: 'm', accountId: 'owner', agent: 'claude', baseDirectory: '/repo', executionDirectory: '/worktree', writeMode: 'worktree', baseSha: null, headSha: null, connectorPolicy: 'none', requiredConnectors: [], credentialHandles: [] };
  const runtime = { launchId: 'l', processGroupId: 12, processStartId: 'start' };
  const deps: import('./reservationConversationTurn').ReservationTurnDependencies = {
    now: Date.now, checkpoint: async () => {}, prepare: async () => ({ expectedSeq: 7 }),
    lease: async request => {
      if (request.operation === 'acquire') hash = request.descriptorHash;
      if (request.operation === 'release') expect(f.journal.pending()[0]).toMatchObject({ state: 'SETTLING', stored: true, proof: { status: 'exited' } });
      return { ok: true, value: { sessionId: 'same-chat', runId: 'r', descriptorHash: hash, epoch: 'epoch', expectedSeq: 7,
        state: request.operation === 'activate' ? 'RUNNING' : request.operation === 'settle' ? 'SETTLING' : request.operation === 'release' ? 'RELEASED' : 'PREPARING',
        expiresAt: Date.now() + 60000, leaseDurationMs: 60000, messageAuthorization: 'epoch.' + 'a'.repeat(43) } };
    },
    heartbeatRun: async () => true, renew: async () => {}, deliver: async () => ({ ok: true }),
    start: async () => { expect(new ReservationRunJournal(f.file).pending()[0]).toMatchObject({ state: 'PREPARING', launchIntent: true }); return runtime; },
    wait: async () => { expect(f.journal.pending()[0]).toMatchObject({ state: 'RUNNING', runtime }); return { outcome: 'WOKE' }; },
    finish: async input => ({ stored: true, proof: { ...runtime, status: 'exited', epoch: input.epoch, descriptorHash: hash, verifiedAt: Date.now() } }),
  };
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'daemon-secret', contentCiphertext: 'sealed' }, f.journal.bind(descriptor, 'daemon-secret', deps))).toMatchObject({ ok: true, sessionId: 'same-chat' });
  expect(f.journal.pending()).toEqual([]);
});

it('does not release a pre-provider command launch as never-started after a daemon restart', async () => {
  const f = fixture(); f.journal.begin(f.run); f.journal.checkpoint('r', 'PREPARING', 'epoch');
  f.journal.preparingCommands('r', 'original-engine');
  const finish = vi.fn(async () => ({ stored: false, proof: null }));
  const lease = vi.fn(async (request: any) => ({ ok: true, value: { epoch: 'epoch', state: request.operation === 'release' ? 'RELEASED' : 'SETTLING' } }));
  await new ReservationRunJournal(f.file).recover({ lease, finish, now: () => 1000 });
  expect(finish).toHaveBeenCalledWith(expect.objectContaining({ launchIntent: false, preparation: { engineId: 'original-engine' } }));
  expect(lease.mock.calls.some(call => call[0].operation === 'release')).toBe(false);
  expect(f.journal.pending()).toHaveLength(1);
});

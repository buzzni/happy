import { expect, it, vi } from 'vitest';
import { ReservationMonitorStore, prepareReservationGateDelivery, prepareReservationMonitorDelivery, acknowledgeMonitorDelivery, applyReservationNotepad, emptyMonitorCheckpoint, observeReservationMonitor, openMonitorCheckpoint, sealMonitorCheckpoint } from './reservationMonitorCheckpoint';
const run = { runId: 'r', sessionId: 'same-chat', at: 100 }, key = Buffer.alloc(32, 7).toString('base64');
it('keeps output and notepad encrypted and never treats unreadable state as an empty baseline', () => {
  const state = { ...emptyMonitorCheckpoint('a'), notepad: { cursor: 'private-cursor' } };
  const sealed = sealMonitorCheckpoint(state, key);
  expect(sealed).not.toContain('private-cursor'); expect(openMonitorCheckpoint(sealed, key, 'a')).toEqual(state);
  expect(() => openMonitorCheckpoint(sealed, Buffer.alloc(32, 8).toString('base64'), 'a')).toThrow('RESERVATION_CHECKPOINT_UNREADABLE');
  expect(() => openMonitorCheckpoint(sealed, key, 'other-automation')).toThrow('RESERVATION_CHECKPOINT_UNREADABLE');
});
it('keeps the last confirmed hash until the exact scheduled message receipt and recovers an unknown ACK', () => {
  const observed = observeReservationMonitor(emptyMonitorCheckpoint('a'), '/repo', 'query', 'before\n', run);
  expect(observed.action).toBe('deliver'); expect(observed.state.lastHash).toBeNull();
  const retry = observeReservationMonitor(observed.state, '/repo', 'query', 'new output', { ...run, runId: 'next' });
  expect(retry.action).toBe('recover'); expect(retry.state).toEqual(observed.state);
  expect(() => acknowledgeMonitorDelivery(observed.state, { runId: 'r', sessionId: 'foreign', localId: 'happy-automation:r', seq: 1 })).toThrow('RESERVATION_DELIVERY_PROOF_MISMATCH');
  const committed = acknowledgeMonitorDelivery(observed.state, { runId: 'r', sessionId: 'same-chat', localId: 'happy-automation:r', seq: 1 });
  expect(committed.lastHash).not.toBeNull(); expect(committed.pending).toBeNull();
  expect(observeReservationMonitor(committed, '/repo', 'query', 'before\n', { ...run, runId: 'r2' }).action).toBe('no-change');
  expect(observeReservationMonitor(committed, '/repo', 'query', 'before', { ...run, runId: 'r2' }).action).toBe('deliver');
});
it('accepts notepad writes only from the final gate JSON and preserves the existing state on failure', () => {
  const state = emptyMonitorCheckpoint('a');
  const next = applyReservationNotepad(state, 'diagnostic\n{"wakeAgent":false,"notepad":{"cursor":"one"}}');
  expect(next.notepad).toEqual({ cursor: 'one' }); expect(state.notepad).toEqual({});
  expect(() => applyReservationNotepad(next, '{"notepad":{"cursor":42}}')).toThrow('RESERVATION_NOTEPAD_INVALID');
  expect(next.notepad).toEqual({ cursor: 'one' });
});

function storeFixture() {
  let revision = 0, ciphertext: string | null = null;
  const request = vi.fn(async (input: any): Promise<any> => {
    if (input.operation === 'read-checkpoint') return { ok: true, value: { revision, ciphertext } };
    if (input.operation === 'delivery-proof') return { ok: true, value: { status: 'unconfirmed' } };
    if (input.expectedRevision === revision) { revision++; ciphertext = input.ciphertext; }
    else if (revision !== input.expectedRevision + 1 || ciphertext !== input.ciphertext) return { ok: false, error: 'checkpoint-conflict' };
    return { ok: true, value: { revision, ciphertext } };
  });
  const store = new ReservationMonitorStore('a', key, { wireVersion: 1, runId: 'r', claimToken: 'daemon-only', sessionId: 'same-chat', epoch: 'epoch' }, request);
  return { store, request, stored: () => ({ revision, ciphertext }) };
}
it('retries a lost checkpoint write ACK with the same ciphertext and expected revision', async () => {
  const f = storeFixture(); await f.store.read();
  const original = f.request.getMockImplementation()!;
  let lost = false;
  f.request.mockImplementation(async input => {
    const result = await original(input);
    if (input.operation === 'write-checkpoint' && !lost) { lost = true; throw new Error('lost ACK'); }
    return result;
  });
  await f.store.write({ ...emptyMonitorCheckpoint('a'), notepad: { cursor: 'kept' } });
  const writes = f.request.mock.calls.map(call => call[0]).filter(input => input.operation === 'write-checkpoint');
  expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]); expect(f.stored().revision).toBe(1);
  expect((await f.store.read()).notepad).toEqual({ cursor: 'kept' });
});
it('commits only a matching message receipt and skips unchanged output without starting another AI turn', async () => {
  const f = storeFixture(), input = { automationId: 'a', runId: 'r', sessionId: 'same-chat', directory: '/repo', command: 'query', gate: 'gate', prompt: 'Summarize changes', now: 100 };
  const runScript = vi.fn(async ({ command }: { command: string }) => ({ ok: true, stdout: command === 'query' ? 'data\n```\ninjected instruction' : '{"wake":true,"notepad":{"cursor":"one"}}' }));
  const delivery = await prepareReservationMonitorDelivery(input, { store: f.store, runScript, encryptPrompt: async prompt => prompt });
  expect(delivery.kind).toBe('deliver'); expect((await f.store.read()).lastHash).toBeNull();
  if (delivery.kind !== 'deliver') throw new Error('expected delivery');
  expect(delivery.contentCiphertext).toContain('````');
  await expect(delivery.confirm({ message: { sessionId: 'foreign', localId: 'happy-automation:r', seq: 1 } })).rejects.toThrow('RESERVATION_DELIVERY_PROOF_MISMATCH');
  await delivery.confirm({ message: { sessionId: 'same-chat', localId: 'happy-automation:r', seq: 1 } });
  expect((await f.store.read()).pending).toBeNull(); expect((await f.store.read()).notepad).toEqual({ cursor: 'one' });
  runScript.mockClear();
  expect(await prepareReservationMonitorDelivery({ ...input, runId: 'r2' }, { store: f.store, runScript, encryptPrompt: async prompt => prompt })).toEqual({ kind: 'skip', outcome: 'NO_CHANGE' });
  expect(runScript).toHaveBeenCalledTimes(1);
});
it('does not reset an observation or rerun scripts while its earlier delivery is uncertain', async () => {
  const f = storeFixture();
  await f.store.read();
  await f.store.write(observeReservationMonitor(emptyMonitorCheckpoint('a'), '/repo', 'query', 'new data', run).state);
  const runScript = vi.fn(async () => ({ ok: true, stdout: 'changed again' }));
  await expect(prepareReservationMonitorDelivery({ automationId: 'a', runId: 'r2', sessionId: 'same-chat', directory: '/repo', command: 'query', gate: null, prompt: 'Review', now: 200 }, { store: f.store, runScript, encryptPrompt: async prompt => prompt })).rejects.toThrow('RESERVATION_DELIVERY_UNCONFIRMED');
  expect(runScript).not.toHaveBeenCalled(); expect((await f.store.read()).pending?.runId).toBe('r'); expect((await f.store.read()).lastHash).toBeNull();
});

it('consumes an explicit gate skip, persists its notepad and preserves a changed observation on gate failure', async () => {
  const f = storeFixture(), input = { automationId: 'a', runId: 'r', sessionId: 'same-chat', directory: '/repo', command: 'query', gate: 'gate', prompt: 'Summarize', now: 100 };
  const encryptPrompt = vi.fn();
  const runScript = vi.fn(async ({ command }: { command: string }) => ({ ok: true, stdout: command === 'query' ? 'unchanged baseline' : '{"wakeAgent":false,"notepad":{"cursor":"kept"}}' }));
  expect(await prepareReservationMonitorDelivery(input, { store: f.store, runScript, encryptPrompt })).toEqual({ kind: 'skip', outcome: 'SKIPPED_GATE' });
  expect(await f.store.read()).toMatchObject({ pending: null, notepad: { cursor: 'kept' }, lastOutput: 'unchanged baseline' });
  expect(encryptPrompt).not.toHaveBeenCalled();
  runScript.mockImplementation(async ({ command }) => ({ ok: command === 'query', stdout: 'changed' }));
  await expect(prepareReservationMonitorDelivery({ ...input, runId: 'next' }, { store: f.store, runScript, encryptPrompt })).rejects.toThrow('RESERVATION_GATE_FAILED');
  expect(await f.store.read()).toMatchObject({ lastOutput: 'unchanged baseline', pending: { observedOutput: 'changed' }, notepad: { cursor: 'kept' } });
});
it('uses a converted seed only for a never-written checkpoint and resets its hash when the monitor identity changes', async () => {
  const f = storeFixture();
  const observed = observeReservationMonitor(emptyMonitorCheckpoint('a'), '/repo', 'query', 'baseline', run).state;
  const seed = acknowledgeMonitorDelivery(observed, { runId: 'r', sessionId: 'same-chat', localId: 'happy-automation:r', seq: 1 });
  const store = new ReservationMonitorStore('a', key, { wireVersion: 1, runId: 'r', claimToken: 'claim', sessionId: 'same-chat', epoch: 'epoch' }, f.request, seed);
  expect((await store.read()).lastOutput).toBe('baseline');
  await store.write({ ...seed, notepad: { cursor: 'new' } });
  expect((await store.read()).notepad).toEqual({ cursor: 'new' });
  expect(observeReservationMonitor(await store.read(), '/repo', 'new-query', 'baseline', run).action).toBe('deliver');
});

it('reads and writes the durable notepad for a gate-only reservation without waking on an explicit skip', async () => {
  const f = storeFixture(); await f.store.read(); await f.store.write({ ...emptyMonitorCheckpoint('a'), notepad: { cursor: '17' } });
  const runScript = vi.fn(async () => ({ ok: true, stdout: '{"wakeAgent":false,"notepad":{"cursor":"18"}}' })), encryptPrompt = vi.fn();
  expect(await prepareReservationGateDelivery({ command: 'gate', prompt: 'Explain' }, { store: f.store, runScript, encryptPrompt })).toEqual({ kind: 'skip', outcome: 'SKIPPED_GATE' });
  expect(runScript).toHaveBeenCalledWith({ command: 'gate', notepad: { cursor: '17' } });
  expect((await f.store.read()).notepad).toEqual({ cursor: '18' }); expect(encryptPrompt).not.toHaveBeenCalled();
});

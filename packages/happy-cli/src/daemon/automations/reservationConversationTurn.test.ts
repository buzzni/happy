import { expect, it, vi } from 'vitest';
import { runReservationConversationTurn, type ReservationTurnDependencies, type ReservationTurnDescriptor } from './reservationConversationTurn';
const descriptor: ReservationTurnDescriptor = { version: 1, automationId: 'a', generation: 1, runId: 'r', sessionId: 'same-chat', machineId: 'm', accountId: 'owner', agent: 'claude', baseDirectory: '/repo', executionDirectory: '/worktree', writeMode: 'worktree', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), connectorPolicy: 'none', requiredConnectors: [], credentialHandles: [] };
function fixture() {
  const calls: string[] = [], epoch = 'epoch';
  const lease = { sessionId: descriptor.sessionId, runId: descriptor.runId, epoch, descriptorHash: '', state: 'PREPARING', expectedSeq: 7, expiresAt: Date.now() + 60000, leaseDurationMs: 60000, messageAuthorization: 'epoch.' + 'a'.repeat(43) };
  const deps: ReservationTurnDependencies = {
    now: () => Date.now(),
    checkpoint: vi.fn(async value => { calls.push('checkpoint:' + value.state); }),
    prepare: vi.fn(async () => ({ expectedSeq: 7 })),
    lease: vi.fn(async request => {
      calls.push(request.operation);
      if (request.operation === 'acquire') lease.descriptorHash = request.descriptorHash;
      return { ok: true as const, value: { ...lease, state: request.operation === 'activate' ? 'RUNNING' as const : request.operation === 'settle' ? 'SETTLING' as const : request.operation === 'release' ? 'RELEASED' as const : 'PREPARING' as const } };
    }),
    heartbeatRun: vi.fn(async () => true),
    start: vi.fn(async input => { calls.push('start:' + input.descriptor.sessionId); return { launchId: 'l', processGroupId: 123, processStartId: 'start' }; }),
    renew: vi.fn(async () => {}),
    deliver: vi.fn(async input => { calls.push('deliver:' + input.sessionId); return { ok: true }; }),
    wait: vi.fn(async () => { calls.push('answer'); return { outcome: 'WOKE' as const }; }),
    finish: vi.fn(async input => { calls.push('withdraw-drain-exit'); return { stored: true, proof: { status: 'exited' as const, epoch, descriptorHash: input.descriptorHash, verifiedAt: Date.now(), launchId: 'l', processGroupId: 123, processStartId: 'start' } }; }),
  };
  return { deps, calls };
}
it('runs the entire turn in the one session and releases only after stored output and verified exit', async () => {
  const { deps, calls } = fixture();
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'daemon-only', contentCiphertext: 'sealed' }, deps)).toEqual({ ok: true, sessionId: 'same-chat', outcome: 'WOKE' });
  expect(calls.filter(value => !value.startsWith('checkpoint:'))).toEqual(['acquire', 'start:same-chat', 'activate', 'deliver:same-chat', 'answer', 'withdraw-drain-exit', 'settle', 'release']);
  expect(deps.start).toHaveBeenCalledWith(expect.not.objectContaining({ claimToken: expect.anything() }));
  expect(JSON.stringify(vi.mocked(deps.checkpoint).mock.calls)).not.toContain('daemon-only');
});
it('keeps SETTLING when a child process or stored output cannot be confirmed', async () => {
  const { deps, calls } = fixture(); vi.mocked(deps.finish).mockResolvedValue({ stored: false, proof: null });
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'daemon-only', contentCiphertext: 'sealed' }, deps)).toMatchObject({ ok: false, error: 'RESERVATION_CLEANUP_UNCONFIRMED' });
  expect(calls).toContain('settle'); expect(calls).not.toContain('release');
});
it('never starts a process or sends a prompt when admission is busy', async () => {
  const { deps } = fixture(); vi.mocked(deps.lease).mockResolvedValue({ ok: false, error: 'reservation-busy' });
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'sealed' }, deps)).toMatchObject({ ok: false, error: 'reservation-busy' });
  expect(deps.start).not.toHaveBeenCalled(); expect(deps.deliver).not.toHaveBeenCalled();
});
it('does not deliver when activation fails and still requires exit evidence', async () => {
  const { deps, calls } = fixture(), lease = deps.lease;
  deps.lease = vi.fn(async input => input.operation === 'activate' ? { ok: false as const, error: 'claim-cancelled' } : lease(input));
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'sealed' }, deps)).toMatchObject({ ok: false });
  expect(deps.deliver).not.toHaveBeenCalled(); expect(calls).toContain('withdraw-drain-exit'); expect(calls).toContain('release');
});
it('does not replace an uncertain provider launch with a new conversation', async () => {
  const { deps, calls } = fixture(); vi.mocked(deps.start).mockRejectedValue(new Error('unknown launch ACK'));
  vi.mocked(deps.finish).mockResolvedValue({ stored: false, proof: null });
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'sealed' }, deps)).toMatchObject({ ok: false, error: 'RESERVATION_CLEANUP_UNCONFIRMED' });
  expect(deps.start).toHaveBeenCalledTimes(1); expect(deps.deliver).not.toHaveBeenCalled(); expect(calls).not.toContain('release');
});

it('records no-change without starting or activating a provider and still releases the lease', async () => {
  const { deps, calls } = fixture();
  vi.mocked(deps.finish).mockImplementation(async input => ({ stored: true, proof: { status: 'not-started', epoch: input.epoch, descriptorHash: input.descriptorHash, verifiedAt: Date.now() } }));
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'unused', prepareDelivery: async () => ({ kind: 'skip', outcome: 'NO_CHANGE' }) }, deps)).toEqual({ ok: true, sessionId: 'same-chat', outcome: 'NO_CHANGE' });
  expect(deps.start).not.toHaveBeenCalled(); expect(deps.deliver).not.toHaveBeenCalled(); expect(deps.wait).not.toHaveBeenCalled();
  expect(calls.filter(value => !value.startsWith('checkpoint:'))).toEqual(['acquire', 'settle', 'release']);
});

it('sends only the native process identity, never private runtime handle fields, to activation', async () => {
  const { deps } = fixture();
  vi.mocked(deps.start).mockResolvedValue({ launchId: 'l', processGroupId: 123, processStartId: 'start', internalToken: 'private-runtime-capability' } as never);
  expect((await runReservationConversationTurn({ descriptor, claimToken: 'daemon-only', contentCiphertext: 'sealed' }, deps)).ok).toBe(true);
  const activation = vi.mocked(deps.lease).mock.calls.map(call => call[0]).find(input => input.operation === 'activate');
  expect(activation).toMatchObject({ runtime: { launchId: 'l', processGroupId: 123, processStartId: 'start' } });
  expect(JSON.stringify(activation)).not.toContain('private-runtime-capability');
});
it('replays a lost release ACK with the same exit proof without rerunning the provider or prompt', async () => {
  const { deps } = fixture(), original = deps.lease; let lost = false;
  deps.lease = vi.fn(async request => {
    const result = await original(request);
    if (request.operation === 'release' && !lost) { lost = true; throw new Error('lost release ACK'); }
    return result;
  });
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'sealed' }, deps)).toMatchObject({ ok: true });
  const releases = vi.mocked(deps.lease).mock.calls.map(call => call[0]).filter(request => request.operation === 'release');
  expect(releases).toHaveLength(2); expect(releases[0]).toEqual(releases[1]);
  expect(deps.start).toHaveBeenCalledTimes(1); expect(deps.deliver).toHaveBeenCalledTimes(1); expect(deps.finish).toHaveBeenCalledTimes(1);
});

it('revokes the child authority before cleanup starts, including an activation rejection', async () => {
  const { deps } = fixture(); let signal: AbortSignal | undefined;
  vi.mocked(deps.start).mockImplementation(async input => { signal = input.signal; return { launchId: 'l', processGroupId: 123, processStartId: 'start' }; });
  const finish = deps.finish;
  deps.finish = vi.fn(async input => { expect(signal?.aborted).toBe(true); return finish(input); });
  expect((await runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'sealed' }, deps)).ok).toBe(true);
});
it('rejects a cleanup receipt whose process identity differs from the activated runtime', async () => {
  const { deps } = fixture(); const finish = deps.finish;
  deps.finish = vi.fn(async input => { const result = await finish(input); return { ...result, proof: { ...result.proof!, processGroupId: 999 } as never }; });
  expect(await runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'sealed' }, deps)).toMatchObject({ ok: false, error: 'RESERVATION_CLEANUP_UNCONFIRMED' });
  expect(vi.mocked(deps.lease).mock.calls.map(call => call[0].operation)).not.toContain('release');
});

it('does not start native work when suspension consumed the acquire response lifetime', async () => {
  const clock = await import('./reservationMonotonicClock'); let uptime = 100000;
  const spy = vi.spyOn(clock, 'reservationMonotonicNow').mockImplementation(() => uptime);
  const { deps } = fixture(), lease = deps.lease;
  deps.lease = vi.fn(async request => { const result = await lease(request); if (request.operation === 'acquire') uptime += 90000; return result; });
  try {
    expect((await runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'sealed' }, deps)).ok).toBe(false);
    expect(deps.start).not.toHaveBeenCalled(); expect(deps.deliver).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

it('renews the preparation kernel while a long monitor runs before native activation', async () => {
  vi.useFakeTimers();
  const { deps } = fixture();
  let finishMonitor!: () => void;
  const pending = new Promise<void>(resolve => { finishMonitor = resolve; });
  const prepareDelivery = vi.fn(async () => { await pending; return { kind: 'skip' as const, outcome: 'NO_CHANGE' as const }; });
  deps.prepareCommands = vi.fn(async () => {}); deps.renewPreparation = vi.fn(async () => {}); deps.finishPreparation = vi.fn(async () => {});
  try {
    const run = runReservationConversationTurn({ descriptor, claimToken: 'claim', contentCiphertext: 'unused', prepareDelivery }, deps);
    await vi.advanceTimersByTimeAsync(1); expect(prepareDelivery).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000); expect(deps.renewPreparation).toHaveBeenCalledOnce(); expect(deps.start).not.toHaveBeenCalled();
    finishMonitor(); expect(await run).toMatchObject({ ok: true, outcome: 'NO_CHANGE' });
    expect(deps.finishPreparation).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

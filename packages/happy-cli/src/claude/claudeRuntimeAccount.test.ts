import portable from './__fixtures__/runtime-account.v1.json';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedMachineRotationFixture } from '@slopus/happy-wire';
import { ClaudeRuntimeAccountPublisher } from './claudeRuntimeAccount';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const binding = (managedAccountId = A, credentialGeneration = 3) => JSON.stringify({ version: 1, managedAccountId, credentialGeneration,
    groupScope: 'org', companyId: 'org', userId: 'user', machineId: 'pc', keyId: 'a'.repeat(64), nonce: B, issuedAt: 100, tokenProof: 'b'.repeat(64) });
afterEach(() => vi.useRealTimers());
it('whitelists actual bound identity without the proof, nonce, token or user identifier', () => {
    const emit = vi.fn(); const source = new ClaudeRuntimeAccountPublisher(() => 'session', emit);
    source.update(binding());
    expect(emit.mock.calls[0][0]).toEqual({ type: 'runtime-account', version: 1, sessionId: 'session', provider: 'claude', epoch: expect.stringMatching(/^\d{13}-/), seq: 1, observedAt: expect.any(Number),
        kind: 'organization', companyId: 'org', machineId: 'pc', managedAccountId: A, credentialGeneration: 3 });
    source.update(binding(B, 4)); expect(emit.mock.calls[1][0]).toMatchObject({ managedAccountId: B, credentialGeneration: 4, seq: 2 });
    expect(emit.mock.calls.map(([frame]) => ({ ...frame, epoch: portable[0].epoch, observedAt: portable[0].observedAt }))).toEqual(portable); source.dispose();
});
it.each([undefined, 'invalid', '{"version":1,"managedAccountId":"personal@example.test"}'])('does not infer a personal login or an invalid binding (%s)', raw => {
    const emit = vi.fn(); const source = new ClaudeRuntimeAccountPublisher(() => 'session', emit);
    source.update(raw); expect(emit.mock.calls[0][0]).toMatchObject({ kind: 'unknown' });
    expect(emit.mock.calls[0][0]).not.toHaveProperty('managedAccountId'); source.dispose();
});
it('resends for late subscribers and reconnects, then stops on close', () => {
    vi.useFakeTimers(); const emit = vi.fn(); const source = new ClaudeRuntimeAccountPublisher(() => 'session', emit);
    source.update(binding()); vi.advanceTimersByTime(10_000); source.resend();
    expect(emit.mock.calls.map(([frame]) => frame.seq)).toEqual([1, 1, 1]);
    source.dispose(); vi.advanceTimersByTime(30_000); source.resend(); expect(emit).toHaveBeenCalledTimes(3);
});

it.each(['session', 'another-session'])('reads only the same-session machine-principal v2 binding (%s)', executionSessionId => {
    const body = sharedMachineRotationFixture.vectors.find(vector => vector.document.body.type === 'claude-setup-token-binding')!.document.body;
    const emit = vi.fn(); const source = new ClaudeRuntimeAccountPublisher(() => 'session', emit);
    source.update(JSON.stringify({ ...body, execution: { sessionId: executionSessionId, initialNonce: 'a'.repeat(43), issueOperationId: 'operation', sessionOwnerAccountId: 'user', machineOwnerAccountId: 'machine-owner' } }));
    expect(emit.mock.calls[0][0]).toMatchObject({ kind: executionSessionId === 'session' ? 'organization' : 'unknown' });
    expect(emit.mock.calls[0][0]).not.toHaveProperty('execution'); expect(emit.mock.calls[0][0]).not.toHaveProperty('nonce'); source.dispose();
});

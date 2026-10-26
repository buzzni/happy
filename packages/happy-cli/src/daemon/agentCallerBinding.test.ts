import { expect, it } from 'vitest';
import { createAgentCallerBindings } from './agentCallerBinding';
it('answers nonce/source-bound main queries from actual launch state and invalidates resumed callers', async () => {
    let epoch = 'registration', active = true;
    const registry = createAgentCallerBindings({ identity: () => ({ machineId: 'machine', happyAccountId: 'account', epoch }),
        live: () => active });
    const a = registry.prepare({ sessionId: 'session', scope: '/project', depth: 0 });
    expect(await registry.query({ sessionId: 'session', nonce: 'n'.repeat(32) })).toEqual({ version: 1, nonce: 'n'.repeat(32), caller: a });
    expect(JSON.stringify(a)).not.toMatch(/private|secret/);
    const b = registry.prepare({ sessionId: 'session', scope: '/project', depth: 0 });
    expect(b.callerBindingId).not.toBe(a.callerBindingId);
    expect(() => registry.sign(a, { operation: 'read' })).toThrow();
    expect(registry.sign(b, { operation: 'read' })).toMatch(/^[A-Za-z0-9_-]+$/);
    epoch = 'changed';
    await expect(registry.query({ sessionId: 'session', nonce: 'n'.repeat(32) })).rejects.toThrow('identity-changed');
    epoch = 'registration'; active = false;
    await expect(registry.query({ sessionId: 'session', nonce: 'n'.repeat(32) })).rejects.toThrow();
});
it('does not accept request-provided scope, depth, public key, or a missing launch', async () => {
    const registry = createAgentCallerBindings({ identity: () => ({ machineId: 'machine', happyAccountId: 'account', epoch: 'registration' }), live: () => true });
    await expect(registry.query({ sessionId: 'forged', nonce: 'n'.repeat(32) })).rejects.toThrow();
    registry.prepare({ sessionId: 'session', scope: '/project', depth: 0 });
    await expect(registry.query({ sessionId: 'session', nonce: 'n'.repeat(32), depth: 0 })).rejects.toThrow();
});

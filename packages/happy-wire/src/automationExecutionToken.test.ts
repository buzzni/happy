import { describe, expect, it } from 'vitest';
import { signAutomationExecutionTarget, verifyAutomationExecutionTarget } from './automationExecutionToken';

const target = { automationId: 'automation-1', projectId: 'chat:chat-1', runId: 'run-1',
  generation: 2, revision: 3, machineId: 'machine-1', machineAccountId: 'company-account',
  displaySessionId: 'manual-session', createBodyHash: 'a'.repeat(64), executionBindingRequired: true };
const input = { ...target, bearer: 'machine-account-bearer', secret: 'test-secret-that-is-at-least-thirty-two-bytes', now: 10_000 };
const verify = (token: string, patch: Record<string, unknown> = {}) => verifyAutomationExecutionTarget({
  token, expected: target, bearer: input.bearer, secret: input.secret, now: input.now, ...patch,
});

describe('automation execution display target proof', () => {
  it('requires the exact one-off request identity and rejects a legacy proof without it', () => {
    const question = { ...target, questionRequestId: '9cc41d26-562e-4b48-8e2f-a38dc2c85a78' };
    const token = signAutomationExecutionTarget({ ...input, ...question });
    expect(verify(token, { expected: question })).toBe(true);
    expect(verify(token)).toBe(false);
    expect(verify(signAutomationExecutionTarget(input), { expected: question })).toBe(false);
    expect(verify(token, { expected: { ...question, questionRequestId: 'd23e9200-51d4-4f8a-adf7-4ed3dc7d26d6' } })).toBe(false);
  });
  it('binds the original company authority identity and refuses omission or substitution', () => {
    const bound = { ...target, executionAuthorityDigest: 'b'.repeat(64) };
    const token = signAutomationExecutionTarget({ ...input, ...bound });
    expect(verify(token, { expected: bound })).toBe(true);
    expect(verify(token)).toBe(false);
    expect(verify(token, { expected: { ...bound, executionAuthorityDigest: 'c'.repeat(64) } })).toBe(false);
    expect(verify(signAutomationExecutionTarget(input), { expected: bound })).toBe(false);
  });
  it('authenticates a run, its immutable display target and the exact encrypted creation body', () => {
    const token = signAutomationExecutionTarget(input);
    expect(verify(token)).toBe(true);
    expect(token).not.toContain(input.bearer);
    expect(verify(token, { now: input.now + 29_999 })).toBe(true);
  });

  it.each(Object.keys(target))('rejects changing %s even when the other identifiers match', field => {
    const token = signAutomationExecutionTarget(input);
    const current = target[field as keyof typeof target];
    const changed = typeof current === 'number' ? current + 1 : typeof current === 'boolean' ? !current : `${current}-other`;
    expect(verify(token, { expected: { ...target, [field]: changed } })).toBe(false);
  });

  it('rejects another bearer, another secret, expiry, a future issue time and malformed tokens', () => {
    const token = signAutomationExecutionTarget(input);
    expect(verify(token, { bearer: 'other-account-bearer' })).toBe(false);
    expect(verify(token, { secret: `${input.secret}-other` })).toBe(false);
    expect(verify(token, { now: input.now + 30_000 })).toBe(false);
    expect(verify(token, { now: input.now - 5_001 })).toBe(false);
    for (const invalid of ['', 'AET1.e30.invalid', `${token}extra`, 'x'.repeat(8_193)]) {
      expect(verify(invalid)).toBe(false);
    }
  });

  it('fails closed without a configured secret and rejects unsafe creation or scope claims', () => {
    expect(() => signAutomationExecutionTarget({ ...input, secret: '' })).toThrow('AUTOMATION_EXECUTION_SECRET_REQUIRED');
    expect(verify(signAutomationExecutionTarget(input), { secret: '' })).toBe(false);
    for (const patch of [{ runId: '' }, { generation: 0 }, { revision: 0 }, { createBodyHash: 'not-a-digest' },
      { displaySessionId: 'x'.repeat(201) }]) {
      expect(() => signAutomationExecutionTarget({ ...input, ...patch })).toThrow();
    }
  });
});

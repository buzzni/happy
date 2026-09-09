import { expect, it } from 'vitest';
import { hashScriptInput, signScriptServiceToken, verifyScriptServiceToken } from './scriptServiceToken';
const secret = 'test-service-secret-'.repeat(3);
const claims = { operation: 'enqueue' as const, projectId: 'project', automationId: 'automation', keyId: 'key', epoch: 2,
  revision: 3, generation: 1, inputHash: 'a'.repeat(64), idempotencyKey: 'request' };
const context = { operation: 'enqueue' as const, projectId: 'project', automationId: 'automation', secret, now: 2000 };
it('binds a short-lived service proof to its audience, operation, scope and key epoch', () => {
  const token = signScriptServiceToken({ claims, secret, now: 1000 });
  expect(verifyScriptServiceToken({ ...context, token })).toEqual(claims);
  expect(verifyScriptServiceToken({ ...context, token, projectId: 'foreign' })).toBeNull();
  expect(verifyScriptServiceToken({ ...context, token, operation: 'status' })).toBeNull();
  expect(verifyScriptServiceToken({ ...context, token, secret: 'other-service-secret'.repeat(3) })).toBeNull();
  expect(verifyScriptServiceToken({ ...context, token, now: 31000 })).toBeNull();
  expect(verifyScriptServiceToken({ ...context, token: token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a') })).toBeNull();
  const future = signScriptServiceToken({ claims, secret, now: 10000 });
  expect(verifyScriptServiceToken({ ...context, token: future })).toBeNull();
});
it('rejects an absent service secret and hashes JSON inputs independent of object key order', () => {
  expect(() => signScriptServiceToken({ claims, secret: '', now: 1000 })).toThrow('SCRIPT_SERVICE_SECRET_REQUIRED');
  expect(hashScriptInput({ b: [1, { y: 3, x: 2 }], a: true })).toBe(hashScriptInput({ a: true, b: [1, { x: 2, y: 3 }] }));
  expect(hashScriptInput({ a: 1 })).not.toBe(hashScriptInput({ a: 2 }));
  expect(() => hashScriptInput({ text: 'x'.repeat(65536) })).toThrow('INPUT_TOO_LARGE');
});

it('derives stable registration IDs without collisions across project and registration-key boundaries', async () => {
  const { scriptAutomationId } = await import('./scriptServiceToken');
  expect(scriptAutomationId('p', 'collect')).toBe(scriptAutomationId('p', 'collect'));
  expect(scriptAutomationId('p', 'collect')).not.toBe(scriptAutomationId('other', 'collect'));
  expect(scriptAutomationId('a:b', 'c')).not.toBe(scriptAutomationId('a', 'b:c'));
});

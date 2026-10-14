import { expect, it } from 'vitest';
import { signChatAutomationLifecycle, verifyChatAutomationLifecycle } from './chatAutomationLifecycleToken';
const input = { secret: 'server-only-secret'.repeat(3), now: 100000, projectId: 'chat:c', state: 'deleted' as const, actorUserId: 'owner', bearer: 'account-token' };
it('requires server authority bound to the Chat, action and authenticated Happy token', () => {
  const token = signChatAutomationLifecycle(input);
  expect(verifyChatAutomationLifecycle({ ...input, token })).toBe(true);
  for (const patch of [{ projectId: 'chat:other' }, { state: 'archived' as const }, { bearer: 'other-account-token' }, { secret: 'wrong'.repeat(10) }, { now: input.now + 30000 }]) expect(verifyChatAutomationLifecycle({ ...input, ...patch, token })).toBe(false);
  expect(verifyChatAutomationLifecycle({ ...input, token: token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a') })).toBe(false);
  expect(verifyChatAutomationLifecycle({ ...input, token: input.bearer })).toBe(false);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1)!) + 1];
  expect(verifyChatAutomationLifecycle({ ...input, token: alias })).toBe(false);
});

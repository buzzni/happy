import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import {
  eventRouter, buildNewSessionUpdate, buildNewMessageUpdate, buildUpdateSessionUpdate,
  buildDeleteSessionUpdate, buildSessionActivityEphemeral, buildSessionEventEphemeral,
  buildUsageEphemeral,
} from './eventRouter';

const sessionId = 'automation-run:run-1';
const to = vi.fn(() => ({ emit: vi.fn() }));
beforeEach(() => {
  to.mockClear();
  eventRouter.init({ to } as unknown as Server);
  eventRouter.initManaged(null);
});

describe('run-owned execution visibility', () => {
  const session = { id: sessionId, seq: 0, metadata: 'encrypted', metadataVersion: 0,
    agentState: null, agentStateVersion: 0, dataEncryptionKey: null, active: true,
    lastActiveAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0) };
  const message = { id: 'message', seq: 1, content: { t: 'encrypted' as const, c: 'ciphertext' },
    localId: 'run:run-1', createdAt: new Date(0), updatedAt: new Date(0) };

  it.each([
    buildNewSessionUpdate(session, 1, 'new'),
    buildNewMessageUpdate(message, sessionId, 2, 'message'),
    buildUpdateSessionUpdate(sessionId, 3, 'metadata'),
    buildDeleteSessionUpdate(sessionId, 4, 'deleted'),
  ])('keeps $body.t away from generic user fan-out while preserving its execution socket', payload => {
    eventRouter.emitUpdate({ userId: 'user-1', payload, recipientFilter: { type: 'all-interested-in-session', sessionId } });
    expect(to).toHaveBeenCalledWith([`user:user-1:session:${sessionId}`]);
  });

  it.each([
    buildSessionActivityEphemeral(sessionId, true, 0, true),
    buildUsageEphemeral(sessionId, 'usage', { input: 1 }, null),
    buildSessionEventEphemeral(sessionId, 'done', 'Completed', 'Completed'),
    { type: 'stream' as const, id: sessionId, time: 0, data: 'ciphertext' },
  ])('keeps $type away from generic user fan-out', payload => {
    eventRouter.emitEphemeral({ userId: 'user-1', payload, recipientFilter: { type: 'user-scoped-only' } });
    expect(to).toHaveBeenCalledWith([`user:user-1:session:${sessionId}`]);
  });

  it('preserves ordinary session fan-out', () => {
    eventRouter.emitUpdate({ userId: 'user-1', payload: buildUpdateSessionUpdate('manual', 1, 'metadata'),
      recipientFilter: { type: 'all-interested-in-session', sessionId: 'manual' } });
    expect(to).toHaveBeenCalledWith(['user:user-1:session:manual', 'user:user-1:user-scoped']);
  });
});

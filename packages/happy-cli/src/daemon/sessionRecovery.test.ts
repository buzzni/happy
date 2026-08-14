import { describe, expect, it } from 'vitest';

import type { PersistedSession } from '@/persistence';
import type { ReconnectableHappySession } from '@/resume/resolveHappySession';
import {
  classifyRecoveryLookupError,
  decideUntrackedSessionRecovery,
} from './sessionRecovery';

function serverSession(
  overrides: Partial<ReconnectableHappySession> = {},
): ReconnectableHappySession {
  return {
    id: 'happy-old',
    active: false,
    metadata: {
      path: '/tmp/project',
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happy',
      happyLibDir: '/tmp/.happy/lib',
      happyToolsDir: '/tmp/.happy/tools',
      flavor: 'claude',
      claudeSessionId: 'claude-old',
    },
    seq: 21,
    metadataVersion: 4,
    agentStateVersion: 3,
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'dataKey',
    ...overrides,
  };
}

function persisted(lastProcessedSeq?: number): PersistedSession {
  const session = serverSession();
  return {
    encryptionKey: Buffer.from(session.encryptionKey).toString('base64'),
    encryptionVariant: session.encryptionVariant,
    seq: 18,
    metadataVersion: 3,
    agentStateVersion: 2,
    metadata: session.metadata,
    savedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
    ...(lastProcessedSeq !== undefined ? { lastProcessedSeq } : {}),
  };
}

describe('decideUntrackedSessionRecovery', () => {
  it('refuses an active server session that has no local daemon child', () => {
    expect(decideUntrackedSessionRecovery({
      serverSession: serverSession({ active: true }),
      persistedSession: undefined,
      pathExists: true,
      nativeSessionExists: true,
    })).toEqual({
      kind: 'refuse',
      code: 'SESSION_ALIVE_ELSEWHERE',
      reason: expect.any(String),
    });
  });

  it('reconnects the same Happy session when a reliable processed cursor remains', () => {
    expect(decideUntrackedSessionRecovery({
      serverSession: serverSession(),
      persistedSession: persisted(17),
      pathExists: true,
      nativeSessionExists: true,
    })).toEqual({
      kind: 'same-session',
      baselineSeq: 17,
    });
  });

  it('continues into a new Happy session when the processed cursor is unavailable', () => {
    expect(decideUntrackedSessionRecovery({
      serverSession: serverSession(),
      persistedSession: persisted(),
      pathExists: true,
      nativeSessionExists: true,
    })).toEqual({
      kind: 'new-session',
      agent: 'claude',
      directory: '/tmp/project',
      resumeClaudeSessionId: 'claude-old',
    });
  });

  it('continues a verified Codex thread into a new Happy session', () => {
    expect(decideUntrackedSessionRecovery({
      serverSession: serverSession({
        metadata: {
          ...serverSession().metadata,
          flavor: 'codex',
          claudeSessionId: undefined,
          codexThreadId: 'codex-old',
        },
      }),
      persistedSession: undefined,
      pathExists: true,
      nativeSessionExists: true,
    })).toEqual({
      kind: 'new-session',
      agent: 'codex',
      directory: '/tmp/project',
      resumeCodexThreadId: 'codex-old',
    });
  });

  it('refuses recovery when the worktree no longer exists', () => {
    expect(decideUntrackedSessionRecovery({
      serverSession: serverSession(),
      persistedSession: undefined,
      pathExists: false,
      nativeSessionExists: true,
    })).toEqual({
      kind: 'refuse',
      code: 'SESSION_DIRECTORY_MISSING',
      reason: expect.any(String),
    });
  });

  it('refuses recovery when the native provider session cannot be verified', () => {
    expect(decideUntrackedSessionRecovery({
      serverSession: serverSession(),
      persistedSession: undefined,
      pathExists: true,
      nativeSessionExists: false,
    })).toEqual({
      kind: 'refuse',
      code: 'SESSION_NATIVE_SESSION_MISSING',
      reason: expect.any(String),
    });
  });
});

describe('classifyRecoveryLookupError', () => {
  it.each([
    'Failed to decrypt data key for Happy session happy-old',
    'Happy session lookup authentication expired',
  ])('classifies identity-sensitive lookup failures without exposing continuation', (message) => {
    expect(classifyRecoveryLookupError(new Error(message))).toEqual({
      code: 'SESSION_IDENTITY_MISMATCH',
      errorMessage: expect.any(String),
    });
  });

  it('classifies a missing resumable record as not tracked', () => {
    expect(classifyRecoveryLookupError(new Error('No Happy session found matching "happy-old"'))).toEqual({
      code: 'SESSION_NOT_TRACKED',
      errorMessage: expect.any(String),
    });
  });

  it('classifies transport failures as server unavailable', () => {
    expect(classifyRecoveryLookupError(new Error('Failed to load Happy sessions: timeout'))).toEqual({
      code: 'SESSION_SERVER_UNAVAILABLE',
      errorMessage: expect.any(String),
    });
  });
});

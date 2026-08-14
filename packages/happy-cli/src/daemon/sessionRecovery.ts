import type { PersistedSession } from '@/persistence';
import type { ReconnectableHappySession } from '@/resume/resolveHappySession';
import type { ResumeSessionErrorCode } from '@/modules/common/registerCommonHandlers';

export type UntrackedSessionRecoveryDecision =
  | { kind: 'same-session'; baselineSeq: number }
  | {
      kind: 'new-session';
      agent: 'claude';
      directory: string;
      resumeClaudeSessionId: string;
    }
  | {
      kind: 'new-session';
      agent: 'codex';
      directory: string;
      resumeCodexThreadId: string;
    }
  | { kind: 'refuse'; code: ResumeSessionErrorCode; reason: string };

function reliableBaseline(session: PersistedSession | undefined): number | undefined {
  const value = session?.lastProcessedSeq;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function classifyRecoveryLookupError(error: unknown): {
  code: ResumeSessionErrorCode;
  errorMessage: string;
} {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes('Failed to decrypt')
    || message.includes('authentication expired')
    || message.includes('auth login')
  ) {
    return {
      code: 'SESSION_IDENTITY_MISMATCH',
      errorMessage: 'Cannot safely recover this session with the current Happy account credentials.',
    };
  }

  if (message.includes('No Happy session found matching')) {
    return {
      code: 'SESSION_NOT_TRACKED',
      errorMessage: message,
    };
  }

  if (message.includes('missing resumable metadata')) {
    return {
      code: 'SESSION_METADATA_MISSING',
      errorMessage: message,
    };
  }

  return {
    code: 'SESSION_SERVER_UNAVAILABLE',
    errorMessage: `Cannot load the session for recovery: ${message}`,
  };
}

export function decideUntrackedSessionRecovery(input: {
  serverSession: ReconnectableHappySession;
  persistedSession: PersistedSession | undefined;
  pathExists: boolean;
  nativeSessionExists: boolean;
}): UntrackedSessionRecoveryDecision {
  const { serverSession } = input;

  if (serverSession.active) {
    return {
      kind: 'refuse',
      code: 'SESSION_ALIVE_ELSEWHERE',
      reason: `Session ${serverSession.id} is active outside this daemon.`,
    };
  }

  if (!input.pathExists) {
    return {
      kind: 'refuse',
      code: 'SESSION_DIRECTORY_MISSING',
      reason: `Session directory does not exist: ${serverSession.metadata.path}`,
    };
  }

  if (!input.nativeSessionExists) {
    return {
      kind: 'refuse',
      code: 'SESSION_NATIVE_SESSION_MISSING',
      reason: `The original agent session for ${serverSession.id} could not be verified.`,
    };
  }

  const baselineSeq = reliableBaseline(input.persistedSession);
  if (baselineSeq !== undefined) {
    return { kind: 'same-session', baselineSeq };
  }

  const metadata = serverSession.metadata;
  if ((metadata.flavor === 'codex' || metadata.codexThreadId) && metadata.codexThreadId) {
    return {
      kind: 'new-session',
      agent: 'codex',
      directory: metadata.path,
      resumeCodexThreadId: metadata.codexThreadId,
    };
  }

  if ((metadata.flavor === 'claude' || metadata.claudeSessionId) && metadata.claudeSessionId) {
    return {
      kind: 'new-session',
      agent: 'claude',
      directory: metadata.path,
      resumeClaudeSessionId: metadata.claudeSessionId,
    };
  }

  return {
    kind: 'refuse',
    code: 'SESSION_NATIVE_SESSION_MISSING',
    reason: `Session ${serverSession.id} has no supported native resume identifier.`,
  };
}

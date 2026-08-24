import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { hydrateTrackedSessionFromPersisted } from './persistedSessionHydration';
import type { PersistedSession } from '@/persistence';

const metadata = { path: '/work/repo', host: 'mac' } as unknown as Metadata;

function persisted(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    encryptionKey: encodeBase64(new Uint8Array([1, 2, 3, 4])),
    encryptionVariant: 'legacy',
    seq: 12,
    metadataVersion: 3,
    agentStateVersion: 4,
    metadata,
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('hydrateTrackedSessionFromPersisted', () => {
  it('shouldReturnNothingWhenNoRecordExists', () => {
    expect(hydrateTrackedSessionFromPersisted(undefined)).toEqual({});
  });

  it('shouldRestoreEncryptionSoResumePreservationCanRun', () => {
    const hydrated = hydrateTrackedSessionFromPersisted(persisted());

    expect(hydrated.encryption).toEqual({
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
      seq: 12,
      metadataVersion: 3,
      agentStateVersion: 4,
    });
  });

  it('shouldRestoreMetadataAndUserHomeDir', () => {
    const hydrated = hydrateTrackedSessionFromPersisted(persisted({ userHomeDir: '/tmp/happy-session-1' }));

    expect(hydrated.happySessionMetadataFromLocalWebhook).toBe(metadata);
    expect(hydrated.userHomeDir).toBe('/tmp/happy-session-1');
  });

  it('shouldRestoreTheResumeCursorWhenPresent', () => {
    expect(hydrateTrackedSessionFromPersisted(persisted({ lastProcessedSeq: 41 })).persistedLastProcessedSeq).toBe(41);
  });

  it('shouldRestoreTheSaycodeAgentCapabilityAcrossDaemonRestarts', () => {
    const agentEnvironment = {
      SAYCODE_AGENT_ENV: '1' as const,
      SAYCODE_AGENT_ROOT: 'root-session',
      SAYCODE_AGENT_DEPTH: '2',
      SAYCODE_AGENT_MAX_SPAWN: '4',
      SAYCODE_AGENT_ID: 'worker-1',
    };

    expect(hydrateTrackedSessionFromPersisted(persisted({ agentEnvironment })).agentEnvironment)
      .toEqual(agentEnvironment);
  });

  it('shouldValidatePersistedAgentCapabilityBeforeAddingItToTheChildEnvironment', () => {
    const agentEnvironment = {
      SAYCODE_AGENT_ENV: '1',
      SAYCODE_AGENT_ROOT: 'root-session',
      NODE_OPTIONS: '--require /tmp/untrusted.cjs',
    } as unknown as NonNullable<PersistedSession['agentEnvironment']>;

    expect(hydrateTrackedSessionFromPersisted(persisted({ agentEnvironment })).agentEnvironment)
      .toEqual({
        SAYCODE_AGENT_ENV: '1',
        SAYCODE_AGENT_ROOT: 'root-session',
      });
  });

  // Callers spread this over a session that may already hold fresher values, so
  // an absent field must stay absent instead of overwriting one with undefined.
  it('shouldOmitKeysTheRecordDoesNotCarry', () => {
    const hydrated = hydrateTrackedSessionFromPersisted(persisted());

    expect('persistedLastProcessedSeq' in hydrated).toBe(false);
    expect('userHomeDir' in hydrated).toBe(false);
    expect('agentEnvironment' in hydrated).toBe(false);
  });

  // A fabricated runtime would make the idle guard treat a restored session as
  // one that has reported since this daemon started; its stale-runtime
  // protection depends on runtime being absent until a real report arrives.
  it('shouldNotFabricateRuntimeState', () => {
    expect('runtime' in hydrateTrackedSessionFromPersisted(persisted({ lastProcessedSeq: 41 }))).toBe(false);
  });
});

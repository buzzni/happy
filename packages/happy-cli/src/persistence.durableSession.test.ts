/** Durable session publication: real local files with failures at filesystem boundaries. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fsyncSync, fstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSetupTokenAccountSwitch } from './daemon/setupTokenAccountSwitch'
import { persistSetupTokenBinding } from './daemon/setupTokenBindingPersistence'
import { formatSetupTokenBinding, SETUP_TOKEN_BINDING_ENV, type SetupTokenBinding } from './daemon/sessionEnv'
import type { TrackedSession } from './daemon/types'
import { configuration } from './configuration'
import { persistSession, persistSessionDurably, recoverPersistedSessionDurably, persistPreparedMachineLaunch, recoverPreparedMachineLaunch, preparedMachineLaunchHomeDirs, readPersistedSessions, type PersistedSession } from './persistence'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync),
    writeFileSync: vi.fn(fs.writeFileSync), readFileSync: vi.fn(fs.readFileSync),
    closeSync: vi.fn(fs.closeSync), openSync: vi.fn(fs.openSync) }
})

const originalFs = await vi.importActual<typeof import('node:fs')>('node:fs')

const record = (binding: string): PersistedSession => ({
  encryptionKey: Buffer.alloc(32, 1).toString('base64'), encryptionVariant: 'dataKey', seq: 7,
  metadataVersion: 3, agentStateVersion: 2, metadata: { path: '/project', host: 'host' } as PersistedSession['metadata'],
  savedAt: 10, lastProcessedSeq: 6, agentEnvironment: { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: binding },
})
const old = record('binding-a')
const next = record('binding-b')
let directory: string
const originalPath = configuration.sessionsFile
const ioError = (code: string) => Object.assign(new Error('injected filesystem failure'), { code })

beforeEach(() => {
  vi.resetAllMocks()
  directory = mkdtempSync(join(configuration.happyHomeDir, 'durable-'))
  Object.defineProperty(configuration, 'sessionsFile', { configurable: true, value: join(directory, 'sessions.json') })
  writeFileSync(configuration.sessionsFile, JSON.stringify({ sessions: { target: old, other: old }, futureField: true }))
})
afterEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(configuration, 'sessionsFile', { configurable: true, value: originalPath })
  rmSync(directory, { recursive: true, force: true })
})

function expectOldStore() {
  expect(readPersistedSessions()).toEqual({ target: old, other: old })
  expect(readdirSync(directory)).toEqual(['sessions.json'])
}

describe('durable session persistence', () => {
  it('ACKs after private file sync, rename and supported directory sync, retaining other records and envelope fields', () => {
    const stages: string[] = []
    const realSync = originalFs.fsyncSync
    const realRename = originalFs.renameSync
    vi.mocked(fsyncSync).mockImplementation(fd => { stages.push(fstatSync(fd).isDirectory() ? 'directory-sync' : 'file-sync'); realSync(fd) })
    vi.mocked(renameSync).mockImplementation((...args) => { stages.push('rename'); realRename(...args) })
    expect(persistSessionDurably('target', next)).toEqual({ status: 'committed' })
    expect(stages).toEqual(process.platform === 'win32' ? ['file-sync', 'rename'] : ['file-sync', 'rename', 'directory-sync'])
    expect(readPersistedSessions()).toEqual({ target: next, other: old })
    expect(JSON.parse(readFileSync(configuration.sessionsFile, 'utf8')).futureField).toBe(true)
    if (process.platform !== 'win32') expect(statSync(configuration.sessionsFile).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory)).toEqual(['sessions.json'])
  })

  it('durably retains the original encryption snapshot without exposing a pending launch as a resumable session', () => {
    const snapshot = { ...old, agentEnvironment: undefined, userHomeDir: '/staged-original' };
    expect(persistPreparedMachineLaunch('launch', 'create-digest', snapshot)).toEqual({ status: 'committed' });
    expect(readPersistedSessions()).toEqual({ target: old, other: old });
    expect(recoverPreparedMachineLaunch('launch', 'wrong-digest')).toBeNull();
    expect(recoverPreparedMachineLaunch('launch', 'create-digest')).toEqual(snapshot);
    expect(preparedMachineLaunchHomeDirs()).toEqual(['/staged-original']);
    persistSession('other', next);
    expect(recoverPreparedMachineLaunch('launch', 'create-digest')).toEqual(snapshot);
  });

  it('refuses durable machine revision rollback and preserves the newest binding across stale webhook writes', () => {
    const machineBinding = (revision: number) => JSON.stringify({ version: 2, type: 'claude-setup-token-binding', audience: 'saycode-daemon', principalType: 'machine',
      companyId: 'company', machineId: 'machine', groupScope: 'company', assignmentGeneration: 1, assignmentFingerprint: 'a'.repeat(64),
      managedAccountId: 'account', credentialGeneration: 1, approvalId: 'approval', deviceKeyId: 'b'.repeat(64), launchId: 'launch', bindingRevision: revision,
      nonce: Buffer.alloc(32, revision).toString('base64url'), previousNonce: revision === 1 ? null : Buffer.alloc(32, revision - 1).toString('base64url'),
      issuedAt: 1000, expiresAt: 61000, keyId: 'c'.repeat(64), execution: { sessionId: 'machine-session', initialNonce: Buffer.alloc(32, 1).toString('base64url'),
        issueOperationId: 'issue', sessionOwnerAccountId: 'owner', machineOwnerAccountId: 'machine-owner' } });
    const first = record(machineBinding(1)), second = record(machineBinding(2));
    expect(persistSessionDurably('machine-session', first).status).toBe('committed');
    expect(persistSessionDurably('machine-session', second).status).toBe('committed');
    expect(persistSessionDurably('machine-session', first).status).toBe('failed');
    persistSession('machine-session', { ...first, lastProcessedSeq: 10 });
    expect(readPersistedSessions()['machine-session'].agentEnvironment).toEqual(second.agentEnvironment);
    expect(readPersistedSessions()['machine-session'].lastProcessedSeq).toBe(10);
  });

  it('creates an absent store and ignores a stale shared .tmp without following it', () => {
    rmSync(configuration.sessionsFile)
    writeFileSync(`${configuration.sessionsFile}.tmp`, 'unrelated stale temporary')
    expect(persistSessionDurably('target', next)).toEqual({ status: 'committed' })
    expect(readPersistedSessions()).toEqual({ target: next })
    expect(readFileSync(`${configuration.sessionsFile}.tmp`, 'utf8')).toBe('unrelated stale temporary')
  })

  it.each(['write', 'file-sync', 'rename'] as const)('reports %s failure without losing the old record or leaking a temp file', stage => {
    if (stage === 'write') vi.mocked(writeFileSync).mockImplementationOnce(file => { originalFs.writeFileSync(file, 'partial'); throw ioError('ENOSPC') })
    if (stage === 'file-sync') vi.mocked(fsyncSync).mockImplementationOnce(() => { throw ioError('EIO') })
    if (stage === 'rename') vi.mocked(renameSync).mockImplementationOnce(() => { throw ioError('EACCES') })
    expect(persistSessionDurably('target', next)).toEqual({ status: 'failed' })
    expectOldStore()
    expect(persistSessionDurably('target', next)).toEqual({ status: 'committed' })
  })

  it('reports a read error instead of interpreting it as an empty store', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw ioError('EACCES') })
    expect(persistSessionDurably('target', next)).toEqual({ status: 'failed' })
    expectOldStore()
  })

  it('does not treat a missing parent directory as an empty creatable store', () => {
    Object.defineProperty(configuration, 'sessionsFile', { configurable: true, value: join(directory, 'absent', 'sessions.json') })
    expect(persistSessionDurably('target', next)).toEqual({ status: 'failed' })
  })

  it.each(['{broken', '{}', '{"sessions":[]}', '{"sessions":null}', '{"sessions":{"other":null}}',
    '{"sessions":{"other":{"metadata":{}}}}'])('preserves corrupt input byte for byte (%s)', raw => {
    writeFileSync(configuration.sessionsFile, raw)
    expect(persistSessionDurably('target', next)).toEqual({ status: 'failed' })
    expect(readFileSync(configuration.sessionsFile, 'utf8')).toBe(raw)
    expect(readdirSync(directory)).toEqual(['sessions.json'])
  })

  it.skipIf(process.platform === 'win32')('quarantines a visible post-rename result when directory sync fails; a restarted persistence module reads the survivor', async () => {
    const realSync = originalFs.fsyncSync
    vi.mocked(fsyncSync).mockImplementation(fd => {
      if (fstatSync(fd).isDirectory()) throw ioError('EIO')
      realSync(fd)
    })
    expect(persistSessionDurably('target', next)).toEqual({ status: 'indeterminate' })
    const visible = readFileSync(configuration.sessionsFile, 'utf8')
    expect(JSON.parse(visible).sessions.target).toEqual(next)
    vi.resetAllMocks()
    // A resume/cursor/stop writer must not overwrite B with the still-committed in-memory A.
    expect(readPersistedSessions()).toEqual({})
    expect(() => persistSession('target', old)).not.toThrow()
    expect(persistSessionDurably('target', old)).toEqual({ status: 'indeterminate' })
    expect(readFileSync(configuration.sessionsFile, 'utf8')).toBe(visible)
    expect(readdirSync(directory)).toEqual(['sessions.json'])
    // Reload only module-local state, as on daemon restart. This proves visibility/recovery,
    // not survival of a power loss after a failed directory flush.
    vi.resetModules()
    vi.doMock('./configuration', () => ({ configuration }))
    try {
      const restarted = await import('./persistence')
      expect(restarted.readPersistedSessions()).toEqual({ target: next, other: old })
    } finally { vi.doUnmock('./configuration') }
  })

  it.skipIf(process.platform === 'win32')('re-ACKs only the exact journal binding after uncertain publication, preserving other sessions', () => {
    vi.mocked(fsyncSync).mockImplementation(fd => { if (fstatSync(fd).isDirectory()) throw ioError('EIO'); originalFs.fsyncSync(fd) })
    expect(persistSessionDurably('target', next)).toEqual({ status: 'indeterminate' })
    expect(recoverPersistedSessionDurably('target', 'binding-a')).toEqual({ status: 'indeterminate' })
    expect(readPersistedSessions()).toEqual({})
    vi.resetAllMocks()
    expect(recoverPersistedSessionDurably('target', 'binding-a')).toEqual({ status: 'indeterminate' })
    expect(recoverPersistedSessionDurably('target', 'binding-b')).toEqual({ status: 'committed' })
    expect(readPersistedSessions()).toEqual({ target: next, other: old })
    expect(JSON.parse(readFileSync(configuration.sessionsFile, 'utf8')).futureField).toBe(true)
  })

  it.each(['{"sessions":', 'invalid json', 'null', '[]'])('restores ordinary session persistence after corrupt JSON (%s)', raw => {
    writeFileSync(configuration.sessionsFile, raw);
    const ordinary = { ...next, agentEnvironment: undefined };
    persistSession('ordinary', ordinary);
    expect(readPersistedSessions().ordinary).toEqual(ordinary);
    const envelope = JSON.parse(readFileSync(configuration.sessionsFile, 'utf8'));
    expect(readFileSync(envelope.corruptStoreBackup, 'utf8')).toBe(raw);
    if (process.platform !== 'win32') expect(statSync(envelope.corruptStoreBackup).mode & 0o777).toBe(0o600);
    expect(persistSessionDurably('target', next)).toEqual({ status: 'failed' });
    expect(persistPreparedMachineLaunch('launch', 'digest', ordinary)).toEqual({ status: 'failed' });
    expect(recoverPersistedSessionDurably('target', 'binding-b').status).toBe('failed');
    expect(recoverPreparedMachineLaunch('launch', 'digest')).toBeNull();
    expect(() => preparedMachineLaunchHomeDirs()).toThrow('recovery required');
    persistSession('target', next);
    expect(readPersistedSessions().target).toBeUndefined();
    persistSession('ordinary', { ...ordinary, seq: 8 });
    expect(readPersistedSessions().ordinary.seq).toBe(8);
    expect(JSON.parse(readFileSync(configuration.sessionsFile, 'utf8')).corruptStoreBackup).toBe(envelope.corruptStoreBackup);
  });

  it('keeps corrupt bytes intact when the recovery backup cannot be synced', () => {
    const raw = '{"sessions":';
    writeFileSync(configuration.sessionsFile, raw);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw ioError('EIO') });
    persistSession('ordinary', { ...next, agentEnvironment: undefined });
    expect(readFileSync(configuration.sessionsFile, 'utf8')).toBe(raw);
    expect(persistSessionDurably('target', next).status).toBe('failed');
  });

  it('keeps ordinary persistSession best effort on an unrelated store', () => {
    vi.mocked(renameSync).mockImplementationOnce(() => { throw ioError('ENOSPC') })
    expect(() => persistSession('target', next)).not.toThrow()
    expect(readPersistedSessions().target).toEqual(old)
    persistSession('target', next)
    expect(readPersistedSessions().target).toEqual(next)
  })
})


describe('rebind through the actual daemon persistence callback', () => {
  const A = '00000000-0000-4000-8000-00000000000a'
  const B = '00000000-0000-4000-8000-00000000000b'
  const bound = (account: string, issuedAt: number): SetupTokenBinding => ({
    managedAccountId: account, credentialGeneration: 1, groupScope: 'org-a', companyId: 'org-a',
    userId: 'user-a', machineId: 'pc-a', keyId: 'f'.repeat(64), nonce: account, issuedAt,
  })
  const running = formatSetupTokenBinding(bound(A, 1))
  const switched = formatSetupTokenBinding(bound(B, 2))
  const stages = process.platform === 'win32' ? ['write', 'file-sync', 'rename'] : ['write', 'file-sync', 'rename', 'directory-sync']

  it.each(stages)('returns no token and keeps committed memory on %s failure', async stage => {
    const committed = { [SETUP_TOKEN_BINDING_ENV]: running }
    const session: TrackedSession = {
      startedBy: 'daemon', pid: 123, happySessionId: 'target', agentEnvironment: committed,
      encryption: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey', seq: 7, metadataVersion: 3, agentStateVersion: 2 },
      happySessionMetadataFromLocalWebhook: old.metadata, persistedLastProcessedSeq: 6,
    }
    writeFileSync(configuration.sessionsFile, JSON.stringify({ sessions: { target: { ...old, agentEnvironment: committed }, other: old } }))
    const request = vi.fn(async () => Response.json({ version: 1, bindingGrant: 'claims.signature', managedAccountId: B, credentialGeneration: 1 }))
    const verify = vi.fn(async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'test-next-token', [SETUP_TOKEN_BINDING_ENV]: switched }))
    const switcher = createSetupTokenAccountSwitch({
      findSession: id => id === 'target' ? session : undefined, studioOrigin: 'https://studio.test', machineId: 'pc-a',
      bearer: () => 'test-machine-token', fetch: request, sessionEnvironment: verify, recordAgentEnvironment: persistSetupTokenBinding,
    })
    if (stage === 'write') vi.mocked(writeFileSync).mockImplementationOnce(() => { throw ioError('ENOSPC') })
    if (stage === 'file-sync') vi.mocked(fsyncSync).mockImplementationOnce(() => { throw ioError('EIO') })
    if (stage === 'rename') vi.mocked(renameSync).mockImplementationOnce(() => { throw ioError('EACCES') })
    if (stage === 'directory-sync') vi.mocked(fsyncSync).mockImplementation(fd => {
      if (fstatSync(fd).isDirectory()) throw ioError('EIO')
      originalFs.fsyncSync(fd)
    })
    const reason = stage === 'directory-sync' ? 'PERSISTENCE_INDETERMINATE' : 'PERSISTENCE_FAILED'
    expect(await switcher.rebind('target', running)).toEqual({ ok: false, reason })
    expect(session.agentEnvironment).toBe(committed)
    const visible = JSON.parse(readFileSync(configuration.sessionsFile, 'utf8'))
    expect(visible.sessions.target.agentEnvironment[SETUP_TOKEN_BINDING_ENV]).toBe(stage === 'directory-sync' ? switched : running)
    expect(visible.sessions.other).toEqual(old)
    if (stage === 'directory-sync') {
      expect(await switcher.rebind('target', running)).toEqual({ ok: false, reason })
      expect(session.agentEnvironment).toBe(committed)
    } else {
      expect(await switcher.rebind('target', running)).toEqual({ ok: true, environment: {
        CLAUDE_CODE_OAUTH_TOKEN: 'test-next-token', [SETUP_TOKEN_BINDING_ENV]: switched,
      } })
      expect(session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV]).toBe(switched)
    }
    expect(request).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledTimes(stage === 'directory-sync' ? 1 : 2)
    if (stage !== 'directory-sync') expect(verify).toHaveBeenLastCalledWith('claude', expect.objectContaining({ managedAccountId: B }), bound(B, 2))
  })
})

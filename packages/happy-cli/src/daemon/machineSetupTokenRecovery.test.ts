import { describe, expect, it, vi } from 'vitest'
import { discoverMachineSetupTokenSession } from './machineSetupTokenRecovery'
import type { MachineRotationJournalRecord } from './machineSetupTokenJournal'
const initialNonce = Buffer.alloc(32, 1).toString('base64url')
const body = { tag: 'original-tag', metadata: 'encrypted-metadata', agentState: 'encrypted-state', dataEncryptionKey: 'wrapped-key' }
const state = { version: 1, launchId: 'launch', pending: { request: { action: 'issue', companyId: 'company', machineId: 'machine', sessionOwnerAccountId: 'personal' },
  machineOwnerAccountId: 'company-account', binding: { nonce: initialNonce }, createBody: body } } as MachineRotationJournalRecord
const raw = { id: 'created-session', seq: 0, metadataVersion: 1, agentStateVersion: 1, ...body }
const owner = { companyId: 'company', machineId: 'machine', sessionId: raw.id, launchId: 'launch', initialNonce, sessionOwnerAccountId: 'personal', machineOwnerAccountId: 'company-account' }
function setup(overrides: { profile?: string; relation?: unknown; missing?: boolean } = {}) {
  const requests: Array<{ url: string; bearer: string; body?: unknown }> = []
  const fetcher = vi.fn(async (url, options) => {
    const bearer = (options?.headers as Record<string, string>).Authorization;
    requests.push({ url: String(url), bearer, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (String(url).includes('/profile')) return Response.json({ id: overrides.profile ?? 'personal' });
    if (String(url).includes('/execution-owner')) return Response.json({ owner: overrides.relation === undefined ? owner : overrides.relation });
    if (!String(url).includes('cursor=')) return Response.json({ sessions: [{ ...raw, id: 'unrelated', metadata: 'other' }], hasNext: true, nextCursor: 'cursor_v1_page2' });
    return Response.json({ sessions: overrides.missing ? [] : [raw], hasNext: false, nextCursor: null });
  }) as typeof fetch;
  return { requests, run: () => discoverMachineSetupTokenSession({ happyOrigin: 'https://happy.test', ownerBearer: 'original-personal', machineBearer: 'company', state, fetch: fetcher }) };
}
describe('uncertain create recovery through authenticated Happy consumers', () => {
  it('paginates as the staged owner then verifies the exact execution with the machine bearer', async () => {
    const t = setup(); expect(await t.run()).toMatchObject({ id: 'created-session' });
    expect(t.requests.slice(0, 3).every(r => r.bearer === 'Bearer original-personal')).toBe(true);
    expect(t.requests[3]).toMatchObject({ bearer: 'Bearer company', body: { companyId: 'company', machineId: 'machine', launchId: 'launch', initialNonce } });
    expect(t.requests.some(r => r.url.endsWith('/v1/sessions'))).toBe(false);
  });
  it('rejects switched/staged account identity before listing or creating anything', async () => {
    const t = setup({ profile: 'company-account' }); await expect(t.run()).rejects.toThrow('FORBIDDEN'); expect(t.requests).toHaveLength(1);
  });
  it.each([null, { ...owner, sessionOwnerAccountId: 'another-owner' }, { ...owner, launchId: 'another-launch' }, { ...owner, initialNonce: Buffer.alloc(32, 2).toString('base64url') }])('denies a missing or mismatched authenticated relation', async relation => {
    await expect(setup({ relation }).run()).rejects.toThrow('FORBIDDEN');
  });
  it('returns no session when the exact encrypted create is absent, without an unbound create fallback', async () => {
    const t = setup({ missing: true }); expect(await t.run()).toBeNull(); expect(t.requests).toHaveLength(3);
  });
});

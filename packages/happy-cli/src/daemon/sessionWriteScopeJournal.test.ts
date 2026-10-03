import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScopeJournal } from './sessionWriteScopeJournal';

describe('write scope crash recovery', () => {
  it('retains application uncertainty but never rehydrates a pending permit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scope-journal-'));
    try {
      const journal = new ScopeJournal(join(dir, 'journal.json'), 'account', 'machine');
      const descriptor = { version: 1 as const, id: 'request', digest: 'd'.repeat(64), incarnation: 'old', accountId: 'account',
        machineId: 'machine', sessionId: 'session', generation: '1', projectRoot: '/project', root: '/target',
        requestedPath: '/target', description: 'Install tool', kind: 'grant' as const, createdAt: 1, expiresAt: 2 };
      await journal.write([{ ...descriptor, state: 'pending' }, { ...descriptor, id: 'started', state: 'applying' }]);
      const recovered = await journal.recover();
      expect(recovered.map(item => item.state)).toEqual(['expired', 'cleanup-unresolved']);
      expect(recovered.every(item => item.grantActive === false)).toBe(true);
      expect(await new ScopeJournal(join(dir, 'journal.json'), 'other', 'machine').recover()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

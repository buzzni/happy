import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPersonalClaudeCredential, selectPersonalClaudeCredential } from './personalClaudeCredential'
import { groupAccountIdentity } from '@/daemon/aiCredentialGroupAdapters'
const account = { email: 'personal@example.test', organizationUuid: 'personal-org', credentials: { claudeAiOauth: { accessToken: 'fixture-personal', expiresAt: 900000 } }, config: { oauthAccount: { emailAddress: 'personal@example.test', organizationUuid: 'personal-org' } } }
const journal = { version: 1, entries: [{ provider: 'claude', desired: [], owned: [], managed: ['organization-slot'], pending: false }] }
describe('personal credential isolation', () => {
 it('selects a positively identified OAuth slot without changing the global login', () => {
  expect(selectPersonalClaudeCredential({ version: 1, encrypted: false, accounts: [account] }, journal, 1000)?.accessToken).toBe('fixture-personal')
 })
 it('rejects ambiguous, expired, managed, journal-owned and metadata-mismatched accounts', () => {
  const pick = (accounts: unknown[], j: unknown = journal) => selectPersonalClaudeCredential({ version: 1, encrypted: false, accounts }, j, 1000)
  expect(pick([account, account])).toBeNull()
  expect(pick([{ ...account, managedAccountId: 'org' }])).toBeNull()
  expect(pick([{ ...account, config: {} }])).toBeNull()
  expect(pick([{ ...account, credentials: { claudeAiOauth: { accessToken: 'fixture', expiresAt: 999 } } }])).toBeNull()
  expect(pick([account], null)).toBeNull()
  expect(pick([account], { ...journal, entries: [{ ...journal.entries[0], owned: [groupAccountIdentity('claude', account)] }] })).toBeNull()
 })
})

it('does not offer a legacy organization OAuth bundle as a personal login', () => {
 expect(selectPersonalClaudeCredential({version:1,encrypted:false,accounts:[account]},journal,1000,[[account.email,account.organizationUuid]])).toBeNull()
})

it('selects an exact personal account among multiple verified slots without guessing a default', () => {
 const second = { ...account, email: 'second@example.test', config: { oauthAccount: { emailAddress: 'second@example.test', organizationUuid: account.organizationUuid } } }
 const pool = { version: 1, encrypted: false, accounts: [account,second] }
 expect(selectPersonalClaudeCredential(pool,journal,1000)).toBeNull()
 const ref = selectPersonalClaudeCredential({...pool,accounts:[second]},journal,1000)!.accountRef
 expect(selectPersonalClaudeCredential(pool,journal,1000,[],ref)?.label).toBe('se…@example.test')
 expect(selectPersonalClaudeCredential(pool,journal,1000,[],'unknown')).toBeNull()
})

it.skipIf(process.platform === 'win32')('finds cswap in the uv tool bin when the app was not launched from a shell', async () => {
 const home = await mkdtemp(join(tmpdir(), 'personal-claude-')), saved = { HOME: process.env.HOME, PATH: process.env.PATH }
 try {
  await mkdir(join(home, '.happy'), { recursive: true }); await mkdir(join(home, '.local', 'bin'), { recursive: true })
  await writeFile(join(home, '.happy', 'ai-credential-groups.json'), JSON.stringify(journal))
  const pool = { version: 1, encrypted: false, accounts: [{ ...account, credentials: { claudeAiOauth: { accessToken: 'fixture-personal', expiresAt: Date.now() + 3_600_000 } } }] }
  await writeFile(join(home, '.local', 'bin', 'cswap'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(pool)}\nJSON\n`, { mode: 0o755 })
  process.env.HOME = home; process.env.PATH = '/usr/bin:/bin'
  expect((await readPersonalClaudeCredential())?.accessToken).toBe('fixture-personal')
 } finally {
  process.env.HOME = saved.HOME; process.env.PATH = saved.PATH
  await rm(home, { recursive: true, force: true })
 }
})

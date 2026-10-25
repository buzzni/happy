import { describe, it, expect } from 'vitest'
import { selectPersonalClaudeCredential } from './personalClaudeCredential'
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

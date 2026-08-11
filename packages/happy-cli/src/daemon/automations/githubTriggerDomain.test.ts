import { describe, expect, it } from 'vitest'

import { planGithubTrigger, renderGithubTriggerPrompt } from './githubTriggerDomain'

const trigger = {
  event: 'opened' as const,
  filter: { baseBranch: 'main', label: 'ready', excludeDraft: true, authors: ['Alice'], paths: ['apps/web'] },
  action: 'start-session' as const,
  githubCredentialId: null,
}

const pr = (patch: Record<string, unknown> = {}) => ({
  number: 10,
  title: 'Add search',
  url: 'https://github.test/o/r/pull/10',
  author: { login: 'alice' },
  baseRefName: 'main',
  headRefName: 'feature/search',
  isDraft: false,
  state: 'OPEN',
  mergedAt: null,
  labels: [{ name: 'ready' }],
  changedFiles: 1,
  files: [{ path: 'apps/web/page.tsx' }],
  ...patch,
})

describe('planGithubTrigger', () => {
  it('records the first snapshot as a baseline without firing existing pull requests', () => {
    const result = planGithubTrigger({ trigger, current: [pr()], previous: null })

    expect(result.event).toBeNull()
    expect(result.state.highestPrNumber).toBe(10)
    expect(result.state.processed).toEqual([])
  })

  it('fires one matching event once and preserves the idempotency ledger', () => {
    const baseline = planGithubTrigger({ trigger, current: [], previous: null }).state
    const opened = planGithubTrigger({ trigger, current: [pr()], previous: baseline })

    expect(opened.event).toMatchObject({ id: '10:opened', pr: { number: 10 } })
    const repeated = planGithubTrigger({ trigger, current: [pr()], previous: opened.state })
    expect(repeated.event).toBeNull()
    expect(repeated.state.processed).toContain('10:opened')
  })

  it('matches authors case-insensitively and paths only on segment boundaries', () => {
    const baseline = planGithubTrigger({ trigger, current: [], previous: null }).state

    expect(planGithubTrigger({ trigger, current: [pr()], previous: baseline }).event).not.toBeNull()
    expect(planGithubTrigger({
      trigger,
      current: [pr({ files: [{ path: 'apps/website/page.tsx' }] })],
      previous: baseline,
    }).event).toBeNull()
  })

  it('fails closed when GitHub returns only a partial changed-file list', () => {
    const baseline = planGithubTrigger({ trigger, current: [], previous: null }).state
    expect(planGithubTrigger({
      trigger,
      current: [pr({ changedFiles: 101, files: [{ path: 'apps/web/page.tsx' }] })],
      previous: baseline,
    }).event).toBeNull()
  })

  it.each([
    ['ready_for_review', pr({ isDraft: true }), pr({ isDraft: false })],
    ['merged', pr({ state: 'OPEN' }), pr({ state: 'MERGED', mergedAt: '2026-08-11T00:00:00Z' })],
    ['closed', pr({ state: 'OPEN' }), pr({ state: 'CLOSED', mergedAt: null })],
  ] as const)('derives the %s transition', (event, before, after) => {
    const eventTrigger = { ...trigger, event, filter: { ...trigger.filter, paths: [] } }
    const baseline = planGithubTrigger({ trigger: eventTrigger, current: [before], previous: null }).state
    expect(planGithubTrigger({ trigger: eventTrigger, current: [after], previous: baseline }).event?.id).toBe(`10:${event}`)
  })
})

describe('renderGithubTriggerPrompt', () => {
  it('replaces supported dot variables while leaving unknown variables intact', () => {
    expect(renderGithubTriggerPrompt('Review {pr.number} {pr.title} {event} {unknown}', pr(), 'opened'))
      .toBe('Review 10 Add search opened {unknown}')
  })

  it('flattens untrusted PR text and removes command-substitution delimiters', () => {
    expect(renderGithubTriggerPrompt('{pr.title}', pr({ title: 'Fix\n`rm -rf /`' }), 'opened'))
      .toBe("Fix 'rm -rf /'")
  })
})

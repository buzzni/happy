import { describe, expect, it } from 'vitest'

import {
  planGithubIssueTrigger,
  planGithubTrigger,
  renderGithubIssueTriggerPrompt,
  renderGithubTriggerPrompt,
} from './githubTriggerDomain'

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

  it('polls matching events into pending without consuming them', () => {
    const baseline = planGithubTrigger({ trigger, current: [], previous: null }).state
    const polled = planGithubTrigger({
      trigger,
      current: [pr(), pr({ number: 11 })],
      previous: baseline,
      consume: false,
    })

    expect(polled.event).toBeNull()
    expect(polled.state.pending.map((event) => event.id)).toEqual(['10:opened', '11:opened'])
    expect(polled.state.processed).toEqual([])
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

  it.each([
    ['merged', pr({ state: 'MERGED', mergedAt: '2026-08-11T00:00:00Z' })],
    ['closed', pr({ state: 'CLOSED', mergedAt: null })],
  ] as const)('fires %s when an old terminal PR re-enters the top-100 window', (event, terminalPr) => {
    const eventTrigger = { ...trigger, event, filter: { ...trigger.filter, paths: [] } }
    const baseline = planGithubTrigger({
      trigger: eventTrigger,
      current: [pr({ number: 20 })],
      previous: null,
    }).state

    expect(planGithubTrigger({
      trigger: eventTrigger,
      current: [pr({ number: 20 }), terminalPr],
      previous: baseline,
    }).event?.id).toBe(`10:${event}`)
  })
})

const issueTrigger = {
  event: 'issue_opened' as const,
  filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] },
  action: 'start-session' as const,
  githubCredentialId: null,
}

const issue = (patch: Record<string, unknown> = {}) => ({
  number: 12,
  title: 'Search is broken',
  url: 'https://github.test/o/r/issues/12',
  author: { login: 'alice' },
  labels: [{ name: 'bug' }],
  ...patch,
})

describe('planGithubIssueTrigger', () => {
  it('records the first observation as a baseline without firing existing issues', () => {
    const result = planGithubIssueTrigger({ trigger: issueTrigger, current: [issue()], previous: null })

    expect(result.event).toBeNull()
    expect(result.state.highestIssueNumber).toBe(12)
    expect(result.state.processed).toEqual([])
  })

  it('fires only issues above the high-water mark, once, and keeps the idempotency ledger', () => {
    const baseline = planGithubIssueTrigger({ trigger: issueTrigger, current: [issue()], previous: null }).state
    const opened = planGithubIssueTrigger({
      trigger: issueTrigger,
      current: [issue(), issue({ number: 13, title: 'New report' })],
      previous: baseline,
    })

    expect(opened.event).toMatchObject({ id: '13:issue_opened', issue: { number: 13 } })
    const repeated = planGithubIssueTrigger({
      trigger: issueTrigger,
      current: [issue(), issue({ number: 13 })],
      previous: opened.state,
    })
    expect(repeated.event).toBeNull()
    expect(repeated.state.processed).toContain('13:issue_opened')
  })

  it('treats a pre-issue-support state as a baseline instead of firing (fail-closed)', () => {
    const legacyState = { snapshot: [], highestPrNumber: 7, processed: ['7:opened'], pending: [] }
    const result = planGithubIssueTrigger({ trigger: issueTrigger, current: [issue()], previous: legacyState })

    expect(result.event).toBeNull()
    expect(result.state.highestIssueNumber).toBe(12)
    expect(result.state.highestPrNumber).toBe(7)
    expect(result.state.processed).toContain('7:opened')
  })

  it('applies only the label and authors filter subset to issues', () => {
    const filtered = {
      ...issueTrigger,
      // baseBranch/excludeDraft/paths have no issue meaning and must be ignored.
      filter: { baseBranch: 'main', label: 'bug', excludeDraft: true, authors: ['Alice'], paths: ['apps/web'] },
    }
    const baseline = planGithubIssueTrigger({ trigger: filtered, current: [], previous: null }).state

    expect(planGithubIssueTrigger({ trigger: filtered, current: [issue()], previous: baseline }).event)
      .not.toBeNull()
    expect(planGithubIssueTrigger({
      trigger: filtered,
      current: [issue({ labels: [{ name: 'docs' }] })],
      previous: baseline,
    }).event).toBeNull()
    expect(planGithubIssueTrigger({
      trigger: filtered,
      current: [issue({ author: { login: 'mallory' } })],
      previous: baseline,
    }).event).toBeNull()
  })

  it('drains matched issues one per poll through the pending queue', () => {
    const baseline = planGithubIssueTrigger({ trigger: issueTrigger, current: [], previous: null }).state
    const first = planGithubIssueTrigger({
      trigger: issueTrigger,
      current: [issue({ number: 12 }), issue({ number: 13 })],
      previous: baseline,
    })

    expect(first.event?.id).toBe('12:issue_opened')
    expect(first.state.pendingIssues).toMatchObject([{ id: '13:issue_opened' }])
    const second = planGithubIssueTrigger({ trigger: issueTrigger, current: [], previous: first.state })
    expect(second.event?.id).toBe('13:issue_opened')
    expect(second.state.pendingIssues).toEqual([])
  })
})

describe('planGithubTrigger with an issue event', () => {
  it('never derives a PR event for issue_opened (fail-closed)', () => {
    const trigger = { ...issueTrigger }
    const baseline = planGithubTrigger({ trigger, current: [], previous: null }).state

    expect(planGithubTrigger({ trigger, current: [pr()], previous: baseline }).event).toBeNull()
  })
})

describe('renderGithubIssueTriggerPrompt', () => {
  it('replaces supported issue variables while leaving unknown variables intact', () => {
    expect(renderGithubIssueTriggerPrompt(
      'Triage {issue.number} {issue.title} by {issue.author} [{issue.labels}] {issue.url} {event} {unknown}',
      issue(),
      'issue_opened',
    )).toBe('Triage 12 Search is broken by alice [bug] https://github.test/o/r/issues/12 issue_opened {unknown}')
  })

  it('flattens untrusted issue text and removes command-substitution delimiters', () => {
    expect(renderGithubIssueTriggerPrompt('{issue.title}', issue({ title: 'Fix\n`rm -rf /`' }), 'issue_opened'))
      .toBe("Fix 'rm -rf /'")
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

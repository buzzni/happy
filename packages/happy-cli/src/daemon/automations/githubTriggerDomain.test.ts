import { describe, expect, it } from 'vitest'

import {
  planGithubIssueTrigger,
  planGithubTrigger,
  renderGithubIssueTriggerPrompt,
  renderGithubTriggerPrompt,
  describeGithubTriggerBaseline,
  selectPathFilterCandidates,
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
  headRefOid: 'a'.repeat(40),
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
    expect(polled.state.pending.map((event) => event.pr.headRefOid)).toEqual([
      'a'.repeat(40), 'a'.repeat(40),
    ])
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

describe('경로 필터의 glob 접미어', () => {
  // 2026-08-31 프로덕션 — hsmoa_backend 리뷰 자동화 2개가 한 건도 돌지 않았다.
  // 경로 필터가 `projects/hsmoa_catalog/*` 처럼 저장돼 있었는데 매처는 glob 이
  // 아니라 리터럴 접두어 비교라, 9개 경로 전부가 어떤 파일과도 매칭되지 않았다.
  // UI 는 `/*` 를 경고 없이 저장했고 매칭 0건은 아무 로그도 남기지 않아,
  // "필터가 제대로 걸러냈다" 와 "필터가 고장났다" 를 구분할 수 없었다.
  const base = { number: 0, title: 't', url: 'u', author: { login: 'a' },
    baseRefName: 'main', headRefName: 'f', isDraft: false, state: 'OPEN' as const,
    mergedAt: null, labels: [], changedFiles: 0, files: [] }
  const withPaths = (paths: string[]) => ({
    event: 'opened' as const,
    filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths },
    action: 'start-session' as const, githubCredentialId: null,
  })
  const prTouching = (n: number, ...files: string[]) => ({
    ...base, number: n, changedFiles: files.length, files: files.map((path) => ({ path })),
  })
  const fires = (paths: string[], pr: ReturnType<typeof prTouching>) => planGithubTrigger({
    trigger: withPaths(paths),
    current: [pr],
    previous: { snapshot: [], highestPrNumber: pr.number - 1, processed: [], pending: [] },
  }).event !== null

  it('matches a directory written with a trailing /*', () => {
    expect(fires(['projects/hsmoa_catalog/*'],
      prTouching(21022, 'projects/hsmoa_catalog/services/service.py'))).toBe(true)
  })

  it('matches a directory written with a trailing /**', () => {
    expect(fires(['apps/web/**'], prTouching(11, 'apps/web/src/index.ts'))).toBe(true)
  })

  it('still refuses a sibling directory that merely shares a name prefix', () => {
    // `/*` 를 벗긴다고 접두어가 헐거워지면 안 된다. apps/web-legacy 는 별개 디렉터리다.
    expect(fires(['apps/web/*'], prTouching(11, 'apps/web-legacy/src/index.ts'))).toBe(false)
  })

  it('keeps matching a plain directory prefix', () => {
    expect(fires(['apps/web'], prTouching(11, 'apps/web/src/index.ts'))).toBe(true)
    expect(fires(['apps/web'], prTouching(11, 'apps/api/src/index.ts'))).toBe(false)
  })

  it('does not fire when a bare * would otherwise match everything', () => {
    // `*` 만 남은 접두어는 "모든 경로" 를 뜻하는 glob 이지만, 이 매처는 glob 을
    // 지원하지 않는다. 조용히 전체 통과시키면 필터가 없는 것과 같아진다.
    expect(fires(['*'], prTouching(11, 'anything/at/all.ts'))).toBe(false)
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

// 권한이 없으면 gh 는 오류가 아니라 빈 배열을 돌려준다. 첫 baseline 이 조용히
// 기록되면 운영자가 볼 신호가 하나도 없다.
describe('describeGithubTriggerBaseline', () => {
  it('says nothing once a baseline already exists', () => {
    expect(describeGithubTriggerBaseline({
      previous: { snapshot: [], highestPrNumber: 0, processed: [], pending: [], highestIssueNumber: 3 },
      event: 'issue_opened',
      observed: 5,
    })).toBeNull()
  })

  it('reports the observed count on the first issue observation', () => {
    const notice = describeGithubTriggerBaseline({ previous: null, event: 'issue_opened', observed: 4 })

    expect(notice).toContain('4')
    expect(notice).toContain('baseline')
  })

  it('names the execution account permission when nothing was observed', () => {
    const notice = describeGithubTriggerBaseline({ previous: null, event: 'issue_opened', observed: 0 })

    expect(notice).toContain('0')
    expect(notice!.toLowerCase()).toContain('permission')
  })

  it('treats a state written before issue support as a first issue observation', () => {
    expect(describeGithubTriggerBaseline({
      previous: { snapshot: [], highestPrNumber: 9, processed: [], pending: [] },
      event: 'issue_opened',
      observed: 0,
    })).not.toBeNull()
  })

  it('reports a pull request baseline from the absence of any previous state', () => {
    expect(describeGithubTriggerBaseline({ previous: null, event: 'opened', observed: 7 }))
      .toContain('7')
    expect(describeGithubTriggerBaseline({
      previous: { snapshot: [], highestPrNumber: 9, processed: [], pending: [] },
      event: 'opened',
      observed: 7,
    })).toBeNull()
  })
})

// files 는 이 쿼리에서 가장 비싼 필드인데(933ms → 3,506ms) 경로 검사에만 쓰인다.
// derivesEvent 는 파일을 전혀 안 보므로, 이벤트를 유발하는 PR 에만 파일을 받으면 된다.
describe('selectPathFilterCandidates', () => {
  const base = { number: 0, title: 't', url: 'u', author: { login: 'a' },
    baseRefName: 'main', headRefName: 'f', isDraft: false, state: 'OPEN' as const,
    mergedAt: null, labels: [], changedFiles: 0, files: [] }
  const pr = (n: number, over: Partial<typeof base> = {}) => ({ ...base, number: n, ...over })
  const trigger = (over: Record<string, unknown> = {}) => ({
    event: 'opened' as const,
    filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: ['api/'] },
    action: 'start-session' as const, githubCredentialId: null, ...over,
  })
  const previous = (over: Record<string, unknown> = {}) => ({
    snapshot: [], highestPrNumber: 10, processed: [], pending: [], ...over,
  })

  it('asks for nothing when the trigger has no path filter', () => {
    expect(selectPathFilterCandidates({
      trigger: trigger({ filter: { baseBranch: null, label: null, excludeDraft: false, authors: [], paths: [] } }),
      current: [pr(11)],
      previous: previous(),
    })).toEqual([])
  })

  it('asks for nothing on the first observation because nothing fires', () => {
    expect(selectPathFilterCandidates({ trigger: trigger(), current: [pr(11)], previous: null })).toEqual([])
  })

  it('asks only for pull requests that derive an event', () => {
    expect(selectPathFilterCandidates({
      trigger: trigger(),
      current: [pr(9), pr(10), pr(11), pr(12)],
      previous: previous(),
    })).toEqual([11, 12])
  })

  it('skips pull requests already processed', () => {
    expect(selectPathFilterCandidates({
      trigger: trigger(),
      current: [pr(11), pr(12)],
      previous: previous({ processed: ['11:opened'] }),
    })).toEqual([12])
  })

  it('applies the non-path filters before asking for files', () => {
    expect(selectPathFilterCandidates({
      trigger: trigger({
        filter: { baseBranch: 'release', label: null, excludeDraft: true, authors: [], paths: ['api/'] },
      }),
      current: [pr(11, { baseRefName: 'main' }), pr(12, { baseRefName: 'release' }), pr(13, { baseRefName: 'release', isDraft: true })],
      previous: previous(),
    })).toEqual([12])
  })

  it('asks for nothing on an issue trigger', () => {
    expect(selectPathFilterCandidates({
      trigger: trigger({ event: 'issue_opened' }),
      current: [pr(11)],
      previous: previous(),
    })).toEqual([])
  })
})

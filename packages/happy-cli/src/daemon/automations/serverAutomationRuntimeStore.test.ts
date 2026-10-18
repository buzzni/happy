import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createServerAutomationRuntimeStore } from './serverAutomationRuntimeStore'

describe('serverAutomationRuntimeStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'server-automation-runtime-'))
    file = path.join(dir, 'server-automation-runtime.v1.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps a spent one-time occurrence across a reload', () => {
    // 소진 기록을 파서가 버리면 재기동 뒤 편집·재개가 같은 회차를 두 번 실행한다.
    const store = createServerAutomationRuntimeStore({ filePath: file })
    store.write({
      schedules: [{ automationId: 'automation-1', generation: 2, nextRunAt: Number.MAX_SAFE_INTEGER, lastSessionId: null, spentOnceAt: 500 }],
      pendingReports: [],
    })
    expect(createServerAutomationRuntimeStore({ filePath: file }).read().schedules[0]).toMatchObject({ spentOnceAt: 500 })
  })

  it('atomically persists schedule state and pending idempotent reports as owner-only', () => {
    const store = createServerAutomationRuntimeStore({ filePath: file })
    store.write({
      schedules: [{ automationId: 'automation-1', generation: 2, nextRunAt: 100, lastSessionId: null }],
      githubTriggers: [{
        automationId: 'automation-2',
        generation: 3,
        state: {
          snapshot: [{
            number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
            baseRefName: 'main', headRefName: 'feature/search', headRefOid: 'a'.repeat(40),
            isDraft: false, state: 'OPEN', mergedAt: null,
            labels: [{ name: 'ready' }], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
          }],
          highestPrNumber: 10,
          highestIssueNumber: 12,
          processed: ['9:opened'],
          pending: [],
          pendingIssues: [{
            id: '12:issue_opened', event: 'issue_opened',
            issue: {
              number: 12, title: 'Broken search', url: 'https://github.test/o/r/issues/12',
              author: { login: 'alice' }, labels: [{ name: 'bug' }],
            },
          }],
        },
      }],
      githubIssueProgressMarkers: [{
        automationId: 'automation-2', generation: 3, sessionId: 'session-issue-12',
        issueNumber: 12, actor: 'automation-bot', repository: 'acme/app', reactionId: 321,
        cleanupRetryAt: 999,
      }],
      githubWorktrees: [{
        automationId: 'automation-2', generation: 3, runId: 'run-2',
        repositoryRoot: '/repo', worktreePath: '/managed/run-2', directory: '/managed/run-2/apps/web',
        sessionId: 'session-2', createdAt: 777,
      }],
      unreachableRetries: [{
        ownerId: 'daemon-a', automationId: 'automation-1', generation: 2, attempt: 1, retryAt: 400,
        leaseExpiresAt: 500, releasing: true,
        report: {
          runId: 'run-3', claimToken: 'claim-3', reportId: 'report-3', status: 'FAILED',
          outcome: 'ERROR', sessionId: null, detailCiphertext: null, failureCode: 'GRANT_EXCHANGE_FAILED',
        },
      }],
      pendingReports: [{
        runId: 'run-1', claimToken: 'claim-token', reportId: 'report-1', status: 'COMPLETED',
        outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null,
        notificationOnly: true,
        degradedCode: 'GRANT_MISSING', queueDepth: 2, queuePosition: 1, queueTotal: 3,
        queueEstimatedAt: 123,
      }],
    })

    const restarted = createServerAutomationRuntimeStore({ filePath: file })
    expect(restarted.read()).toEqual({
      schedules: [{ automationId: 'automation-1', generation: 2, nextRunAt: 100, lastSessionId: null }],
      githubActiveSessions: [],
      githubQueueProgress: [],
      githubIssueProgressMarkers: [{
        automationId: 'automation-2', generation: 3, sessionId: 'session-issue-12',
        issueNumber: 12, actor: 'automation-bot', repository: 'acme/app', reactionId: 321,
        cleanupRetryAt: 999,
      }],
      githubWorktrees: [{
        automationId: 'automation-2', generation: 3, runId: 'run-2',
        repositoryRoot: '/repo', worktreePath: '/managed/run-2', directory: '/managed/run-2/apps/web',
        sessionId: 'session-2', createdAt: 777,
      }],
      unreachableRetries: [{
        ownerId: 'daemon-a', automationId: 'automation-1', generation: 2, attempt: 1, retryAt: 400,
        leaseExpiresAt: 500, releasing: true,
        report: {
          runId: 'run-3', claimToken: 'claim-3', reportId: 'report-3', status: 'FAILED',
          outcome: 'ERROR', sessionId: null, detailCiphertext: null, failureCode: 'GRANT_EXCHANGE_FAILED',
        },
      }],
      githubTriggers: [{
        automationId: 'automation-2',
        generation: 3,
        state: {
          snapshot: [{
            number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
            baseRefName: 'main', headRefName: 'feature/search', headRefOid: 'a'.repeat(40),
            isDraft: false, state: 'OPEN', mergedAt: null,
            labels: [{ name: 'ready' }], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
          }],
          highestPrNumber: 10,
          highestIssueNumber: 12,
          processed: ['9:opened'],
          pending: [],
          pendingIssues: [{
            id: '12:issue_opened', event: 'issue_opened',
            issue: {
              number: 12, title: 'Broken search', url: 'https://github.test/o/r/issues/12',
              author: { login: 'alice' }, labels: [{ name: 'bug' }],
            },
          }],
        },
      }],
      pendingReports: [{
        runId: 'run-1', claimToken: 'claim-token', reportId: 'report-1', status: 'COMPLETED',
        outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null,
        notificationOnly: true,
        degradedCode: 'GRANT_MISSING', queueDepth: 2, queuePosition: 1, queueTotal: 3,
        queueEstimatedAt: 123,
      }],
    })
    expect(readdirSync(dir)).toEqual(['server-automation-runtime.v1.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

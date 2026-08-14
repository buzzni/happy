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
            baseRefName: 'main', headRefName: 'feature/search', isDraft: false, state: 'OPEN', mergedAt: null,
            labels: [{ name: 'ready' }], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
          }],
          highestPrNumber: 10,
          processed: ['9:opened'],
          pending: [],
        },
      }],
      pendingReports: [{
        runId: 'run-1', claimToken: 'claim-token', reportId: 'report-1', status: 'COMPLETED',
        outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null,
        degradedCode: 'GRANT_MISSING',
      }],
    })

    const restarted = createServerAutomationRuntimeStore({ filePath: file })
    expect(restarted.read()).toEqual({
      schedules: [{ automationId: 'automation-1', generation: 2, nextRunAt: 100, lastSessionId: null }],
      githubTriggers: [{
        automationId: 'automation-2',
        generation: 3,
        state: {
          snapshot: [{
            number: 10, title: 'Add search', url: 'https://github.test/o/r/pull/10', author: { login: 'alice' },
            baseRefName: 'main', headRefName: 'feature/search', isDraft: false, state: 'OPEN', mergedAt: null,
            labels: [{ name: 'ready' }], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
          }],
          highestPrNumber: 10,
          processed: ['9:opened'],
          pending: [],
        },
      }],
      pendingReports: [{
        runId: 'run-1', claimToken: 'claim-token', reportId: 'report-1', status: 'COMPLETED',
        outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null,
        degradedCode: 'GRANT_MISSING',
      }],
    })
    expect(readdirSync(dir)).toEqual(['server-automation-runtime.v1.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

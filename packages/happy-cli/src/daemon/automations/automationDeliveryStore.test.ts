import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createAutomationDeliveryStore } from './automationDeliveryStore'

const state = {
  version: 1 as const,
  incidents: { 'automation-1': { signature: 'TURN_FAILED', firstAt: 1, alertedAt: 2 } },
  delivered: [{ key: 'run-1:failure', at: 2 }],
  awaiting: [{ runId: 'run-2', automationId: 'automation-1', sessionId: 'session-1', at: 3 }],
}

describe('createAutomationDeliveryStore', () => {
  it('starts empty and keeps what it was given, readable only by the owner', () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'delivery-store-')), 'nested', 'automation-delivery.json')
    const store = createAutomationDeliveryStore({ filePath })
    expect(store.read()).toEqual({ version: 1, incidents: {}, delivered: [], awaiting: [] })
    store.write(state)
    expect(createAutomationDeliveryStore({ filePath }).read()).toEqual(state)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('starts over from a file it cannot read instead of stopping the daemon', () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'delivery-store-')), 'automation-delivery.json')
    for (const content of ['{', JSON.stringify({ version: 2 }), JSON.stringify({ ...state, incidents: { a: { signature: 1 } } })]) {
      writeFileSync(filePath, content)
      expect(createAutomationDeliveryStore({ filePath }).read()).toEqual({ version: 1, incidents: {}, delivered: [], awaiting: [] })
    }
    expect(readFileSync(filePath, 'utf8')).toContain('signature')
  })
})

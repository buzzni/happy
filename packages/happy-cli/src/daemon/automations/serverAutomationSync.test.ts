import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createServerAutomationCache } from './serverAutomationCache'
import { syncServerAutomationDeltas } from './serverAutomationSync'

describe('syncServerAutomationDeltas', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'server-automation-sync-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists deltas before ack and retries a durable pending ack after failure', async () => {
    const cache = createServerAutomationCache({ filePath: path.join(dir, 'cache.json') })
    const payload = Buffer.from(new Uint8Array(41).fill(1)).toString('base64')
    const envelope = Buffer.from(new Uint8Array(105).fill(1)).toString('base64')
    const sync = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: {
        serverTime: 100, nextSeq: '1', changes: [{
          seq: '1', automationId: 'automation-1', revision: 1, generation: 1, kind: 'UPSERT',
          payloadVersion: 1, payloadCiphertext: payload, machineKeyVersion: 1,
          machineKeyEnvelope: envelope, paused: false, enabledAt: 1,
        }],
      } })
      .mockResolvedValue({ ok: true, value: { serverTime: 101, nextSeq: '1', changes: [] } })
    const ack = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'offline' })
      .mockResolvedValueOnce({ ok: true, value: { acknowledged: 1 } })

    await expect(syncServerAutomationDeltas({ cache, sync, ack })).rejects.toThrow('automation-sync-ack-failed')
    expect(cache.read()).toMatchObject({
      cursor: 1n,
      pendingAcknowledgements: [{ automationId: 'automation-1', revision: 1 }],
    })

    await expect(syncServerAutomationDeltas({ cache, sync, ack })).resolves.toEqual({ cursor: 1n, changed: 0 })
    expect(sync).toHaveBeenLastCalledWith({ afterSeq: '1', limit: 500 })
    expect(ack).toHaveBeenLastCalledWith({ items: [{ automationId: 'automation-1', revision: 1 }] })
    expect(cache.read().pendingAcknowledgements).toEqual([])
  })
})

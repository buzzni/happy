import type { ServerAutomationCache } from './serverAutomationCache'

type TransportResult = { ok: boolean; value?: unknown; error?: string }

export async function syncServerAutomationDeltas(input: {
  cache: ServerAutomationCache
  sync: (request: { afterSeq: string; limit: number }) => Promise<TransportResult>
  ack: (request: { items: Array<{ automationId: string; revision: number }> }) => Promise<TransportResult>
}): Promise<{ cursor: bigint; changed: number }> {
  const limit = 500
  let changed = 0

  while (true) {
    const before = input.cache.read().cursor
    const response = await input.sync({ afterSeq: before.toString(), limit })
    if (!response.ok || response.value === undefined) {
      throw new Error(`automation-sync-failed:${response.error ?? 'invalid-response'}`)
    }
    const applied = input.cache.applySync(response.value)
    const changes = (response.value as { changes: unknown[] }).changes
    changed += changes.length

    if (applied.acknowledgements.length > 0) {
      const acknowledged = await input.ack({ items: applied.acknowledgements })
      if (!acknowledged.ok) throw new Error(`automation-sync-ack-failed:${acknowledged.error ?? 'invalid-response'}`)
      input.cache.markAcknowledged(applied.acknowledgements)
    }

    if (changes.length < limit || applied.nextSeq === before) {
      return { cursor: applied.nextSeq, changed }
    }
  }
}

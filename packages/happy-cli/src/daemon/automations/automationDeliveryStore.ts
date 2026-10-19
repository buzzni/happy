/**
 * The delivery ledger on disk (Saycode specs/_archive/automation-result-delivery — plan D2·D7).
 *
 * Its own file rather than a field of the automation runtime state: an older daemon parses that
 * state strictly, and a field it does not know must never be a reason for it to drop the reports
 * it still owes the server. What is kept here is ids, closed codes and times — never a task name,
 * an answer or a target (`automationDelivery.ts`).
 *
 * A file that does not parse is read as empty and left as it is until the next write: losing the
 * ledger costs one repeated alert at most, while refusing to start would cost the whole daemon.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import * as z from 'zod'

import type { AutomationDeliveryState, AutomationDeliveryStore } from './automationDelivery'

const id = z.string().min(1).max(200)
const time = z.number().int().min(0)

const stateSchema = z.object({
  version: z.literal(1),
  incidents: z.record(id, z.object({ signature: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), firstAt: time, alertedAt: time })),
  delivered: z.array(z.object({ key: z.string().min(1).max(260), at: time })).max(1_000),
  awaiting: z.array(z.object({ runId: id, automationId: id, sessionId: id, at: time })).max(1_000),
})

const empty = (): AutomationDeliveryState => ({ version: 1, incidents: {}, delivered: [], awaiting: [] })

export function createAutomationDeliveryStore(options: { filePath: string }): AutomationDeliveryStore {
  return {
    read() {
      try {
        const parsed = stateSchema.safeParse(JSON.parse(readFileSync(options.filePath, 'utf8')))
        return parsed.success ? parsed.data : empty()
      } catch {
        return empty()
      }
    },
    write(state) {
      const validated = stateSchema.parse(state)
      mkdirSync(path.dirname(options.filePath), { recursive: true })
      const tmp = `${options.filePath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, JSON.stringify(validated), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, options.filePath)
      chmodSync(options.filePath, 0o600)
    },
  }
}

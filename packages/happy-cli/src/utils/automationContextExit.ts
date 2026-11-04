import { z } from 'zod'
import { isAutomationExecutionSessionId } from '@slopus/happy-wire'
import { logger } from '@/ui/logger'
import type { ChildProcess } from 'node:child_process'

const evidenceSchema = z.strictObject({ providerExitedCleanly: z.boolean(), foregroundDrained: z.boolean(),
  backgroundDrained: z.boolean(), writeProducersDrained: z.boolean() })
export type AutomationContextExitEvidence = z.infer<typeof evidenceSchema>
export type NativeAutomationContextExitEvidence = Omit<AutomationContextExitEvidence, 'writeProducersDrained'>
export const automationContextExitMessageSchema = z.strictObject({ type: z.literal('automation-context-exit'), version: z.literal(1),
  sessionId: z.string().regex(/^automation-run:[A-Za-z0-9_-]{1,160}$/), provider: z.enum(['claude', 'codex']), evidence: evidenceSchema })
type ExitMessage = z.infer<typeof automationContextExitMessageSchema>
type Transport = { connected: boolean; send?: (message: ExitMessage, done: (error: Error | null) => void) => unknown }

/** Only an owned child IPC channel may carry this receipt. Delivery is not a durable parent ACK or model completion. */
export async function reportAutomationContextExit(input: Omit<ExitMessage, 'type' | 'version'>, transport?: Transport): Promise<boolean> {
  if (!isAutomationExecutionSessionId(input.sessionId)) return false
  const message = automationContextExitMessageSchema.parse({ ...input, type: 'automation-context-exit', version: 1 })
  const channel = transport ?? { connected: process.connected === true,
    send: process.send ? (value: ExitMessage, done: (error: Error | null) => void) => process.send!(value, done) : undefined }
  if (!channel.connected || !channel.send) { logger.warn('[automation-context] Owned exit IPC unavailable'); return false }
  return new Promise(resolve => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined
    const finish = (confirmed: boolean) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (!confirmed) logger.warn('[automation-context] Owned exit IPC delivery unconfirmed')
      resolve(confirmed)
    }
    timer = setTimeout(() => finish(false), 2_000)
    try { channel.send!(message, error => finish(!error)) } catch { finish(false) }
  })
}

/** Attach immediately to the owned spawn. Neither an IPC packet nor root PID disappearance alone is sufficient.
 * The caller may release workspace ownership only after this promise confirms the receipt is durable. */
export function observeAutomationContextChild(input: {
  child: ChildProcess; sessionId: string; provider: 'claude' | 'codex'; persist(): Promise<void>
}): Promise<boolean> {
  automationContextExitMessageSchema.pick({ sessionId: true, provider: true }).parse({ sessionId: input.sessionId, provider: input.provider })
  const { child } = input
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false)
  return new Promise(resolve => {
    let received = false, conflicted = false
    const onMessage = (raw: unknown) => {
      if ((raw as { type?: unknown } | null)?.type !== 'automation-context-exit') return
      const result = automationContextExitMessageSchema.safeParse(raw)
      if (!result.success || result.data.sessionId !== input.sessionId || result.data.provider !== input.provider
        || !Object.values(result.data.evidence).every(value => value === true)) conflicted = true
      else received = true
    }
    const onError = () => { conflicted = true }
    child.on('message', onMessage); child.on('error', onError)
    child.once('close', (code, signal) => {
      child.off('message', onMessage); child.off('error', onError)
      if (!received || conflicted || code !== 0 || signal !== null || child.killed) { resolve(false); return }
      void Promise.resolve().then(() => input.persist()).then(() => resolve(true), () => {
        logger.warn('[automation-context] Owned exit receipt persistence unconfirmed')
        resolve(false)
      })
    })
  })
}

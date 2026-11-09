/**
 * Keeps an organization LLM endpoint session's start report from being lost (aplus specs/org-llm-endpoints r3).
 *
 * Studio turns the prepared binding into a started one only when the daemon says the session exists; the report is
 * best effort and can fail (Studio rolling out, a token boundary, a restart of this daemon mid-request). A lost report
 * used to leave the binding `prepared` for good: every resume was then refused and the usage never attributed.
 *
 * So the report is recorded as pending in the session's persisted record *before* it is sent, cleared only when
 * Studio's documented answer comes back, and sent again before a resume asks Studio whether it may go on.
 * The pending marker lives in the record's agent environment (`ORG_ENDPOINT_UNREPORTED_ENV`), which every writer of
 * that record already carries, so it survives a daemon restart.
 */
import { ORG_ENDPOINT_UNREPORTED_ENV } from '@/utils/childEnv'
import type { SaycodeAgentEnvironment } from './sessionEnv'

export type OrgEndpointStartTarget = { bindingId: string; targetId: string }

export type OrgEndpointStartReporterDeps = {
  /** The Studio call (`reportSessionStarted`); ok only for Studio's documented answer. */
  send(report: { bindingId: string; sessionId: string; targetId: string }): Promise<{ ok: boolean }>
  /** The session's persisted agent environment, undefined when there is no record. */
  readEnvironment(sessionId: string): SaycodeAgentEnvironment | undefined
  /** Replaces it, in the persisted record and in the tracked session. */
  writeEnvironment(sessionId: string, environment: SaycodeAgentEnvironment): void
  warn(message: string): void
}

export function createOrgEndpointStartReporter(deps: OrgEndpointStartReporterDeps) {
  const inFlight = new Map<string, Promise<boolean>>()

  /** A record that cannot be written costs only the durability, never the report itself. */
  function setPending(sessionId: string, pending: boolean): void {
    try {
      const current = deps.readEnvironment(sessionId)
      if (!current) return
      const { [ORG_ENDPOINT_UNREPORTED_ENV]: _previous, ...rest } = current
      deps.writeEnvironment(sessionId, pending ? { ...rest, [ORG_ENDPOINT_UNREPORTED_ENV]: '1' } : rest)
    } catch {
      deps.warn(`org-llm-endpoint start report could not ${pending ? 'be marked pending in' : 'be cleared from'} the session record`)
    }
  }

  async function deliver(sessionId: string, target: OrgEndpointStartTarget): Promise<boolean> {
    try {
      const answer = await deps.send({ bindingId: target.bindingId, sessionId, targetId: target.targetId })
      if (!answer.ok) return false
      setPending(sessionId, false)
      return true
    } catch {
      // Never the error's text: it can carry an address or the token this call authenticates with.
      deps.warn('org-llm-endpoint session-started report threw; it stays pending')
      return false
    }
  }

  /** One send per session at a time: a resume that arrives while the spawn's report is out waits for that answer. */
  function once(sessionId: string, run: () => Promise<boolean>): Promise<boolean> {
    const running = inFlight.get(sessionId)
    if (running) return running
    const started = run().finally(() => { inFlight.delete(sessionId) })
    inFlight.set(sessionId, started)
    return started
  }

  return {
    /** After a spawn succeeded: mark pending, send, clear on Studio's answer. True when Studio has it. */
    reportAfterSpawn(sessionId: string, target: OrgEndpointStartTarget): Promise<boolean> {
      return once(sessionId, async () => {
        setPending(sessionId, true)
        return deliver(sessionId, target)
      })
    },
    /** Before a resume's Studio check: send again if the record says the report never landed. True when nothing is pending. */
    resendIfPending(sessionId: string, target: OrgEndpointStartTarget): Promise<boolean> {
      const running = inFlight.get(sessionId)
      if (running) return running
      if (deps.readEnvironment(sessionId)?.[ORG_ENDPOINT_UNREPORTED_ENV] !== '1') return Promise.resolve(true)
      return once(sessionId, () => deliver(sessionId, target))
    },
  }
}

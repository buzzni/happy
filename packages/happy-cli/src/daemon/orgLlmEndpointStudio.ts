/**
 * The daemon's two calls to Studio about organization LLM endpoint sessions (aplus specs/org-llm-endpoints r2),
 * authenticated by the daemon's own happy token like its other Studio calls (`setupTokenAccountSwitch`):
 *
 *  - `session-started`: the session now exists, so Studio can turn the prepared binding into a started one.
 *    Never part of the spawn's outcome — a failure is logged and the session runs.
 *  - `resume-check`: before a resume rebuilds an endpoint's environment from the local copy, Studio says whether the
 *    binding is still valid (endpoint active, same generation, target there, user still assigned). Anything but a 200
 *    refuses the resume: the local copy alone can be older than the administrator's last change.
 *
 * Nothing in a log, an error or a result here carries the token, an address or a response body.
 */
import { failureReason } from './orgLlmEndpoint'

const REQUEST_TIMEOUT_MS = 10_000
/** Studio's answers are a status and a few bytes; anything more is not read. */
const RESPONSE_READ_LIMIT = 4 * 1024
const STARTED_RETRY_DELAYS_MS = [500, 2_000]
const RESUME_RETRY_DELAY_MS = 1_000

export type OrgLlmEndpointSessionStarted = { bindingId: string; sessionId: string; targetId: string }
export type OrgLlmEndpointResumeQuery = { bindingId: string; sessionId: string; endpointId: string; targetId: string; generation: number }
export type OrgLlmEndpointResumeVerdict = { ok: true } | { ok: false; reason: 'STUDIO_UNCONFIGURED' | 'REFUSED' | 'UNREACHABLE' }

export type OrgLlmEndpointStudioDeps = {
  /** The daemon's trusted Studio origin (`readTrustedStudioOrigin`); null when not configured. */
  studioOrigin: string | null
  bearer(): string
  fetch(url: string, init: RequestInit): Promise<Response>
  warn(message: string): void
  sleep?(ms: number): Promise<void>
}

type Attempt = { status: number } | { failure: string }

export function createOrgLlmEndpointStudioClient(deps: OrgLlmEndpointStudioDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function post(route: string, body: object): Promise<Attempt> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    try {
      const response = await deps.fetch(`${deps.studioOrigin}/api/org-llm-endpoints/daemon/${route}`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${deps.bearer()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await discardBody(response, signal)
      return { status: response.status }
    } catch (error) {
      return { failure: failureReason(error) }
    }
  }

  /** A transient problem is worth another try; an answer that says no is not. */
  const transient = (attempt: Attempt): boolean => 'failure' in attempt || attempt.status >= 500 || attempt.status === 429
  const describe = (attempt: Attempt): string => 'failure' in attempt ? attempt.failure : `status ${attempt.status}`

  async function reportSessionStarted(report: OrgLlmEndpointSessionStarted): Promise<{ ok: boolean }> {
    if (!deps.studioOrigin) {
      deps.warn('org-llm-endpoint session-started report skipped: no trusted Studio origin is configured')
      return { ok: false }
    }
    let attempt: Attempt = { failure: 'none' }
    for (let tries = 0; tries <= STARTED_RETRY_DELAYS_MS.length; tries++) {
      if (tries > 0) await sleep(STARTED_RETRY_DELAYS_MS[tries - 1]!)
      attempt = await post('session-started', report)
      if ('status' in attempt && attempt.status >= 200 && attempt.status < 300) return { ok: true }
      if (!transient(attempt)) break
    }
    deps.warn(`org-llm-endpoint session-started report failed (${describe(attempt)}); the session keeps running`)
    return { ok: false }
  }

  async function checkResume(query: OrgLlmEndpointResumeQuery): Promise<OrgLlmEndpointResumeVerdict> {
    if (!deps.studioOrigin) {
      deps.warn('org-llm-endpoint resume refused: no trusted Studio origin is configured to confirm the binding')
      return { ok: false, reason: 'STUDIO_UNCONFIGURED' }
    }
    let attempt = await post('resume-check', query)
    if (transient(attempt)) {
      await sleep(RESUME_RETRY_DELAY_MS)
      attempt = await post('resume-check', query)
    }
    if ('status' in attempt && attempt.status === 200) return { ok: true }
    const unreachable = transient(attempt)
    deps.warn(`org-llm-endpoint resume-check ${unreachable ? 'unreachable' : 'refused'} (${describe(attempt)}); the session is not resumed`)
    return { ok: false, reason: unreachable ? 'UNREACHABLE' : 'REFUSED' }
  }

  return { reportSessionStarted, checkResume }
}

/** Reads a little of the answer so the connection can be reused, then lets go; the timeout covers a stalled body. */
async function discardBody(response: Response, signal: AbortSignal): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  const expired = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('response timeout')), { once: true })
  })
  try {
    let read = 0
    while (read < RESPONSE_READ_LIMIT) {
      const chunk = await Promise.race([reader.read(), expired])
      if (chunk.done) break
      read += chunk.value.byteLength
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * The daemon's two calls to Studio about organization LLM endpoint sessions (aplus specs/org-llm-endpoints r2),
 * authenticated by the daemon's own happy token like its other Studio calls (`setupTokenAccountSwitch`):
 *
 *  - `session-started`: the session now exists, so Studio can turn the prepared binding into a started one.
 *    Never part of the spawn's outcome — a failure is logged and the session runs. Reported only when Studio answers
 *    `{ok:true, bindingId, status:'started'}` for this binding.
 *  - `resume-check`: before a resume rebuilds an endpoint's environment from the local copy, Studio says whether the
 *    binding is still valid (endpoint active, same generation, target there, user still assigned). Only a 200 with
 *    `{ok:true}` lets the resume go: the local copy alone can be older than the administrator's last change, and a
 *    2xx page from a proxy or a misrouted deployment says nothing about the binding.
 *
 * The answer is read up to a small limit and parsed as JSON. Nothing in a log, an error or a result here carries the
 * token, an address or a response body.
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

type Attempt = { status: number; body: unknown } | { failure: string }
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

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
      return { status: response.status, body: await readJsonBody(response, signal) }
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
      if ('status' in attempt && attempt.status >= 200 && attempt.status < 300) {
        if (isStartedAnswer(attempt.body, report.bindingId)) return { ok: true }
        // A 2xx that is not Studio's documented answer (a proxy page, another route) is not a report that landed.
        deps.warn('org-llm-endpoint session-started report got an unexpected answer; it stays unreported')
        return { ok: false }
      }
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
    if ('status' in attempt && attempt.status === 200) {
      if (isObject(attempt.body) && attempt.body.ok === true) return { ok: true }
      deps.warn('org-llm-endpoint resume-check got an unexpected answer; the session is not resumed')
      return { ok: false, reason: 'REFUSED' }
    }
    const unreachable = transient(attempt)
    deps.warn(`org-llm-endpoint resume-check ${unreachable ? 'unreachable' : 'refused'} (${describe(attempt)}); the session is not resumed`)
    return { ok: false, reason: unreachable ? 'UNREACHABLE' : 'REFUSED' }
  }

  return { reportSessionStarted, checkResume }
}

const isStartedAnswer = (body: unknown, bindingId: string): boolean =>
  isObject(body) && body.ok === true && body.bindingId === bindingId && body.status === 'started'

/**
 * The answer as JSON, or undefined when it is not readable: larger than the limit, not JSON, stalled past the timeout.
 * Whatever is left unread is cancelled so the connection can be released.
 */
async function readJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const expired = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('response timeout')), { once: true })
  })
  const chunks: Uint8Array[] = []
  let read = 0
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), expired])
      if (chunk.done) break
      read += chunk.value.byteLength
      if (read > RESPONSE_READ_LIMIT) return undefined
      chunks.push(chunk.value)
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
  } catch {
    return undefined
  }
}

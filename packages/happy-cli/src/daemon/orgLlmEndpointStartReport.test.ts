import { describe, expect, it, vi } from 'vitest'
import { ORG_ENDPOINT_UNREPORTED_ENV } from '@/utils/childEnv'
import { createOrgEndpointStartReporter } from './orgLlmEndpointStartReport'
import type { SaycodeAgentEnvironment } from './sessionEnv'

// aplus specs/org-llm-endpoints r3 — a start report lost to a restart or an outage must not strand the session.

const SESSION = 'session-1'
const target = { bindingId: 'binding-1', targetId: 'target-a' }
const BINDING = 'binding-1:endpoint-1:target-a:3'

function setup(sends: Array<boolean | Error> = [true], initial: SaycodeAgentEnvironment | undefined = { HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING: BINDING }) {
  let environment = initial
  const trace: string[] = []
  const queue = [...sends]
  const send = vi.fn(async (report: { bindingId: string; sessionId: string; targetId: string }) => {
    trace.push(`send:${environment?.[ORG_ENDPOINT_UNREPORTED_ENV] === '1' ? 'pending' : 'clear'}`)
    const next = queue.shift() ?? true
    if (next instanceof Error) throw next
    return { ok: next, report }
  })
  const warn = vi.fn()
  const reporter = createOrgEndpointStartReporter({
    send: async (report) => { const result = await send(report); return { ok: result.ok } },
    readEnvironment: (id) => id === SESSION ? environment : undefined,
    writeEnvironment: (id, next) => { if (id === SESSION) { environment = next; trace.push(`write:${next[ORG_ENDPOINT_UNREPORTED_ENV] === '1' ? 'pending' : 'clear'}`) } },
    warn,
  })
  return { reporter, send, warn, trace, environment: () => environment }
}

describe('reporting a started session', () => {
  it('records the report as pending before it is sent, and clears it once Studio took it', async () => {
    const { reporter, trace, environment } = setup([true])
    await expect(reporter.reportAfterSpawn(SESSION, target)).resolves.toBe(true)
    expect(trace).toEqual(['write:pending', 'send:pending', 'write:clear'])
    expect(environment()).toEqual({ HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING: BINDING })
  })

  it('sends the binding, the session and the target', async () => {
    const { reporter, send } = setup([true])
    await reporter.reportAfterSpawn(SESSION, target)
    expect(send).toHaveBeenCalledWith({ bindingId: 'binding-1', sessionId: SESSION, targetId: 'target-a' })
  })

  it('leaves the report pending in the record when the send fails, however it fails', async () => {
    for (const failure of [false, new Error('connect ECONNREFUSED https://studio.example.test daemon-token-SECRET')] as const) {
      const { reporter, trace, environment, warn } = setup([failure])
      await expect(reporter.reportAfterSpawn(SESSION, target)).resolves.toBe(false)
      expect(trace).toEqual(['write:pending', 'send:pending'])
      expect(environment()).toMatchObject({ [ORG_ENDPOINT_UNREPORTED_ENV]: '1', HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING: BINDING })
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|studio\.example/)
    }
  })

  it('still sends when the session has no record to mark', async () => {
    const { reporter, send } = setup([true], undefined)
    await expect(reporter.reportAfterSpawn(SESSION, target)).resolves.toBe(true)
    expect(send).toHaveBeenCalledOnce()
  })
})

describe('sending it again before a resume', () => {
  it('sends a pending report again and clears it on success', async () => {
    const { reporter, send, environment } = setup([false, true])
    await reporter.reportAfterSpawn(SESSION, target)
    await expect(reporter.resendIfPending(SESSION, target)).resolves.toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(environment()).not.toHaveProperty(ORG_ENDPOINT_UNREPORTED_ENV)
  })

  it('keeps it pending, and says it is, when the second send fails too', async () => {
    const { reporter, environment } = setup([false, false])
    await reporter.reportAfterSpawn(SESSION, target)
    await expect(reporter.resendIfPending(SESSION, target)).resolves.toBe(false)
    expect(environment()).toMatchObject({ [ORG_ENDPOINT_UNREPORTED_ENV]: '1' })
  })

  it('sends nothing for a session whose report was delivered, or that never had one pending', async () => {
    const { reporter, send } = setup([true])
    await reporter.reportAfterSpawn(SESSION, target)
    send.mockClear()
    await expect(reporter.resendIfPending(SESSION, target)).resolves.toBe(true)
    expect(send).not.toHaveBeenCalled()
    const fresh = setup([true])
    await expect(fresh.reporter.resendIfPending(SESSION, target)).resolves.toBe(true)
    expect(fresh.send).not.toHaveBeenCalled()
    await expect(fresh.reporter.resendIfPending('unknown-session', target)).resolves.toBe(true)
    expect(fresh.send).not.toHaveBeenCalled()
  })

  it('sends a pending report found in a record written by an earlier daemon', async () => {
    const { reporter, send, environment } = setup([true], { HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING: BINDING, [ORG_ENDPOINT_UNREPORTED_ENV]: '1' })
    await expect(reporter.resendIfPending(SESSION, target)).resolves.toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(environment()).not.toHaveProperty(ORG_ENDPOINT_UNREPORTED_ENV)
  })

  it('does not send twice when the spawn report is still in flight as the resume asks', async () => {
    let release!: (ok: boolean) => void
    const gate = new Promise<boolean>((resolve) => { release = resolve })
    let environment: SaycodeAgentEnvironment | undefined = { HAPPY_AI_AUTH_ORG_ENDPOINT_BINDING: BINDING }
    const send = vi.fn(() => gate.then((ok) => ({ ok })))
    const reporter = createOrgEndpointStartReporter({ send, readEnvironment: () => environment, writeEnvironment: (_id, next) => { environment = next }, warn: vi.fn() })
    const first = reporter.reportAfterSpawn(SESSION, target)
    const second = reporter.resendIfPending(SESSION, target)
    release(true)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(send).toHaveBeenCalledOnce()
  })
})

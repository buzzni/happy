import { describe, expect, it, vi } from 'vitest'
import { createCollectorSchedule } from './collectorSchedule'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const permit = (managedAccountId: string) => ({ version: 1, grant: 'g', permitId: `permit-${managedAccountId}`, companyId: 'org-a', managedAccountId,
  userId: 'user-a', principalType: 'user', machineId: 'pc-a', credentialGeneration: 1, policyRevision: 2 })
const reading = { source: 'inference_probe', observedAt: 1, windows: [], coverage: 'unknown', reason: 'ok', retryAt: null }

function setup(answers: { due?: unknown; reserve?: (body: Record<string, unknown>) => Response } = {}) {
  const requests: Array<{ path: string; body: Record<string, unknown>; authorization: string | null }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).split('/daemon/')[1]
    const body = JSON.parse(String(init?.body))
    requests.push({ path, body, authorization: new Headers(init?.headers).get('authorization') })
    if (path === 'collect/due') return Response.json(answers.due ?? { version: 1, accounts: [
      { managedAccountId: A, credentialGeneration: 1, policyRevision: 2 }, { managedAccountId: B, credentialGeneration: 1, policyRevision: 2 }] })
    if (path === 'collect/reserve') return answers.reserve?.(body) ?? Response.json(permit(String(body.managedAccountId)))
    return Response.json({ version: 1, published: true })
  }) as unknown as typeof globalThis.fetch
  const measure = vi.fn(async () => reading as Record<string, unknown> | null)
  const schedule = createCollectorSchedule({ studioOrigin: 'https://studio.test', machineId: 'pc-a', bearer: () => 'machine-token', fetch, measure })
  return { schedule, requests, measure, fetch }
}

describe('collector schedule (Saycode specs/setup-token-switch-usage-check Phase 5)', () => {
  it('measures every account Studio says is due on this machine and publishes each reading', async () => {
    const { schedule, requests, measure } = setup()
    await schedule.tick()
    expect(requests.map(request => [request.path, request.body.managedAccountId ?? null])).toEqual([
      ['collect/due', null],
      ['collect/reserve', A], ['collect/publish', A],
      ['collect/reserve', B], ['collect/publish', B],
    ])
    expect(requests[0]).toEqual({ path: 'collect/due', body: { machineId: 'pc-a' }, authorization: 'Bearer machine-token' })
    expect(requests[1].body).toEqual({ machineId: 'pc-a', managedAccountId: A, credentialGeneration: 1, policyRevision: 2 })
    expect(requests[2].body).toEqual({ machineId: 'pc-a', managedAccountId: A, credentialGeneration: 1, policyRevision: 2, permitId: `permit-${A}`, observation: reading })
    expect(measure).toHaveBeenCalledWith({ companyId: 'org-a', machineId: 'pc-a', managedAccountId: A, credentialGeneration: 1, permit: permit(A) })
  })

  it('moves on to the next account when one cannot be reserved or measured', async () => {
    const { schedule, requests, measure } = setup({ reserve: body => body.managedAccountId === A ? Response.json({ error: 'SETUP_TOKEN_DAEMON_INTERVAL' }, { status: 429 }) : Response.json(permit(B)) })
    measure.mockResolvedValueOnce(null)
    await schedule.tick()
    expect(requests.map(request => request.path)).toEqual(['collect/due', 'collect/reserve', 'collect/reserve'])
  })

  it('runs one cycle at a time', async () => {
    const { schedule, requests } = setup()
    await Promise.all([schedule.tick(), schedule.tick()])
    expect(requests.filter(request => request.path === 'collect/due')).toHaveLength(1)
  })

  it('does nothing without a trusted Studio origin, and survives an unreadable answer', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    await createCollectorSchedule({ studioOrigin: null, machineId: 'pc-a', bearer: () => 't', fetch, measure: vi.fn() }).tick()
    expect(fetch).not.toHaveBeenCalled()
    const broken = setup({ due: { version: 1, accounts: 'not a list' } })
    await expect(broken.schedule.tick()).resolves.toBeUndefined()
    expect(broken.requests).toHaveLength(1)
  })
})

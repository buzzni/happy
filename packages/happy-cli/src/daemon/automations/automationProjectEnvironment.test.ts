import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAutomationProjectEnvironment } from './automationProjectEnvironment'

const input = {
  configUrl: 'https://studio.test/api/mcp-config', machineToken: 'machine-token',
  machineId: 'M-1', runId: 'R-1', claimToken: 'claim-token',
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchAutomationProjectEnvironment', () => {
  it.each([{ PROJECT_SECRET: 'value', GROUP_ONLY: 'group' }, {}])('forwards the claim and accepts the environment map %j', async (environmentVariables) => {
    const request = vi.fn(async () => new Response(JSON.stringify({ projectId: 'P-1', environmentVariables })))
    vi.stubGlobal('fetch', request)
    await expect(fetchAutomationProjectEnvironment(input)).resolves.toEqual({ ok: true, environmentVariables })
    expect(request).toHaveBeenCalledWith('https://studio.test/api/automation/project-environment', expect.objectContaining({
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer machine-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: 'M-1', runId: 'R-1', claimToken: 'claim-token' }),
    }))
  })

  it.each([
    { projectId: 'P-1' }, { projectId: 'P-1', environmentVariables: [] },
    { projectId: 'P-1', environmentVariables: { BAD: 42 } },
    { projectId: 'P-1', environmentVariables: { 'BAD=KEY': 'value' } },
    { projectId: 'P-1', environmentVariables: { BAD: 'null\u0000byte' } },
    { environmentVariables: { SECRET: 'value' } },
  ])('fails closed on invalid response %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
    await expect(fetchAutomationProjectEnvironment(input)).resolves.toEqual({ ok: false, error: 'invalid project environment response' })
  })

  it.each([401, 403, 404, 503])('does not expose response bodies on HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('sensitive-detail', { status })))
    await expect(fetchAutomationProjectEnvironment(input)).resolves.toEqual({ ok: false, error: `project environment request returned ${status}` })
  })

  it('preserves the execution-unbound signal without exposing unrelated response details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'AUTOMATION_EXECUTION_UNBOUND',
      projectId: 'P-1',
      automationId: 'A-1',
      detail: 'sensitive-detail',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })))

    await expect(fetchAutomationProjectEnvironment(input)).resolves.toEqual({
      ok: false,
      error: 'project environment execution principal is unbound',
      code: 'EXECUTION_PRINCIPAL_UNBOUND',
    })
  })

  it('fails on absent configuration or network errors instead of returning an empty environment', async () => {
    const request = vi.fn(async () => { throw new Error('sensitive-detail') })
    vi.stubGlobal('fetch', request)
    expect((await fetchAutomationProjectEnvironment({ ...input, configUrl: undefined })).ok).toBe(false)
    expect(request).not.toHaveBeenCalled()
    await expect(fetchAutomationProjectEnvironment(input)).resolves.toEqual({ ok: false, error: 'project environment request failed' })
  })
})

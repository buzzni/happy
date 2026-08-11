import { describe, expect, it, vi } from 'vitest'

import { queryGithubPullRequests } from './queryGithubPullRequests'
import type { RunAutomationScriptInput, RunAutomationScriptResult } from './runAutomationScript'

const rows = [{
  number: 10, title: 'Add search', url: 'https://github.com/acme/app/pull/10', author: { login: 'alice' },
  baseRefName: 'main', headRefName: 'feature/search', isDraft: false, state: 'OPEN', mergedAt: null,
  labels: [{ name: 'ready' }], changedFiles: 1, files: [{ path: 'apps/web/page.tsx' }],
}]

function baseInput() {
  const fetchImpl = vi.fn<typeof fetch>()
  const runScript = vi.fn(async (_input: RunAutomationScriptInput): Promise<RunAutomationScriptResult> => ({
    ok: true,
    stdout: JSON.stringify(rows),
  }))
  return {
    configUrl: 'https://studio.test',
    machineToken: 'machine-token',
    machineId: 'machine-1',
    runId: 'run-1',
    claimToken: 'claim-token',
    githubCredentialId: null as string | null,
    cwd: '/repo',
    allowedRoot: '/repo',
    fetchImpl,
    runScript,
  }
}

describe('queryGithubPullRequests', () => {
  it('uses the project machine gh account when no credential is selected', async () => {
    const input = baseInput()

    await expect(queryGithubPullRequests(input)).resolves.toEqual({ ok: true, pullRequests: rows })
    expect(input.fetchImpl).not.toHaveBeenCalled()
    expect(input.runScript).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      command: expect.stringMatching(/gh pr list .*--search "sort:updated-desc"/),
      environmentVariables: undefined,
    }))
  })

  it('exchanges a named credential for the run and keeps the token out of the command', async () => {
    const input = baseInput()
    input.githubCredentialId = 'credential-1'
    input.fetchImpl.mockResolvedValue(new Response(JSON.stringify({
      token: 'short-lived-token',
      repository: 'acme/app',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: true,
      pullRequests: rows,
      githubEnvironment: { GH_TOKEN: 'short-lived-token', GH_REPO: 'acme/app' },
    })
    expect(input.fetchImpl).toHaveBeenCalledWith(
      'https://studio.test/api/automation/github-credential',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer machine-token' }),
        body: JSON.stringify({
          machineId: 'machine-1', runId: 'run-1', claimToken: 'claim-token', credentialId: 'credential-1',
        }),
      }),
    )
    const command = input.runScript.mock.calls[0]![0].command
    expect(command).not.toContain('short-lived-token')
    expect(input.runScript).toHaveBeenCalledWith(expect.objectContaining({
      environmentVariables: { GH_TOKEN: 'short-lived-token', GH_REPO: 'acme/app' },
    }))
  })

  it('fails closed when credential exchange omits the validated repository scope', async () => {
    const input = baseInput()
    input.githubCredentialId = 'credential-1'
    input.fetchImpl.mockResolvedValue(new Response(JSON.stringify({ token: 'short-lived-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub credential exchange returned invalid data',
    })
    expect(input.runScript).not.toHaveBeenCalled()
  })

  it('fails closed without running gh when a named credential cannot be exchanged', async () => {
    const input = baseInput()
    input.githubCredentialId = 'credential-1'
    input.fetchImpl.mockResolvedValue(new Response('{}', { status: 403 }))

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub credential exchange returned 403',
    })
    expect(input.runScript).not.toHaveBeenCalled()
  })

  it('rejects malformed gh output instead of advancing the trigger baseline', async () => {
    const input = baseInput()
    input.runScript.mockResolvedValue({ ok: true, stdout: '{not-json' })

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub query returned invalid data',
    })
  })
})

import { describe, expect, it, vi } from 'vitest'

import { queryGithubIssues } from './queryGithubIssues'
import type { RunAutomationScriptInput, RunAutomationScriptResult } from './runAutomationScript'

const rows = [{
  number: 12,
  title: 'Search is broken',
  url: 'https://github.com/acme/app/issues/12',
  author: { login: 'alice' },
  labels: [{ name: 'bug' }],
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

describe('queryGithubIssues', () => {
  it('lists open issues sorted by creation with the project machine gh account', async () => {
    const input = baseInput()

    await expect(queryGithubIssues(input)).resolves.toEqual({ ok: true, issues: rows })
    expect(input.fetchImpl).not.toHaveBeenCalled()
    expect(input.runScript).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      command: expect.stringMatching(/gh issue list --state open .*--search "sort:created-desc"/),
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

    await expect(queryGithubIssues(input)).resolves.toEqual({
      ok: true,
      issues: rows,
      githubEnvironment: { GH_TOKEN: 'short-lived-token', GH_REPO: 'acme/app' },
    })
    const command = input.runScript.mock.calls[0]![0].command
    expect(command).not.toContain('short-lived-token')
    expect(input.runScript).toHaveBeenCalledWith(expect.objectContaining({
      environmentVariables: { GH_TOKEN: 'short-lived-token', GH_REPO: 'acme/app' },
    }))
  })

  it('fails closed without running gh when a named credential cannot be exchanged', async () => {
    const input = baseInput()
    input.githubCredentialId = 'credential-1'
    input.fetchImpl.mockResolvedValue(new Response('{}', { status: 403 }))

    await expect(queryGithubIssues(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub credential exchange returned 403',
    })
    expect(input.runScript).not.toHaveBeenCalled()
  })

  it('rejects malformed gh output instead of advancing the trigger baseline', async () => {
    const input = baseInput()
    input.runScript.mockResolvedValue({ ok: true, stdout: '{not-json' })

    await expect(queryGithubIssues(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub issue query returned invalid data',
    })
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  createGithubIssueProgressMarker,
  removeGithubIssueProgressMarker,
  resolveGithubIssueProgressMarkerIdentity,
} from './githubIssueProgressMarker'
import type { RunAutomationScriptInput, RunAutomationScriptResult } from './runAutomationScript'

function runner(outputs: Array<RunAutomationScriptResult>) {
  return vi.fn(async (_input: RunAutomationScriptInput): Promise<RunAutomationScriptResult> => (
    outputs.shift() ?? { ok: false, stdout: '', error: 'unexpected call' }
  ))
}

const base = {
  cwd: '/repo',
  allowedRoot: '/repo',
  githubEnvironment: { GH_TOKEN: 'short-lived-token', GH_REPO: 'acme/app' },
}

describe('githubIssueProgressMarker', () => {
  it('resolves the actor while keeping the credential token out of the command', async () => {
    const runScript = runner([{ ok: true, stdout: 'automation-bot\n' }])

    await expect(resolveGithubIssueProgressMarkerIdentity({ ...base, runScript })).resolves.toEqual({
      ok: true, actor: 'automation-bot', repository: 'acme/app',
    })
    expect(runScript).toHaveBeenCalledWith(expect.objectContaining({
      command: 'gh api user --jq .login',
      environmentVariables: base.githubEnvironment,
    }))
    expect(runScript.mock.calls[0]![0].command).not.toContain('short-lived-token')
  })

  it('creates one eyes reaction and verifies the returned owner', async () => {
    const runScript = runner([{
      ok: true,
      stdout: JSON.stringify({ id: 321, content: 'eyes', user: { login: 'AUTOMATION-BOT' } }),
    }])

    await expect(createGithubIssueProgressMarker({
      ...base, runScript, issueNumber: 12, actor: 'automation-bot', repository: 'acme/app',
    })).resolves.toEqual({ ok: true, reactionId: 321 })
    expect(runScript).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining('repos/$GH_REPO/issues/12/reactions'),
      environmentVariables: base.githubEnvironment,
    }))
  })

  it('removes only the recorded eyes reaction after revalidating actor and content', async () => {
    const runScript = runner([
      { ok: true, stdout: JSON.stringify([[
        { id: 111, content: 'eyes', user: { login: 'someone-else' } },
        { id: 321, content: 'eyes', user: { login: 'automation-bot' } },
      ]]) },
      { ok: true, stdout: '' },
    ])

    await expect(removeGithubIssueProgressMarker({
      ...base, runScript, issueNumber: 12, actor: 'automation-bot', reactionId: 321,
      repository: 'acme/app',
    })).resolves.toEqual({ ok: true, removed: true })
    expect(runScript.mock.calls[1]![0].command).toContain('reactions/321')
  })

  it('recovers a crash-window marker only when exactly one owned eyes reaction exists', async () => {
    const runScript = runner([{ ok: true, stdout: JSON.stringify([[
      { id: 321, content: 'eyes', user: { login: 'automation-bot' } },
      { id: 322, content: 'eyes', user: { login: 'AUTOMATION-BOT' } },
    ]]) }])

    await expect(removeGithubIssueProgressMarker({
      ...base, runScript, issueNumber: 12, actor: 'automation-bot', reactionId: null,
      repository: 'acme/app',
    })).resolves.toEqual({ ok: false, error: 'GitHub issue progress reaction ownership is ambiguous' })
    expect(runScript).toHaveBeenCalledTimes(1)
  })

  it('treats an already absent owned reaction as cleaned up', async () => {
    const runScript = runner([{ ok: true, stdout: JSON.stringify([[]]) }])

    await expect(removeGithubIssueProgressMarker({
      ...base, runScript, issueNumber: 12, actor: 'automation-bot', reactionId: 321,
      repository: 'acme/app',
    })).resolves.toEqual({ ok: true, removed: false })
  })
})

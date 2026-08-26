import { describe, expect, it, vi } from 'vitest'

import { mergePullRequestFiles, queryGithubPullRequests } from './queryGithubPullRequests'
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
    includeChangedFiles: undefined as boolean | undefined,
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

  // 403 은 서버에서 다섯 가지 이유로 나온다. status 만 남기면 운영자가 원인을
  // 좁힐 수 없어 응답 본문의 error 를 함께 보고한다.
  it('reports the server reason so a rejected exchange names which check failed', async () => {
    const input = baseInput()
    input.githubCredentialId = 'credential-1'
    input.fetchImpl.mockResolvedValue(new Response(
      JSON.stringify({ error: 'Selected GitHub credential cannot access the project repository' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ))

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub credential exchange returned 403: '
        + 'Selected GitHub credential cannot access the project repository',
    })
    expect(input.runScript).not.toHaveBeenCalled()
  })

  it('keeps the bare status when the rejection body carries no usable reason', async () => {
    const input = baseInput()
    input.githubCredentialId = 'credential-1'
    input.fetchImpl.mockResolvedValue(new Response('<html>Gateway blocked</html>', {
      status: 403,
      headers: { 'Content-Type': 'text/html' },
    }))

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub credential exchange returned 403',
    })
  })

  it('never leaks a token that a non-ok response happens to carry', async () => {
    const input = baseInput()
    input.githubCredentialId = 'credential-1'
    input.fetchImpl.mockResolvedValue(new Response(
      JSON.stringify({ error: 'nope', token: 'ghp_supersecret', repository: 'acme/app' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ))

    const result = await queryGithubPullRequests(input)
    expect(result).toEqual({ ok: false, error: 'GitHub credential exchange returned 403: nope' })
    expect(JSON.stringify(result)).not.toContain('ghp_supersecret')
  })

  it('truncates an oversized server reason instead of flooding the daemon log', async () => {
    const input = baseInput()
    input.githubCredentialId = 'credential-1'
    input.fetchImpl.mockResolvedValue(new Response(
      JSON.stringify({ error: 'x'.repeat(500) }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ))

    const result = await queryGithubPullRequests(input)
    expect(result).toEqual({
      ok: false,
      error: `GitHub credential exchange returned 403: ${'x'.repeat(200)}…`,
    })
  })

  it('rejects malformed gh output instead of advancing the trigger baseline', async () => {
    const input = baseInput()
    input.runScript.mockResolvedValue({ ok: true, stdout: '{not-json' })

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub query returned invalid data',
    })
  })

  // credential exchange 사유를 로그에 남긴 뒤, 다음 벽은 gh 실행 실패였다.
  // runAutomationScript 는 이미 error 를 채워주는데 여기서 버리고 있었다.
  it('reports why gh failed instead of a fixed message', async () => {
    const input = baseInput()
    input.runScript.mockResolvedValue({
      ok: false,
      stdout: '',
      error: 'Command failed: gh pr list\ngh: Resource not accessible by personal access token (HTTP 403)',
    })

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub query failed: gh: Resource not accessible by personal access token (HTTP 403)',
    })
  })

  it('keeps the bare message when the runner gives no reason', async () => {
    const input = baseInput()
    input.runScript.mockResolvedValue({ ok: false, stdout: '' })

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub query failed',
    })
  })

  // Node 의 exec 오류는 `Command failed: <명령>\n<stderr>` 다. gh 명령이 180자라
  // 명령 에코를 그대로 두면 200자 예산을 다 먹고 정작 stderr 가 잘린다.
  it('drops the command echo so the budget is spent on stderr', async () => {
    const input = baseInput()
    input.runScript.mockResolvedValue({
      ok: false,
      stdout: '',
      error: `Command failed: ${'gh pr list --json a,b,c '.repeat(8)}\nHTTP 504: We couldn't respond in time`,
    })

    const result = await queryGithubPullRequests(input)

    expect(result).toEqual({
      ok: false,
      error: "GitHub query failed: HTTP 504: We couldn't respond in time",
    })
  })

  it('keeps the original message when there is no stderr after the command echo', async () => {
    const input = baseInput()
    input.runScript.mockResolvedValue({ ok: false, stdout: '', error: 'Command failed: gh pr list' })

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: 'GitHub query failed: Command failed: gh pr list',
    })
  })

  it('truncates an oversized runner error instead of flooding the daemon log', async () => {
    const input = baseInput()
    input.runScript.mockResolvedValue({ ok: false, stdout: '', error: 'y'.repeat(500) })

    await expect(queryGithubPullRequests(input)).resolves.toEqual({
      ok: false,
      error: `GitHub query failed: ${'y'.repeat(200)}\u2026`,
    })
  })

  // files 는 PR 100개 각각의 변경 파일을 GraphQL 로 가져오는 가장 비싼 필드인데,
  // matchesFilter 는 filter.paths 가 있을 때만 참조한다. 경로 필터가 없는 트리거가
  // 매 폴링마다 이걸 긁어오다 큰 저장소에서 GitHub 504 를 맞았다.
  it('omits the file list when the trigger has no path filter', async () => {
    const input = baseInput()
    input.includeChangedFiles = false
    input.runScript.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify(rows.map(({ changedFiles: _c, files: _f, ...rest }) => rest)),
    })

    const result = await queryGithubPullRequests(input)

    const command = input.runScript.mock.calls[0]![0].command
    expect(command).not.toContain('changedFiles')
    expect(command).not.toContain(',files')
    expect(result.ok).toBe(true)
  })

  it('fills the omitted file fields so path-free planning still parses', async () => {
    const input = baseInput()
    input.includeChangedFiles = false
    input.runScript.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify(rows.map(({ changedFiles: _c, files: _f, ...rest }) => rest)),
    })

    const result = await queryGithubPullRequests(input)

    expect(result.ok && result.pullRequests[0]).toMatchObject({ changedFiles: 0, files: [] })
  })

  it('still requests the file list when a path filter needs it', async () => {
    const input = baseInput()
    input.includeChangedFiles = true

    await queryGithubPullRequests(input)

    expect(input.runScript.mock.calls[0]![0].command).toContain('changedFiles,files')
  })

  it('keeps requesting the file list when the caller says nothing', async () => {
    const input = baseInput()

    await queryGithubPullRequests(input)

    expect(input.runScript.mock.calls[0]![0].command).toContain('changedFiles,files')
  })
})

// 경로 필터가 있는 트리거는 파일이 필요하지만, 이벤트를 유발하는 PR 에만 필요하다.
describe('mergePullRequestFiles', () => {
  const pr = (n: number) => ({
    number: n, title: 't', url: 'u', author: { login: 'a' }, baseRefName: 'main',
    headRefName: 'f', isDraft: false, state: 'OPEN' as const, mergedAt: null,
    labels: [], changedFiles: 0, files: [],
  })

  it('fills only the requested pull requests', () => {
    const merged = mergePullRequestFiles([pr(1), pr(2)], [
      { number: 2, changedFiles: 3, files: [{ path: 'api/a.ts' }] },
    ])

    expect(merged.find((p) => p.number === 2)).toMatchObject({
      changedFiles: 3, files: [{ path: 'api/a.ts' }],
    })
    expect(merged.find((p) => p.number === 1)).toMatchObject({ changedFiles: 0, files: [] })
  })

  it('keeps the original order and length', () => {
    const merged = mergePullRequestFiles([pr(5), pr(3), pr(9)], [{ number: 3, changedFiles: 1, files: [] }])

    expect(merged.map((p) => p.number)).toEqual([5, 3, 9])
  })

  it('ignores a detail for a pull request that is not in the list', () => {
    const merged = mergePullRequestFiles([pr(1)], [{ number: 77, changedFiles: 9, files: [] }])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ number: 1, changedFiles: 0 })
  })
})

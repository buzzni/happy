import { z } from 'zod'

import { describeHttpFailure } from './describeHttpFailure'
import { runAutomationScript } from './runAutomationScript'
import type { GithubPullRequestSnapshot } from './githubTriggerDomain'

const EXCHANGE_TIMEOUT_MS = 3_000
const QUERY_TIMEOUT_MS = 60_000
const GH_PR_LIST_FIELDS = 'number,title,url,author,baseRefName,headRefName,headRefOid,isDraft,state,mergedAt,labels'
// changedFiles/files 는 PR 100개 각각의 변경 파일을 GraphQL 로 가져오는, 이 쿼리에서
// 가장 비싼 필드다. matchesFilter 는 filter.paths 가 있을 때만 참조하므로 경로 필터가
// 없으면 요청하지 않는다 — 큰 저장소에서 GitHub 이 504 를 내던 원인이다.
const GH_PR_LIST_FILE_FIELDS = 'changedFiles,files'

function buildPrListCommand(includeChangedFiles: boolean): string {
  const fields = includeChangedFiles
    ? `${GH_PR_LIST_FIELDS},${GH_PR_LIST_FILE_FIELDS}`
    : GH_PR_LIST_FIELDS
  return `gh pr list --state all --limit 100 --search "sort:updated-desc" --json ${fields}`
}

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(10_000),
  url: z.string().min(1).max(2_000),
  author: z.object({ login: z.string().min(1).max(200) }).nullable(),
  baseRefName: z.string().min(1).max(512),
  headRefName: z.string().min(1).max(512),
  headRefOid: z.string().regex(/^[a-f0-9]{40,64}$/i),
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  mergedAt: z.string().max(100).nullable(),
  labels: z.array(z.object({ name: z.string().min(1).max(200) })).max(100),
  // 경로 필터가 없으면 요청하지 않으므로 없을 수 있다 (buildPrListCommand 참고).
  changedFiles: z.number().int().min(0).optional().default(0),
  files: z.array(z.object({ path: z.string().min(1).max(2_000) })).max(100).optional().default([]),
})

const pullRequestsSchema = z.array(pullRequestSchema).max(100)
const credentialResponseSchema = z.object({
  token: z.string().min(1).max(8_192),
  repository: z.string().max(401).regex(/^[^/\s]+\/[^/\s]+$/),
})

export type QueryGithubPullRequestsResult =
  | {
    ok: true
    pullRequests: GithubPullRequestSnapshot[]
    githubEnvironment?: { GH_TOKEN: string; GH_REPO: string }
  }
  | { ok: false; error: string }

const EXCHANGE_REASON_MAX_CHARS = 200

/**
 * Node 의 exec 오류는 `Command failed: <명령>\n<stderr>` 다. gh 명령은 180자가 넘어
 * 그대로 두면 사유 예산을 명령 에코가 다 먹고 정작 stderr 가 잘린다.
 */
function stripCommandEcho(error: string): string {
  if (!error.startsWith('Command failed: ')) return error
  const newline = error.indexOf('\n')
  if (newline === -1) return error
  return error.slice(newline + 1).trim() || error
}

/**
 * gh 실행 실패 사유를 기존 메시지 뒤에 붙인다. runAutomationScript 는 비0 종료의
 * stderr 와 타임아웃을 이미 error 에 담아 주는데, 호출부가 이를 버리면 운영자는
 * "GitHub query failed" 한 줄만 보고 원인을 좁힐 수 없다.
 *
 * 명령 문자열과 stderr 만 담기고 토큰은 환경변수로만 전달되므로 로그에 새지 않는다.
 */
export function describeQueryFailure(error: string | undefined): string {
  if (!error) return ''
  const collapsed = stripCommandEcho(error).replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed.length > EXCHANGE_REASON_MAX_CHARS
    ? `: ${collapsed.slice(0, EXCHANGE_REASON_MAX_CHARS)}\u2026`
    : `: ${collapsed}`
}

export async function exchangeCredential(input: {
  configUrl: string | undefined
  machineToken: string
  machineId: string
  runId: string
  claimToken: string
  credentialId: string
  fetchImpl: typeof fetch
}): Promise<{ ok: true; token: string; repository: string } | { ok: false; error: string }> {
  let exchangeUrl: string
  try {
    if (!input.configUrl) throw new Error()
    exchangeUrl = new URL('/api/automation/github-credential', input.configUrl).toString()
  } catch {
    return { ok: false, error: 'GitHub credential exchange is unavailable' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS)
  try {
    const response = await input.fetchImpl(exchangeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.machineToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        machineId: input.machineId,
        runId: input.runId,
        claimToken: input.claimToken,
        credentialId: input.credentialId,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const reason = await describeHttpFailure(response)
      return { ok: false, error: `GitHub credential exchange returned ${response.status}${reason}` }
    }
    const value = credentialResponseSchema.safeParse(await response.json())
    return value.success
      ? { ok: true, token: value.data.token, repository: value.data.repository }
      : { ok: false, error: 'GitHub credential exchange returned invalid data' }
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted
        ? 'GitHub credential exchange timed out'
        : 'GitHub credential exchange failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

const pullRequestFilesSchema = z.object({
  number: z.number().int().positive(),
  changedFiles: z.number().int().min(0),
  files: z.array(z.object({ path: z.string().min(1).max(2_000) })).max(100),
})

export type PullRequestFiles = z.infer<typeof pullRequestFilesSchema>

/**
 * 지연 조회한 파일 목록을 원본 PR 에 채운다. 조회하지 않은 PR 은 그대로 둔다
 * (경로 필터 판정 대상이 아니므로 기본값 0/[] 로 충분하다).
 */
export function mergePullRequestFiles(
  pullRequests: GithubPullRequestSnapshot[],
  details: PullRequestFiles[],
): GithubPullRequestSnapshot[] {
  if (details.length === 0) return pullRequests
  const byNumber = new Map(details.map((detail) => [detail.number, detail]))
  return pullRequests.map((pullRequest) => {
    const detail = byNumber.get(pullRequest.number)
    return detail
      ? { ...pullRequest, changedFiles: detail.changedFiles, files: detail.files }
      : pullRequest
  })
}

/**
 * 후보 PR 의 파일 목록만 받아온다. 목록 조회에서 files 를 빼면 hsmoa_backend
 * 기준 3,506ms → 933ms 이고, 후보는 보통 폴링당 0~2건이라 추가 비용이 작다.
 */
export async function queryGithubPullRequestFiles(input: {
  numbers: number[]
  cwd: string
  allowedRoot: string
  environmentVariables?: { GH_TOKEN: string; GH_REPO: string }
  runScript?: typeof runAutomationScript
}): Promise<{ ok: true; files: PullRequestFiles[] } | { ok: false; error: string }> {
  if (input.numbers.length === 0) return { ok: true, files: [] }
  const details: PullRequestFiles[] = []
  for (const number of input.numbers) {
    const query = await (input.runScript ?? runAutomationScript)({
      command: `gh pr view ${number} --json number,changedFiles,files`,
      cwd: input.cwd,
      timeout: QUERY_TIMEOUT_MS,
      allowedRoot: input.allowedRoot,
      environmentVariables: input.environmentVariables,
    })
    if (!query.ok) {
      return { ok: false, error: `GitHub file query failed${describeQueryFailure(query.error)}` }
    }
    const parsed = pullRequestFilesSchema.safeParse(JSON.parse(query.stdout || 'null'))
    if (!parsed.success) return { ok: false, error: 'GitHub file query returned invalid data' }
    details.push(parsed.data)
  }
  return { ok: true, files: details }
}

export async function queryGithubPullRequests(input: {
  configUrl: string | undefined
  machineToken: string
  machineId: string
  runId: string
  claimToken: string
  githubCredentialId: string | null
  cwd: string
  allowedRoot: string
  /** 경로 필터가 있는 트리거만 파일 목록이 필요하다. 생략하면 기존대로 포함한다. */
  includeChangedFiles?: boolean
  fetchImpl?: typeof fetch
  runScript?: typeof runAutomationScript
}): Promise<QueryGithubPullRequestsResult> {
  let githubEnvironment: { GH_TOKEN: string; GH_REPO: string } | undefined
  if (input.githubCredentialId) {
    const exchanged = await exchangeCredential({
      ...input,
      credentialId: input.githubCredentialId,
      fetchImpl: input.fetchImpl ?? fetch,
    })
    if (!exchanged.ok) return exchanged
    githubEnvironment = { GH_TOKEN: exchanged.token, GH_REPO: exchanged.repository }
  }

  const query = await (input.runScript ?? runAutomationScript)({
    command: buildPrListCommand(input.includeChangedFiles ?? true),
    cwd: input.cwd,
    timeout: QUERY_TIMEOUT_MS,
    allowedRoot: input.allowedRoot,
    environmentVariables: githubEnvironment,
  })
  if (!query.ok) return { ok: false, error: `GitHub query failed${describeQueryFailure(query.error)}` }
  try {
    const pullRequests = pullRequestsSchema.parse(JSON.parse(query.stdout))
    return {
      ok: true,
      pullRequests,
      ...(githubEnvironment ? { githubEnvironment } : {}),
    }
  } catch {
    return { ok: false, error: 'GitHub query returned invalid data' }
  }
}

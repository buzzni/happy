import { z } from 'zod'

import { runAutomationScript } from './runAutomationScript'
import type { GithubPullRequestSnapshot } from './githubTriggerDomain'

const EXCHANGE_TIMEOUT_MS = 3_000
const QUERY_TIMEOUT_MS = 60_000
const GH_PR_LIST_COMMAND = 'gh pr list --state all --limit 100 --search "sort:updated-desc" --json number,title,url,author,baseRefName,headRefName,isDraft,state,mergedAt,labels,changedFiles,files'

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(10_000),
  url: z.string().min(1).max(2_000),
  author: z.object({ login: z.string().min(1).max(200) }).nullable(),
  baseRefName: z.string().min(1).max(512),
  headRefName: z.string().min(1).max(512),
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  mergedAt: z.string().max(100).nullable(),
  labels: z.array(z.object({ name: z.string().min(1).max(200) })).max(100),
  changedFiles: z.number().int().min(0),
  files: z.array(z.object({ path: z.string().min(1).max(2_000) })).max(100),
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

async function exchangeCredential(input: {
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
      return { ok: false, error: `GitHub credential exchange returned ${response.status}` }
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

export async function queryGithubPullRequests(input: {
  configUrl: string | undefined
  machineToken: string
  machineId: string
  runId: string
  claimToken: string
  githubCredentialId: string | null
  cwd: string
  allowedRoot: string
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
    command: GH_PR_LIST_COMMAND,
    cwd: input.cwd,
    timeout: QUERY_TIMEOUT_MS,
    allowedRoot: input.allowedRoot,
    environmentVariables: githubEnvironment,
  })
  if (!query.ok) return { ok: false, error: 'GitHub query failed' }
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

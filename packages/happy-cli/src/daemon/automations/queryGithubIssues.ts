import { z } from 'zod'

import { runAutomationScript } from './runAutomationScript'
import { describeQueryFailure, exchangeCredential } from './queryGithubPullRequests'
import type { GithubIssueSnapshot } from './githubTriggerDomain'

const QUERY_TIMEOUT_MS = 60_000
const GH_ISSUE_LIST_COMMAND = 'gh issue list --state open --limit 100 --search "sort:created-desc" --json number,title,url,author,labels'

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(10_000),
  url: z.string().min(1).max(2_000),
  author: z.object({ login: z.string().min(1).max(200) }).nullable(),
  labels: z.array(z.object({ name: z.string().min(1).max(200) })).max(100),
})

const issuesSchema = z.array(issueSchema).max(100)

export type QueryGithubIssuesResult =
  | {
    ok: true
    issues: GithubIssueSnapshot[]
    githubEnvironment?: { GH_TOKEN: string; GH_REPO: string }
  }
  | { ok: false; error: string }

export async function queryGithubIssues(input: {
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
}): Promise<QueryGithubIssuesResult> {
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
    command: GH_ISSUE_LIST_COMMAND,
    cwd: input.cwd,
    timeout: QUERY_TIMEOUT_MS,
    allowedRoot: input.allowedRoot,
    environmentVariables: githubEnvironment,
  })
  if (!query.ok) return { ok: false, error: `GitHub issue query failed${describeQueryFailure(query.error)}` }
  try {
    const issues = issuesSchema.parse(JSON.parse(query.stdout))
    return {
      ok: true,
      issues,
      ...(githubEnvironment ? { githubEnvironment } : {}),
    }
  } catch {
    return { ok: false, error: 'GitHub issue query returned invalid data' }
  }
}

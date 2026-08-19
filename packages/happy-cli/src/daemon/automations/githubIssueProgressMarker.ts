/**
 * Owns the temporary GitHub 👀 reaction for issue-triggered automation sessions.
 * Tokens stay in the command environment; only actor and reaction identity are
 * returned for durable crash recovery.
 */

import { z } from 'zod'

import { runAutomationScript } from './runAutomationScript'
import type { RunAutomationScriptInput, RunAutomationScriptResult } from './runAutomationScript'

const QUERY_TIMEOUT_MS = 60_000
const MUTATION_TIMEOUT_MS = 30_000
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,200}$/
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/

const reactionSchema = z.object({
  id: z.number().int().positive(),
  content: z.string().max(100),
  user: z.object({ login: z.string().min(1).max(200) }),
})
const reactionPagesSchema = z.array(z.array(reactionSchema).max(100)).max(100)

type ScriptRunner = (input: RunAutomationScriptInput) => Promise<RunAutomationScriptResult>

interface GithubMarkerCommandInput {
  cwd: string
  allowedRoot: string
  githubEnvironment?: Record<string, string>
  runScript?: ScriptRunner
}

interface GithubMarkerOwnedInput extends GithubMarkerCommandInput {
  issueNumber: number
  actor: string
  repository: string
}

function validIssueNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function markerEnvironment(input: GithubMarkerOwnedInput): Record<string, string> {
  return { ...(input.githubEnvironment ?? {}), GH_REPO: input.repository }
}

function sameActor(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

async function run(
  input: GithubMarkerCommandInput,
  command: string,
  timeout: number,
  environmentVariables = input.githubEnvironment,
): Promise<RunAutomationScriptResult> {
  return (input.runScript ?? runAutomationScript)({
    command,
    cwd: input.cwd,
    timeout,
    allowedRoot: input.allowedRoot,
    environmentVariables,
  })
}

export async function resolveGithubIssueProgressMarkerIdentity(
  input: GithubMarkerCommandInput,
): Promise<{ ok: true; actor: string; repository: string } | { ok: false; error: string }> {
  const actorResult = await run(input, 'gh api user --jq .login', QUERY_TIMEOUT_MS)
  const actor = actorResult.stdout.trim()
  if (!actorResult.ok || !LOGIN_PATTERN.test(actor)) {
    return { ok: false, error: 'GitHub issue progress actor lookup failed' }
  }

  let repository = input.githubEnvironment?.GH_REPO ?? ''
  if (!repository) {
    const repositoryResult = await run(
      input,
      'gh repo view --json nameWithOwner --jq .nameWithOwner',
      QUERY_TIMEOUT_MS,
    )
    repository = repositoryResult.stdout.trim()
    if (!repositoryResult.ok) repository = ''
  }
  return REPOSITORY_PATTERN.test(repository)
    ? { ok: true, actor, repository }
    : { ok: false, error: 'GitHub issue progress repository lookup failed' }
}

export async function createGithubIssueProgressMarker(
  input: GithubMarkerOwnedInput,
): Promise<{ ok: true; reactionId: number } | { ok: false; error: string }> {
  if (!validIssueNumber(input.issueNumber) || !LOGIN_PATTERN.test(input.actor)
    || !REPOSITORY_PATTERN.test(input.repository)) {
    return { ok: false, error: 'GitHub issue progress marker input is invalid' }
  }
  const result = await run(
    input,
    `gh api -X POST "repos/$GH_REPO/issues/${input.issueNumber}/reactions" -f content=eyes`,
    MUTATION_TIMEOUT_MS,
    markerEnvironment(input),
  )
  if (!result.ok) return { ok: false, error: 'GitHub issue progress reaction creation failed' }
  let parsed: ReturnType<typeof reactionSchema.safeParse>
  try {
    parsed = reactionSchema.safeParse(JSON.parse(result.stdout || 'null'))
  } catch {
    return { ok: false, error: 'GitHub issue progress reaction creation returned invalid data' }
  }
  if (!parsed.success || parsed.data.content !== 'eyes' || !sameActor(parsed.data.user.login, input.actor)) {
    return { ok: false, error: 'GitHub issue progress reaction ownership mismatch' }
  }
  return { ok: true, reactionId: parsed.data.id }
}

export async function removeGithubIssueProgressMarker(
  input: GithubMarkerOwnedInput & { reactionId: number | null },
): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
  if (!validIssueNumber(input.issueNumber) || !LOGIN_PATTERN.test(input.actor)
    || !REPOSITORY_PATTERN.test(input.repository)
    || (input.reactionId !== null && !validIssueNumber(input.reactionId))) {
    return { ok: false, error: 'GitHub issue progress marker input is invalid' }
  }
  const listed = await run(
    input,
    `gh api --paginate --slurp "repos/$GH_REPO/issues/${input.issueNumber}/reactions?per_page=100"`,
    QUERY_TIMEOUT_MS,
    markerEnvironment(input),
  )
  if (!listed.ok) return { ok: false, error: 'GitHub issue progress reaction lookup failed' }
  let reactions: z.infer<typeof reactionSchema>[]
  try {
    reactions = reactionPagesSchema.parse(JSON.parse(listed.stdout)).flat()
  } catch {
    return { ok: false, error: 'GitHub issue progress reaction lookup returned invalid data' }
  }

  let reactionId = input.reactionId
  if (reactionId !== null) {
    const recorded = reactions.find((reaction) => reaction.id === reactionId)
    if (!recorded) return { ok: true, removed: false }
    if (recorded.content !== 'eyes' || !sameActor(recorded.user.login, input.actor)) {
      return { ok: false, error: 'GitHub issue progress reaction ownership mismatch' }
    }
  } else {
    const owned = reactions.filter((reaction) => (
      reaction.content === 'eyes' && sameActor(reaction.user.login, input.actor)
    ))
    if (owned.length === 0) return { ok: true, removed: false }
    if (owned.length !== 1) {
      return { ok: false, error: 'GitHub issue progress reaction ownership is ambiguous' }
    }
    reactionId = owned[0]!.id
  }

  const removed = await run(
    input,
    `gh api -X DELETE "repos/$GH_REPO/issues/${input.issueNumber}/reactions/${reactionId}"`,
    MUTATION_TIMEOUT_MS,
    markerEnvironment(input),
  )
  return removed.ok
    ? { ok: true, removed: true }
    : { ok: false, error: 'GitHub issue progress reaction removal failed' }
}

/**
 * 2026-10-17 — 이슈 트리거 자동 실행이 끝나 데몬이 automation worktree 를 지운 뒤, 사용자가
 * 같은 Chat 에 답하자 "Failed to resume session: ENOENT ... realpath" 로 막혔다. 두 겹이었다:
 * (1) 체크포인트 사전 검사가 복구보다 먼저 realpath 를 해 던졌고, (2) 복구는 저장소 안
 * `.aplus/worktrees/` 만 알아 저장소 밖 automation worktree 를 되살릴 근거가 없었다.
 * run.ts 는 거대한 클로저라 단위로 부를 수 없으므로 소스 배선을 본다 — 배선이 빠져도
 * missingWorktreeRestore·githubWorktreeTombstones 테스트는 전부 통과한다.
 */
import { describe, expect, it } from 'vitest'

async function runSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  return readFile(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8')
}

function resumeBody(source: string): string {
  const start = source.indexOf('const spawnResumedSession = async')
  return source.slice(start, source.indexOf('const resumeInFlight = new Map', start))
}

describe('resume of a session whose worktree was removed', () => {
  it('puts the worktree back before anything resolves the session directory', async () => {
    const resume = resumeBody(await runSource())
    const restore = resume.indexOf('await restoreMissingManagedWorktree(')
    expect(restore).toBeGreaterThan(0)
    expect(resume.indexOf('resolveCheckpointSessionAuthority(')).toBeGreaterThan(restore)
    expect(resume.slice(0, restore)).not.toMatch(/realpath\(/)
  })

  it('lets the restore find automation worktrees the daemon removed', async () => {
    const resume = resumeBody(await runSource())
    const restoreCall = resume.slice(resume.indexOf('await restoreMissingManagedWorktree('))
    expect(restoreCall.slice(0, restoreCall.indexOf('});'))).toContain('findRemovedAutomationWorktree:')
  })

  it('records every automation worktree removal so it can be put back', async () => {
    const source = await runSource()
    expect(source).toContain('discardGithubWorktree: rememberGithubWorktreeRemoval(removeGithubTriggerWorktree,')
  })
})

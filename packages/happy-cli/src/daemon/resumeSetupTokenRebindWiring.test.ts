/**
 * 2026-10-22 — 데스크톱 그룹 동기화가 회수한 조직 계정에 묶여 유휴 종료된 대화가 재개 때
 * `CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE`로 막혔다(Saycode specs/managed-account-session-continuation).
 * run.ts 는 거대한 클로저라 단위로 부를 수 없으므로 소스 배선을 본다 — 배선이 빠져도
 * resumeSetupTokenRebind·setupTokenAccountSwitch 테스트는 전부 통과한다.
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

describe('resume of a session whose organization account left this PC', () => {
  it('resolves its credentials through the account move, with the switch that finds the session being resumed', async () => {
    const source = await runSource()
    const resume = resumeBody(source)
    const move = resume.indexOf('await resumeSetupTokenEnvironment(')
    expect(move).toBeGreaterThan(0)
    expect(resume.slice(0, move)).toContain('resumingSetupTokenSessions.set(happySessionId, tracked)')
    expect(resume.slice(move)).toContain('setupTokenAccountSwitch?.rebind(sessionId, running)')
    // Cleared on every path, machine-bound resumes included (review #911).
    expect(resume.slice(move)).toMatch(/\} finally \{\s*resumingSetupTokenSessions\.delete\(happySessionId\);/)
    expect(resume).toContain('const managedAiCredentialEnvironment = resumedCredentials.environment;')
    expect(source).toContain('?? resumingSetupTokenSessions.get(sessionId),')
  })

  it('tells only the resumed process about a move the daemon made', async () => {
    const resume = resumeBody(await runSource())
    expect(resume).toContain("[SETUP_TOKEN_RESUME_REBOUND_ENV]: resumedCredentials.rebound ? '1' : '',")
  })

  // Saycode specs/claude-org-personal-coexistence I: before a live child is reused or a new one spawned.
  it('checks an organization-only requirement against the recorded binding before any process is reused or started', async () => {
    const resume = resumeBody(await runSource())
    const check = resume.indexOf('organizationResumeRefusal(options?.aiAuthRequirement, resumeSource, restoreManualToOrganization)')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(resume.indexOf('if (hasLiveDaemonChild('))
    expect(resume).toMatch(/const restoreManualToOrganization = !!options\?\.aiAuthRequirement && resumeSource\?\.\[MANUAL_PERSONAL_ENV\] !== undefined && !hasLiveDaemonChild\(/)
    expect(resume.slice(check, check + 400)).toContain("code: 'CLAUDE_ORGANIZATION_RESUME_REQUIRED'")
  })

  it('never vouches for a live child with the record, since it may be on a consented personal fallback', async () => {
    const resume = resumeBody(await runSource())
    const live = resume.indexOf('if (hasLiveDaemonChild(')
    const reuse = resume.indexOf('a live child is already attached — reusing it')
    const refusal = resume.indexOf("if (options?.aiAuthRequirement) return { type: 'error', code: 'CLAUDE_ORGANIZATION_RESUME_REQUIRED'", live)
    expect(refusal).toBeGreaterThan(live)
    expect(refusal).toBeLessThan(reuse)
  })

  // Review #976: the check above runs only for the caller that starts the attempt, not for one that joins it.
  it('never lets a requirement resume join one already in flight', async () => {
    expect(await runSource()).toContain('shareResumeInFlight(resumeInFlight, happySessionId, options?.aiAuthRequirement, () => spawnResumedSession(happySessionId, options))')
  })
})

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
    expect(resume.slice(move)).toContain('resumingSetupTokenSessions.delete(happySessionId)')
    expect(resume).toContain('const managedAiCredentialEnvironment = resumedCredentials.environment;')
    expect(source).toContain('?? resumingSetupTokenSessions.get(sessionId),')
  })

  it('tells only the resumed process about a move the daemon made', async () => {
    const resume = resumeBody(await runSource())
    expect(resume).toContain("[SETUP_TOKEN_RESUME_REBOUND_ENV]: resumedCredentials.rebound ? '1' : '',")
  })
})

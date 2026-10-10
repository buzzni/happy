/**
 * daemon 은 요청 env 를 저장하지 않는다. Chat 세션의 조직 env 는 클라이언트 요청에만 있으므로
 * (1) 같은 세션 recover 가 요청 env 를 넘기고, (2) daemon 이 스스로 하는 브라우저 대기 resume 이
 * 기억한 요청 env 를 다시 실어야 한다. run.ts 는 거대한 클로저라 단위로 부를 수 없으므로 소스
 * 배선을 본다 — 호출이 빠져도 requestEnvironmentMemory.test.ts 는 전부 통과한다.
 */
import { describe, expect, it } from 'vitest'

async function runSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  return readFile(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8')
}

describe('request environment wiring', () => {
  it('same-session recovery starts the resumed child with the requested environment', async () => {
    const source = await runSource()
    const sameSession = source.slice(source.indexOf("if (decision.kind === 'same-session') {"))
    const resumeCall = sameSession.slice(0, sameSession.indexOf('});', sameSession.indexOf('spawnResumedSession(serverSession.id')))
    expect(resumeCall).toContain('environmentVariables: options.environmentVariables,')
  })

  it('a held browser attention resume re-sends the remembered client environment', async () => {
    const source = await runSource()
    const attention = source.slice(source.indexOf('const resumeForBrowserAttention = async'))
    expect(attention.slice(0, attention.indexOf('});'))).toContain('environmentVariables: requestEnvironments.recall(sessionId),')
  })

  it('remembers what clients send through every machine RPC and control server start', async () => {
    const source = await runSource()
    expect(source).toContain('spawnSession: requestEnvironments.rememberSpawn(spawnSession),')
    expect(source).toContain('resumeSession: requestEnvironments.rememberResume(')
    expect(source).toContain('recoverSession: requestEnvironments.rememberResume(')
    expect(source).toContain('!resumeInFlight.has(sessionId)')
    expect(source.match(/spawnSession: requestEnvironments\.rememberSpawn\(spawnSession\),/g)).toHaveLength(2)
  })
})

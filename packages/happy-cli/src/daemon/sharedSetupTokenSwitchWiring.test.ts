/**
 * Saycode specs/shared-pc-session-account-continuation — an unbound shared-PC session switches accounts only
 * against the account this daemon handed it. run.ts 는 거대한 클로저라 단위로 부를 수 없으므로 소스 배선을 본다 —
 * 기록이 빠지면 setupTokenAccountSwitch 는 모든 공용 PC 교체를 NOT_BOUND 로 거절하는데, 그 테스트는 기록을 직접 넣어 통과한다.
 */
import { describe, expect, it } from 'vitest'

async function runSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  return readFile(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8')
}

describe('shared-PC account switch wiring', () => {
  it('records the handed account on every tracked spawn, fresh, resumed and tmux, from the credentials actually prepared', async () => {
    const source = await runSource()
    const record = 'sharedSetupTokenAccount: sharedMachineSetupTokenAccount(managedAiCredentialEnvironment)'
    expect(source.split(record)).toHaveLength(3)
    const tracked = source.indexOf('const spawnTrackedHappyProcess = async')
    expect(source.indexOf(record, tracked)).toBeGreaterThan(tracked)
  })

  it('routes the switch of such a session to this PC\'s own assignment', async () => {
    expect(await runSource()).toContain('sharedMachine: { reportUsage: aiCredentialRuntime.sharedMachineUsage, rebind: aiCredentialRuntime.sharedMachineRebind },')
  })
})

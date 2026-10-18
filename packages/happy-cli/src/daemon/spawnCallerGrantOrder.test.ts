/**
 * aplus-dev-studio specs/machine-session-readiness-hardening G (prerequisite): the web retries a
 * spawn once after `MCP caller grant rejected (invalid-envelope)`. That is safe only while the
 * envelope is checked before any session process exists. spawnSessionUnchecked is a closure inside
 * runDaemon, so — like aiAuthSelectionWiring.test.ts — this pins the order in the source.
 */
import { describe, expect, it } from 'vitest'

async function spawnSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const source = await readFile(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8')
  const start = source.indexOf('const spawnSessionUnchecked = async (')
  const end = source.indexOf('const spawnSession = async (', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('spawn checks the caller grant before launching anything', () => {
  it('consumes the envelope before the first tmux launch, direct launch or tracked session', async () => {
    const spawn = await spawnSource()
    const consume = spawn.indexOf('mcpCallerGrantConsumer.consume(')
    expect(consume).toBeGreaterThan(-1)
    // spawnTrackedHappyProcess( is the regular path's call site; spawnHappyCLI( sits inside that helper.
    for (const launch of ['tmux.spawnInTmux(', 'spawnTrackedHappyProcess(', 'spawnHappyCLI(', 'pidToTrackedSession.set(']) {
      const at = spawn.indexOf(launch)
      expect(at, launch).toBeGreaterThan(-1)
      expect(consume, launch).toBeLessThan(at)
    }
  })

  it('returns the rejection instead of continuing without a grant', async () => {
    const spawn = await spawnSource()
    expect(spawn).toMatch(/if \(!consumed\.ok\) \{\s*return \{\s*type: 'error',\s*errorMessage: `MCP caller grant rejected \(\$\{consumed\.reason\}\)`/)
  })
})

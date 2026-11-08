/**
 * `launchMcpServers` is wired into the daemon spawn and resume and into the Claude and Codex runners
 * (aplus-dev-studio-desktop specs/extension-session-and-worktree-hooks).
 *
 * launchMcpServers.test.ts drives the pure halves. spawnSessionUnchecked, spawnResumedSession and the
 * runners are large closures, so — like spawnCallerGrantOrder.test.ts — the wiring is pinned in source.
 */
import { describe, expect, it } from 'vitest'

async function source(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  return readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  expect(from, start).toBeGreaterThan(-1)
  expect(to, end).toBeGreaterThan(from)
  return text.slice(from, to)
}

describe('daemon spawn', () => {
  it('adds the seed after ${VAR} expansion and before any launch, and answers with the drops', async () => {
    const spawn = between(await source('./run.ts'), 'const spawnSessionUnchecked = async (', 'const spawnSession = async (')
    const prepare = spawn.indexOf('launchMcp = prepareLaunchMcpServers({')
    expect(prepare).toBeGreaterThan(spawn.indexOf('extraEnv = expandEnvironmentVariables(extraEnv, process.env);'))
    expect(spawn).toContain("agent: options.agent ?? 'claude',")
    expect(spawn).toContain('Object.assign(extraEnv, launchMcp.environment);')
    for (const launch of ['tmux.spawnInTmux(', 'spawnTrackedHappyProcess(']) {
      expect(prepare, launch).toBeLessThan(spawn.indexOf(launch))
    }
    expect(spawn).toContain('const launchMcpDropped = await launchMcp?.report();')
  })
})

describe('daemon resume', () => {
  it('adds the seed to the respawned process and answers with the drops', async () => {
    const resume = between(await source('./run.ts'), 'const spawnResumedSession = async (', 'const resumeInFlight = new Map')
    const prepare = resume.indexOf('const resumeLaunchMcp = prepareLaunchMcpServers({')
    expect(prepare).toBeGreaterThan(-1)
    expect(resume).toContain('agent: resumeAgent,')
    expect(resume).toContain('Object.assign(resumedEnvironment, resumeLaunchMcp.environment);')
    expect(prepare).toBeLessThan(resume.indexOf('spawnResumedWithBrowserTaskRegistration({'))
    expect(resume).toContain('const launchMcpDropped = await resumeLaunchMcp.report();')
  })
})

describe('runners', () => {
  it('Claude reads the seed and puts the servers under the organization and internal servers', async () => {
    const text = await source('../claude/runClaude.ts')
    expect(text).toContain('const launchMcpServers = consumeLaunchMcpServersSeed(process.env);')
    expect(text).toContain('launchMcpServersBeside(launchMcpServers, Object.keys(aplusMcpServers))')
    expect(text).toMatch(/const baseMcpServers = \{\s*\.\.\.claudeLaunchMcpServers\(sessionLaunchMcpServers\),\s*'happy': happyServer\.mcpConfig,/)
    expect(text).toContain('mcpServers: mergeAplusMcpServers(baseMcpServers, aplusMcpServers),')
  })

  it('Codex reads the seed and puts the servers under the organization and internal servers', async () => {
    const text = await source('../codex/runCodex.ts')
    expect(text).toContain('const launchMcpServers = consumeLaunchMcpServersSeed(process.env);')
    expect(text).toContain('launchMcpServersBeside(launchMcpServers, Object.keys(initialAplusMcpServers))')
    expect(text).toMatch(/const baseMcpServers = \{\s*\.\.\.codexLaunchMcpServers\(sessionLaunchMcpServers, \(servers\) => bridgeAplusMcpServers\(servers, bridgeOptions\)\),\s*\.\.\.internalMcpServers,/)
    expect(text).toContain('baseServers: baseMcpServers,')
  })
})

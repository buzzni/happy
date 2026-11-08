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
    expect(spawn).toContain("...agentMcpServerNames(options.agent ?? 'claude', { env: { ...process.env, ...extraEnv }, homeDir: os.homedir(), cwd: directory }),")
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
    expect(resume).toContain('...agentMcpServerNames(resumeAgent, { env: resumedEnvironment, homeDir: os.homedir(), cwd: launch.cwd }),')
  })
})

describe('daemon tmux launch', () => {
  it('moves the seed to an owner-only file instead of `-e` argv and removes it when tmux fails', async () => {
    const spawn = between(await source('./run.ts'), 'const spawnSessionUnchecked = async (', 'const spawnSession = async (')
    const stage = spawn.indexOf("const tmuxLaunchMcp = stageLaunchMcpServersSeedFile(tmuxEnv, join(configuration.happyHomeDir, 'tmp'));")
    expect(stage).toBeGreaterThan(-1)
    expect(stage).toBeLessThan(spawn.indexOf('tmux.spawnInTmux('))
    expect(spawn).toMatch(/\}, tmuxLaunchMcp\.environment, start =>/)
    expect(spawn).toMatch(/tmuxLaunchMcp\.cleanup\(\);\s*logger\.debug\(`\[DAEMON RUN\] Failed to spawn in tmux/)
  })
})

describe('session process start', () => {
  it('takes the seed in the CLI bootstrap before any command is dispatched', async () => {
    const text = await source('../index.ts')
    const capture = text.indexOf('captureLaunchMcpServersSeed(process.env)')
    expect(capture).toBeGreaterThan(-1)
    for (const later of ['const args = process.argv', 'loadBrowserTaskEnv(process.env)', 'captureStandaloneLaunchBootstrap(process.env', "import('./main')", 'handleAgentCommand(']) {
      expect(capture, later).toBeLessThan(text.lastIndexOf(later))
    }
  })

  it.each([
    ['../claude/runClaude.ts', 'export async function runClaude('],
    ['../codex/runCodex.ts', 'export async function runCodex('],
  ])('%s consumes it as its first statement, before any env copy, exec or spawn', async (path, start) => {
    const text = await source(path)
    const body = text.slice(text.indexOf(start))
    const firstStatement = body.slice(body.indexOf('): Promise<void> {') + '): Promise<void> {'.length).trimStart()
    expect(firstStatement.replace(/^(\/\/.*\n\s*)+/, '')).toMatch(/^const launchMcpServers = consumeLaunchMcpServersSeed\(process\.env\);/)
  })
})

describe('runners', () => {
  it('Claude reads the seed and puts the servers under the organization, internal and user servers', async () => {
    const text = await source('../claude/runClaude.ts')
    expect(text).toMatch(/launchMcpServersBeside\(launchMcpServers, \[\s*\.\.\.Object\.keys\(aplusMcpServers\),\s*\.\.\.readClaudeMcpServerNames\(\{ configDir: process\.env\.CLAUDE_CONFIG_DIR \|\| homedir\(\), cwd: workingDirectory \}\),/)
    expect(text).toMatch(/const baseMcpServers = \{\s*\.\.\.claudeLaunchMcpServers\(sessionLaunchMcpServers\),\s*'happy': happyServer\.mcpConfig,/)
    expect(text).toContain('mcpServers: mergeAplusMcpServers(baseMcpServers, aplusMcpServers),')
  })

  it('Codex reads the seed and puts the servers under the organization and internal servers', async () => {
    const text = await source('../codex/runCodex.ts')
    expect(text).toContain('launchMcpServersBeside(launchMcpServers, Object.keys(initialAplusMcpServers))')
    expect(text).toContain('if (Object.keys(sessionLaunchMcpServers).length > 0) client.setLaunchMcpServerNames(Object.keys(sessionLaunchMcpServers));')
    expect(text).toMatch(/const baseMcpServers = \{\s*\.\.\.codexLaunchMcpServers\(sessionLaunchMcpServers, \(servers\) => bridgeAplusMcpServers\(servers, bridgeOptions\)\),\s*\.\.\.internalMcpServers,/)
    expect(text).toContain('baseServers: baseMcpServers,')
  })
})

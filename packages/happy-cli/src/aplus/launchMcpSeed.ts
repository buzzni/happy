/**
 * How the `launchMcpServers` seed (launchMcpServers.ts) travels from the daemon to the session
 * process, kept free of heavy imports so the CLI bootstrap (`index.ts`) can take it before anything
 * starts a subprocess — the way `captureStandaloneLaunchBootstrap` takes its bootstrap.
 *
 * Normally the daemon puts the JSON in the child's environment. A tmux launch passes its whole
 * environment as `tmux new-window -e NAME=value` argv, so there the daemon writes the JSON to an
 * owner-only file instead and passes only the path (`stageLaunchMcpServersSeedFile`). The session
 * process reads either form once, deletes the variable and the file, and keeps the text in memory.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** One-shot seed, scrubbed from every child like the other `HAPPY_INITIAL_` seeds (childEnv.ts). */
export const LAUNCH_MCP_SERVERS_ENV = 'HAPPY_INITIAL_LAUNCH_MCP_SERVERS'
export const LAUNCH_MCP_SERVERS_FILE_ENV = 'HAPPY_INITIAL_LAUNCH_MCP_SERVERS_FILE'
const STAGING_DIRECTORY_PREFIX = 'happy-launch-mcp-'

let captured: string | undefined

function readSeed(env: NodeJS.ProcessEnv): string | undefined {
    const inline = env[LAUNCH_MCP_SERVERS_ENV]
    const file = env[LAUNCH_MCP_SERVERS_FILE_ENV]
    delete env[LAUNCH_MCP_SERVERS_ENV]
    delete env[LAUNCH_MCP_SERVERS_FILE_ENV]
    if (!file) return inline || undefined
    let staged: string | undefined
    try {
        staged = readFileSync(file, 'utf8')
    } catch {
        staged = undefined
    }
    try {
        rmSync(file, { force: true })
        const directory = dirname(file)
        if (basename(directory).startsWith(STAGING_DIRECTORY_PREFIX)) rmSync(directory, { recursive: true, force: true })
    } catch {
        // best-effort: the directory is owner-only
    }
    return staged || inline || undefined
}

/** CLI bootstrap: take the seed out of the environment (and off disk) before any subprocess starts. */
export function captureLaunchMcpServersSeed(env: NodeJS.ProcessEnv): void {
    const raw = readSeed(env)
    if (raw !== undefined) captured = raw
}

/** The runner's read: what the bootstrap captured, or the environment when there was no bootstrap. Once. */
export function takeLaunchMcpServersSeed(env: NodeJS.ProcessEnv): string | undefined {
    captureLaunchMcpServersSeed(env)
    const raw = captured
    captured = undefined
    return raw
}

/**
 * For a launch whose environment becomes argv (tmux): the same environment with the seed moved to
 * an owner-only file under `stagingRoot`. `cleanup` removes it when the launch did not happen; once
 * the session process starts it deletes the file itself.
 */
export function stageLaunchMcpServersSeedFile(
    env: Record<string, string>,
    stagingRoot: string,
): { environment: Record<string, string>; cleanup: () => void } {
    const seed = env[LAUNCH_MCP_SERVERS_ENV]
    if (!seed) return { environment: env, cleanup: () => {} }
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
    const directory = mkdtempSync(join(stagingRoot, STAGING_DIRECTORY_PREFIX))
    const file = join(directory, 'servers.json')
    writeFileSync(file, seed, { encoding: 'utf8', mode: 0o600 })
    const { [LAUNCH_MCP_SERVERS_ENV]: _inline, ...rest } = env
    return {
        environment: { ...rest, [LAUNCH_MCP_SERVERS_FILE_ENV]: file },
        cleanup: () => { rmSync(directory, { recursive: true, force: true }) },
    }
}

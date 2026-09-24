/**
 * Shared plumbing for the real-agent PoC runs (A01, A08): an isolated Happy
 * daemon spawns a real agent session, the harness plays the auth server
 * (grants/capabilities) and the user client (Desktop's own CLI session code in
 * a separate short-lived process), and reads independent evidence from the
 * fixture ledger and the Runtime journal.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { mintAgentGrant, mintInteractiveCapability } from '../auth'
import { AGENT_OPERATIONS, INTERACTIVE_OPERATIONS, type AgentSessionId, type GrantId } from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE } from './pocStack'

const execFileAsync = promisify(execFile)

export const now = () => Date.now()
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface TranscriptRow { seq: number; time: number; t: string; name?: string; text?: string }

export interface RunContext {
    run: string
    runDir: string
    env: { ports: { control: number; runtime: number }; harnessToken: string }
    keys: { agentKey: string; interactiveKey: string }
    runtimeUrl: string
}

export function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {}
    for (let index = 0; index < argv.length; index++) {
        if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1]
    }
    return args
}

export function loadRun(run: string): RunContext {
    const runDir = join(import.meta.dirname, '../../../scripts/browser-poc/.abp', run)
    const env = JSON.parse(readFileSync(join(runDir, 'env.json'), 'utf8'))
    const keys = JSON.parse(readFileSync(join(runDir, 'keys.json'), 'utf8'))
    return { run, runDir, env, keys, runtimeUrl: `http://127.0.0.1:${env.ports.runtime}` }
}

/** Evidence file that is rewritten after every step, so a harness failure never loses what happened. */
export function evidenceFile(path: string): { data: Record<string, unknown>; save(): void } {
    const data: Record<string, unknown> = {}
    const save = () => writeFileSync(path, JSON.stringify(data, null, 2))
    process.on('exit', save)
    return { data, save }
}

const happyHome = () => process.env.ABP_HAPPY_HOME ?? join(homedir(), '.happy-cli-isolated-abp/home')
const clientDir = () => process.env.ABP_SESSION_CLIENT_DIR ?? '/Users/justin/workspace/aplus-dev-studio-desktop/.aplus/worktrees/abp-desktop'

/** Spawn a real agent session through the isolated daemon and bind an agent grant to it. */
export async function spawnAgentSession(ctx: RunContext, label: string, extraEnv: Record<string, string> = {}): Promise<{ sessionId: string; grantId: GrantId }> {
    const daemon = JSON.parse(readFileSync(join(happyHome(), 'daemon.state.json'), 'utf8'))
    const workspace = join(homedir(), 'abp-poc-agent-ws', `${ctx.run}-${label}`)
    mkdirSync(workspace, { recursive: true })
    const grantDir = join(happyHome(), '..', 'grants')
    mkdirSync(grantDir, { recursive: true, mode: 0o700 })
    const grantFile = join(grantDir, `${ctx.run}-${label}.token`)
    const response = await fetch(`http://127.0.0.1:${daemon.httpPort}/spawn-session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.controlSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            directory: workspace,
            agent: 'claude',
            environmentVariables: { ...extraEnv, HAPPY_BROWSER_TASK_RUNTIME_URL: ctx.runtimeUrl, HAPPY_BROWSER_TASK_GRANT_FILE: grantFile },
        }),
    })
    const spawned = await response.json() as { success: boolean; sessionId: string }
    if (!spawned.success) throw new Error('spawn failed')
    const issuedAt = now()
    const grantId = `grant-${ctx.run}-${label}` as GrantId
    writeFileSync(grantFile, mintAgentGrant({
        kind: 'agent-grant', grantId, principalId: PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE,
        agentSessionId: spawned.sessionId as AgentSessionId, profileId: PROFILE_A, allowedOrigins: [SITE_A, SITE_B],
        operations: [...AGENT_OPERATIONS], taskSpaceIds: [], issuedAtMs: issuedAt, expiresAtMs: issuedAt + 55 * 60_000,
    }, ctx.keys, issuedAt), { mode: 0o600 })
    return { sessionId: spawned.sessionId, grantId }
}

/** The user's reconnecting client with an interactive capability (approve/takeover + read). */
export function userClient(ctx: RunContext, viewerSessionId: string): RuntimeClient {
    const issuedAt = now()
    const token = mintInteractiveCapability({
        kind: 'interactive', capabilityId: `cap-${ctx.run}-${viewerSessionId}-${issuedAt}`, principalId: PRINCIPAL_A,
        workspaceId: WORKSPACE, machineId: MACHINE, viewerSessionId, profileId: PROFILE_A,
        operations: [...INTERACTIVE_OPERATIONS, 'getTask', 'subscribe'], issuedAtMs: issuedAt, expiresAtMs: issuedAt + 10 * 60_000,
    }, ctx.keys, issuedAt)
    return new RuntimeClient({ baseUrl: ctx.runtimeUrl, token })
}

function clientEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of ['SAYCODE_AGENT_ENV', 'SAYCODE_AGENT_ROOT', 'HAPPY_HOME_DIR']) delete env[key]
    return env
}

/** Desktop's own CLI session code, run as a separate short-lived client process. */
export async function sessionClient(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('node_modules/.bin/vite-node',
        ['--config', 'vite.cli.config.ts', '.abp-harness/sessionClient.ts', ...args],
        { cwd: clientDir(), env: clientEnv(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    return stdout
}

export async function clientProcessCount(): Promise<number> {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'sessionClient.ts']).catch(() => ({ stdout: '' }))
    return stdout.trim() ? stdout.trim().split('\n').length : 0
}

export async function transcript(sessionId: string): Promise<TranscriptRow[]> {
    const raw = await sessionClient('read', sessionId, '200')
    const messages = JSON.parse(raw.trim().split('\n').at(-1)!.replace(/[\u0000-\u001f]/g, ' ')) as Array<{
        seq: number
        content: { content?: { time?: number; ev?: Record<string, unknown> } }
    }>
    return messages.flatMap((message) => {
        const ev = message.content.content?.ev
        if (!ev) return []
        return [{
            seq: message.seq,
            time: message.content.content?.time ?? 0,
            t: String(ev.t),
            name: ev.name as string | undefined,
            text: typeof ev.text === 'string' ? ev.text : undefined,
        }]
    })
}

export async function waitForTranscript(sessionId: string, predicate: (rows: TranscriptRow[]) => boolean, timeoutMs: number): Promise<TranscriptRow[]> {
    let rows: TranscriptRow[] = []
    for (const deadline = now() + timeoutMs; now() < deadline;) {
        rows = await transcript(sessionId)
        if (predicate(rows)) return rows
        await sleep(2_000)
    }
    return rows
}

export async function fixtureControl(ctx: RunContext, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${ctx.env.ports.control}${path}`, {
        method,
        headers: { 'x-harness-token': ctx.env.harnessToken, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return response.json() as Promise<Record<string, unknown>>
}

export async function ledger(ctx: RunContext): Promise<Array<Record<string, unknown>>> {
    return (await fixtureControl(ctx, 'GET', `/control/ledger?run=${encodeURIComponent(ctx.run)}`)).entries as Array<Record<string, unknown>>
}

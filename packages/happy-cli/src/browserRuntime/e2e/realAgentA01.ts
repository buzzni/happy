/**
 * A01 real-agent path (T09 walking skeleton / T28): a real Happy agent session,
 * spawned by an isolated Happy daemon running this branch, drives the browser
 * Runtime through the browser_task_* MCP tools. The prompting client exits
 * before the fixture barrier is released, so everything after the release is
 * the agent's own post-close judgement and tool calls.
 *
 * Usage (from packages/happy-cli, stack already up via stackCli.ts):
 *   tsx src/browserRuntime/e2e/realAgentA01.ts --run <stackRun> --iteration <n>
 * Env: ABP_HAPPY_HOME (isolated daemon home), ABP_SESSION_CLIENT_DIR (Desktop
 * worktree holding .abp-harness/sessionClient.ts).
 * Writes scripts/browser-poc/.abp/<run>/a01-real-<n>.json (no secrets).
 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { mintAgentGrant, mintInteractiveCapability } from '../auth'
import {
    AGENT_OPERATIONS, INTERACTIVE_OPERATIONS,
    type AgentSessionId, type GrantId, type TaskEvent, type TaskId,
} from '../contracts'
import { RuntimeClient } from '../runtimeClient'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE } from './pocStack'

const execFileAsync = promisify(execFile)
const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
}, []))
const run = args.run
const iteration = args.iteration ?? '1'
const pocDir = join(import.meta.dirname, '../../../scripts/browser-poc')
const runDir = join(pocDir, '.abp', run)
const happyHome = process.env.ABP_HAPPY_HOME ?? join(homedir(), '.happy-cli-isolated-abp/home')
const clientDir = process.env.ABP_SESSION_CLIENT_DIR ?? '/Users/justin/workspace/aplus-dev-studio-desktop/.aplus/worktrees/abp-desktop'
const BARRIER_KEY = `k${iteration}-${Date.now().toString(36)}`
const WAIT_STEP_LIMIT_MS = 120_000

const PROMPT_TEMPLATE = readFileSync(join(import.meta.dirname, 'realAgentA01.prompt.txt'), 'utf8')

interface Transcript { seq: number; time: number; t: string; name?: string; text?: string }

const now = () => Date.now()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function clientEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of ['SAYCODE_AGENT_ENV', 'SAYCODE_AGENT_ROOT', 'HAPPY_HOME_DIR']) delete env[key]
    return env
}

/** The prompting client: Desktop's own CLI session code, a separate short-lived process. */
async function sessionClient(...clientArgs: string[]): Promise<string> {
    const { stdout } = await execFileAsync('node_modules/.bin/vite-node',
        ['--config', 'vite.cli.config.ts', '.abp-harness/sessionClient.ts', ...clientArgs],
        { cwd: clientDir, env: clientEnv(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    return stdout
}

async function transcript(sessionId: string): Promise<Transcript[]> {
    const raw = await sessionClient('read', sessionId, '200')
    const messages = JSON.parse(raw.trim().split('\n').at(-1)!.replace(/[\u0000-\u001f]/g, ' ')) as Array<{ seq: number; content: { content?: { time?: number; ev?: Record<string, unknown> } } }>
    return messages.flatMap((message) => {
        const ev = message.content.content?.ev
        if (!ev) return []
        return [{ seq: message.seq, time: message.content.content?.time ?? 0, t: String(ev.t), name: ev.name as string | undefined, text: typeof ev.text === 'string' ? ev.text : undefined }]
    })
}

async function control(env: { ports: { control: number }; harnessToken: string }, method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${env.ports.control}${path}`, {
        method, headers: { 'x-harness-token': env.harnessToken, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return response.json() as Promise<Record<string, unknown>>
}

async function main(): Promise<void> {
    const env = JSON.parse(readFileSync(join(runDir, 'env.json'), 'utf8'))
    const keys = JSON.parse(readFileSync(join(runDir, 'keys.json'), 'utf8'))
    const daemon = JSON.parse(readFileSync(join(happyHome, 'daemon.state.json'), 'utf8'))
    const runtimeUrl = `http://127.0.0.1:${env.ports.runtime}`
    const workspace = join(homedir(), 'abp-poc-agent-ws', `${run}-a01-${iteration}`)
    mkdirSync(workspace, { recursive: true })
    const grantDir = join(happyHome, '..', 'grants')
    mkdirSync(grantDir, { recursive: true, mode: 0o700 })
    const grantFile = join(grantDir, `${run}-a01-${iteration}.token`)
    const evidence: Record<string, unknown> = { run, iteration, barrierKey: BARRIER_KEY }
    const out = join(runDir, `a01-real-${iteration}.json`)
    // Persist after every step so a harness failure never loses what already happened.
    const save = () => writeFileSync(out, JSON.stringify(evidence, null, 2))
    process.on('exit', save)

    // 1. Spawn the real agent session through the daemon (same path Desktop's spawn RPC reaches).
    const spawned = await (await fetch(`http://127.0.0.1:${daemon.httpPort}/spawn-session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.controlSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            directory: workspace, agent: 'claude',
            environmentVariables: { HAPPY_BROWSER_TASK_RUNTIME_URL: runtimeUrl, HAPPY_BROWSER_TASK_GRANT_FILE: grantFile },
        }),
    })).json() as { success: boolean; sessionId: string }
    if (!spawned.success) throw new Error('spawn failed')
    const sessionId = spawned.sessionId
    evidence.agentSessionId = sessionId
    save()

    // 2. Agent grant bound to that session (the auth-server role).
    const issuedAt = now()
    const grantId = `grant-${run}-a01-${iteration}` as GrantId
    writeFileSync(grantFile, mintAgentGrant({
        kind: 'agent-grant', grantId, principalId: PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE,
        agentSessionId: sessionId as AgentSessionId, profileId: PROFILE_A, allowedOrigins: [SITE_A, SITE_B],
        operations: [...AGENT_OPERATIONS], taskSpaceIds: [], issuedAtMs: issuedAt, expiresAtMs: issuedAt + 55 * 60_000,
    }, keys, issuedAt), { mode: 0o600 })

    // 3. The client sends the fixed prompt and exits.
    const prompt = PROMPT_TEMPLATE.replace('__RUN__', run).replace('__KEY__', BARRIER_KEY)
    evidence.promptTemplateSha256 = createHash('sha256').update(PROMPT_TEMPLATE).digest('hex')
    evidence.clientSendStartedAtMs = now()
    await sessionClient('send', sessionId, prompt)
    evidence.clientExitedAtMs = now()
    const { stdout: clients } = await execFileAsync('pgrep', ['-f', 'sessionClient.ts']).catch(() => ({ stdout: '' }))
    evidence.clientProcessesAfterExit = clients.trim() ? clients.trim().split('\n').length : 0
    save()

    // 4. Wait until the agent is blocked in its waitFor batch (tool call started, not ended).
    let waitingSince = 0
    for (const deadline = now() + 180_000; now() < deadline;) {
        const rows = await transcript(sessionId)
        const start = rows.find((row) => row.t === 'tool-call-start' && row.name?.endsWith('browser_task_submit_batch'))
        if (start) { waitingSince = start.time; break }
        await sleep(1_000)
    }
    if (!waitingSince) throw new Error('agent never submitted the waiting batch')
    evidence.agentWaitBatchStartedAtMs = waitingSince

    // 5. Only now, with no client process alive, release the barrier.
    const { stdout: clientsBeforeRelease } = await execFileAsync('pgrep', ['-f', 'sessionClient.ts']).catch(() => ({ stdout: '' }))
    evidence.clientProcessesAtRelease = clientsBeforeRelease.trim() ? clientsBeforeRelease.trim().split('\n').length : 0
    const nonce = `N${randomBytes(4).toString('hex')}`
    evidence.barrierReleasedAtMs = now()
    evidence.releaseWithinWaitLimit = now() - waitingSince < WAIT_STEP_LIMIT_MS
    await control(env, 'POST', '/control/barrier/release', { run, key: BARRIER_KEY, nonce })
    save()

    // 6. Let the agent finish its turn on its own.
    let rows: Transcript[] = []
    for (const deadline = now() + 600_000; now() < deadline;) {
        rows = await transcript(sessionId)
        if (rows.some((row) => row.t === 'turn-end' && row.time > (evidence.barrierReleasedAtMs as number))) break
        await sleep(3_000)
    }
    const released = evidence.barrierReleasedAtMs as number
    evidence.agentToolCallsAfterRelease = rows
        .filter((row) => row.t === 'tool-call-start' && row.time > released && row.name?.includes('browser_task_'))
        .map((row) => ({ name: row.name!.replace('mcp__happy__', ''), atMs: row.time }))
    evidence.finalAgentText = rows.filter((row) => row.t === 'text' && row.text).at(-1)?.text?.slice(0, 200)

    // 7. Independent evidence: fixture ledger and the Runtime's own task journal.
    const ledger = (await control(env, 'GET', `/control/ledger?run=${encodeURIComponent(run)}`)).entries as Array<Record<string, unknown>>
    const answers = ledger.filter((entry) => entry.kind === 'answer' && entry.key === BARRIER_KEY)
    evidence.ledgerAnswers = answers.map((entry) => ({ correct: entry.correct, atMs: entry.atMs }))
    const releaseEntry = ledger.find((entry) => entry.kind === 'barrier-release' && entry.key === BARRIER_KEY)
    evidence.ledgerBarrierReleaseAtMs = releaseEntry?.atMs

    const taskId = /taskId=(\S+)/.exec(String(evidence.finalAgentText ?? ''))?.[1]
    if (taskId) try {
        const capability = mintInteractiveCapability({
            kind: 'interactive', capabilityId: `cap-${run}-${iteration}`, principalId: PRINCIPAL_A, workspaceId: WORKSPACE,
            machineId: MACHINE, viewerSessionId: 'harness-reconnect', profileId: PROFILE_A,
            operations: [...INTERACTIVE_OPERATIONS, 'getTask', 'subscribe'], issuedAtMs: now(), expiresAtMs: now() + 10 * 60_000,
        }, keys, now())
        // Reconnect as the user: same task, same profile, full event history.
        const viewer = new RuntimeClient({ baseUrl: runtimeUrl, token: capability })
        const task = await viewer.getTask({ taskId: taskId as TaskId })
        const events = await viewer.subscribe({ taskId: taskId as TaskId, afterSeq: 0 })
        const list = events.kind === 'events' ? events.events : [] as TaskEvent[]
        evidence.task = { taskId, status: task.status, profileId: task.profileId, agentSessionId: task.agentSessionId, highWatermarkSeq: task.highWatermarkSeq }
        evidence.batchesAccepted = list.filter((event) => event.type === 'batch-accepted').map((event) => ({ seq: event.seq, atMs: event.atMs, afterRelease: event.atMs > released }))
        evidence.writeIntentsAfterRelease = list.filter((event) => event.type === 'action-intent' && event.atMs > released).length
    } catch (error) {
        evidence.reconnectError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }

    const batches = (evidence.batchesAccepted ?? []) as Array<{ afterRelease: boolean }>
    evidence.pass = evidence.clientProcessesAtRelease === 0
        && evidence.releaseWithinWaitLimit === true
        && answers.length === 1 && answers[0].correct === true
        && batches.some((batch) => batch.afterRelease)
        && (evidence.task as { status?: string } | undefined)?.status === 'succeeded'
        && (evidence.task as { agentSessionId?: string }).agentSessionId === sessionId
    save()
    console.log(JSON.stringify({ out, pass: evidence.pass }))
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
})

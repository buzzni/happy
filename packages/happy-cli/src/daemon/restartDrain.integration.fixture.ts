/**
 * A stand-in daemon for `restartDrain.integration.test.ts` (aplus specs/codexcli-daemon-restart-drain T11b).
 *
 * Runs the real control server, launch gate, restart drain runtime and outcome ledger in
 * its own process, against a temporary HAPPY_HOME_DIR, without a server account: sessions
 * are whatever reports `/session-runtime`, terminals and a replaced bundle are files the
 * test writes. Its hand-off starts the next generation of itself and exits — a daemon
 * restart with real processes, pids and identities.
 *
 * Files under HAPPY_HOME_DIR it reads: `bundle-replaced` (a generation number), `preflight-fails`, `terminals.json`
 * ({open,busy}). Files it writes: `daemon.state.json`, `probe-<gen>.port`, `daemons.pids`,
 * `terminals-closed.jsonl`, `restart-drain-outcomes.jsonl`, `fixture.log`.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { configuration } from '@/configuration'
import { writeDaemonState, type DaemonLocallyPersistedState } from '@/persistence'
import { startDaemonControlServer } from './controlServer'
import { readOwnDaemonIdentity } from './daemonIdentity'
import type { PortRegistry } from './portRegistry'
import { countInTurnSessions } from './restartDrain'
import { daemonRestartingRefusal } from './restartDrainLifecycle'
import type { RestartDrainControlPort } from './restartDrainRoutes'
import { createDaemonRestartDrainRuntime, type DaemonRestartDrainRuntime } from './restartDrainRuntime'
import { createLaunchReadinessGate } from './resumeGuards'

const home = configuration.happyHomeDir
const generation = Number(process.env.FAKE_DAEMON_GENERATION ?? '1')
const file = (name: string) => join(home, name)
const log = (message: string) => appendFileSync(file('fixture.log'), `[gen ${generation}] ${message}\n`)

function readTerminals(): { open: number; busy: number } {
    try {
        const parsed = JSON.parse(readFileSync(file('terminals.json'), 'utf8'))
        return { open: Number(parsed.open) || 0, busy: Number(parsed.busy) || 0 }
    } catch {
        return { open: 0, busy: 0 }
    }
}

function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
}

async function main() {
    appendFileSync(file('daemons.pids'), `${process.pid}\n`)
    const identity = await readOwnDaemonIdentity(file('bundle.mjs'))
    const gate = createLaunchReadinessGate()
    const sessions = new Map<string, { pid: number; knownSince: number; runtime?: { thinking: boolean; hasOpenToolCall: boolean; pendingUserInput?: boolean; updatedAt: number } }>()
    let runtime: DaemonRestartDrainRuntime | null = null
    let state: DaemonLocallyPersistedState

    const port: RestartDrainControlPort = {
        instanceId: `${identity.pid}:${identity.startedAt ?? 'unknown'}`,
        begin: (request) => runtime?.controlPort.begin(request) ?? { ok: false, code: 'not-ready' },
        status: (operationId) => runtime?.controlPort.status(operationId) ?? null,
        stopBlocked: () => runtime?.controlPort.stopBlocked() ?? false,
    }
    const spawnGate = () => {
        const deadline = gate.restartDeadline()
        return deadline !== null ? daemonRestartingRefusal('launch', deadline) : { type: 'success' as const, sessionId: `spawned-${Date.now()}` }
    }
    const portRegistry: PortRegistry = { allocate: async () => ({ port: 30000, reused: false }), release: async () => false, readAll: async () => ({}) }

    let shuttingDown = false
    const shutdown = async (why: string) => {
        if (shuttingDown) return
        shuttingDown = true
        log(`shutdown (${why})`)
        await runtime?.finalizeReady()
        runtime?.dispose()
        await server.stop()
        writeDaemonState({ ...state, state: 'stopped' })
        process.exit(0)
    }

    const server = await startDaemonControlServer({
        getChildren: () => [],
        stopSession: () => ({ stopped: false, reason: 'not-found' }),
        spawnSession: async () => spawnGate(),
        requestShutdown: () => { void shutdown('/stop') },
        onHappySessionWebhook: () => {},
        onHappySessionRuntime: (sessionId, report, reporter) => {
            const known = sessions.get(sessionId)
            sessions.set(sessionId, {
                pid: reporter?.hostPid ?? known?.pid ?? 0,
                knownSince: known?.knownSince ?? Date.now(),
                runtime: { thinking: report.thinking ?? false, hasOpenToolCall: report.hasOpenToolCall ?? false, pendingUserInput: report.pendingUserInput, updatedAt: report.updatedAt },
            })
        },
        portRegistry,
        restartDrain: port,
    })

    runtime = createDaemonRestartDrainRuntime({
        instanceId: port.instanceId,
        activity: () => {
            const now = Date.now()
            const terminals = readTerminals()
            const live = [...sessions.values()].filter((session) => isAlive(session.pid))
            return {
                inTurnCount: countInTurnSessions(live, { now, knownSince: (pid) => live.find((session) => session.pid === pid)?.knownSince }),
                automationCount: 0,
                busyTerminalCount: terminals.busy,
                openTerminalCount: terminals.open,
            }
        },
        closeAdmission: (deadlineAt) => gate.closeForRestart(deadlineAt),
        reopenAdmission: () => gate.reopenAfterRestartDrain(),
        closeTerminalsForRestart: async () => {
            const { open } = readTerminals()
            for (let i = 0; i < open; i++) appendFileSync(file('terminals-closed.jsonl'), `${JSON.stringify({ generation, reason: 'daemon-restart' })}\n`)
            writeFileSync(file('terminals.json'), JSON.stringify({ open: 0, busy: 0 }))
            return open
        },
        preflightReplacement: async () => !existsSync(file('preflight-fails')),
        handOff: async () => {
            log('hand-off: starting the next generation')
            await server.stop()
            writeDaemonState({ ...state, state: 'stopped' })
            const next = spawn(process.execPath, process.execArgv.concat(process.argv.slice(1)), {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, FAKE_DAEMON_GENERATION: String(generation + 1) },
            })
            next.unref()
            process.exit(0)
        },
        shutdown: () => { void shutdown('drain finished with nobody waiting') },
        publishLifecycle: () => writeFileSync(file(`lifecycle-${generation}.json`), JSON.stringify(runtime?.lifecycle() ?? null)),
        happyHomeDir: home,
        cliVersion: `fake-gen-${generation}`,
        log,
        tickIntervalMs: 100,
    })
    gate.markReady()

    state = {
        pid: process.pid,
        httpPort: server.port,
        startTime: new Date().toISOString(),
        startedWithCliVersion: `fake-gen-${generation}`,
        state: 'running',
        controlSecret: server.controlSecret,
        identity,
        trackedSessions: [],
    }
    writeDaemonState(state)

    const probe = createServer((request, response) => {
        void (async () => {
            const answer = (body: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body)) }
            if (request.url === '/spawn') return answer(spawnGate())
            if (request.url === '/lifecycle') return answer(runtime?.lifecycle() ?? null)
            if (request.url === '/sessions') return answer([...sessions.keys()])
            if (request.url === '/force-handoff') return answer(await runtime!.forceHandoff())
            response.statusCode = 404
            response.end()
        })()
    })
    probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (address && typeof address === 'object') writeFileSync(file(`probe-${generation}.port`), String(address.port))
    })

    // `bundle-replaced` holds the generation whose bundle was replaced; the next generation
    // is that new bundle, so it does not hand off again.
    const bundleReplaced = () => {
        try { return Number(readFileSync(file('bundle-replaced'), 'utf8').trim()) >= generation } catch { return false }
    }
    const heartbeat = setInterval(() => {
        void runtime?.heartbeat(bundleReplaced())
    }, Number(process.env.FAKE_DAEMON_HEARTBEAT_MS ?? '200'))
    heartbeat.unref()
    log(`ready on ${server.port}`)
    // Keep the process alive until shutdown or hand-off.
    setInterval(() => {}, 60_000)
}

main().catch((error) => {
    log(`fatal: ${(error as Error)?.stack ?? error}`)
    process.exit(1)
})

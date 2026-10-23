/**
 * Fake daemon restart (aplus specs/codexcli-daemon-restart-drain T11b, plan §7 scenarios (1)(2)(4)(7)(8)).
 *
 * Real processes throughout: the daemon is `restartDrain.integration.fixture.ts` in its own
 * process (real control server, launch gate, drain runtime, outcome ledger), sessions are
 * child processes reporting `/session-runtime` the way session CLIs do (re-reading
 * daemon.state.json each time, so they follow a replacement daemon), and the CLI side is the
 * real `stopDaemon`. Temporary HAPPY_HOME_DIR and port 0 only — never the machine's daemon.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const packageRoot = resolve(__dirname, '../..')
const fixture = resolve(__dirname, 'restartDrain.integration.fixture.ts')

const SESSION_SCRIPT = `
const fs = require('fs'); const path = require('path');
const [home, sessionId, controlFile] = process.argv.slice(2);
let seq = 0;
async function tick() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'daemon.state.json'), 'utf8'));
    const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    if (state.state !== 'running') return;
    await fetch('http://127.0.0.1:' + state.httpPort + '/session-runtime', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.controlSecret },
      body: JSON.stringify({ sessionId, reportSeq: ++seq, thinking: !!control.thinking, hasOpenToolCall: false, hostPid: process.pid }),
    });
  } catch {}
}
setInterval(tick, 150); tick();
`

async function waitFor<T>(read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 60_000, label = 'condition'): Promise<T> {
    const until = Date.now() + timeoutMs
    for (;;) {
        const value = await read()
        if (value) return value
        if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
        await new Promise((r) => setTimeout(r, 100))
    }
}

describe('fake daemon restart (integration-daemon-restart)', () => {
    let home: string
    const children: ChildProcess[] = []

    const file = (name: string) => join(home, name)
    const readJson = (name: string) => { try { return JSON.parse(readFileSync(file(name), 'utf8')) } catch { return undefined } }
    const state = () => readJson('daemon.state.json') as { pid: number; state: string; httpPort: number; controlSecret: string; startedWithCliVersion: string; identity?: { pid: number; startedAt?: number } } | undefined
    const ledger = () => existsSync(file('restart-drain-outcomes.jsonl'))
        ? readFileSync(file('restart-drain-outcomes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        : []
    const isAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

    function startDaemon(env: Record<string, string> = {}) {
        const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
            cwd: packageRoot,
            env: { ...process.env, HAPPY_HOME_DIR: home, FAKE_DAEMON_GENERATION: '1', ...env },
            stdio: 'ignore',
        })
        children.push(child)
        return waitFor(() => {
            const current = state()
            return current?.state === 'running' && current.startedWithCliVersion === 'fake-gen-1' && current
        }, 90_000, 'generation 1 daemon')
    }
    const waitForGeneration = (generation: number) => waitFor(() => {
        const current = state()
        return current?.state === 'running' && current.startedWithCliVersion === `fake-gen-${generation}` && current
    }, 90_000, `generation ${generation} daemon`)
    /** The fixture's test-only probe; undefined while its port is not (yet) answering. */
    async function probe(generation: number, path: string): Promise<any> {
        try {
            const port = readFileSync(file(`probe-${generation}.port`), 'utf8')
            return await (await fetch(`http://127.0.0.1:${port}${path}`)).json()
        } catch {
            return undefined
        }
    }
    function startSession(id: string, thinking: boolean) {
        const control = file(`session-${id}.json`)
        writeFileSync(control, JSON.stringify({ thinking }))
        const script = file('session.cjs')
        if (!existsSync(script)) writeFileSync(script, SESSION_SCRIPT)
        const child = spawn(process.execPath, [script, home, id, control], { stdio: 'ignore' })
        children.push(child)
        return {
            pid: child.pid!,
            setThinking: (value: boolean) => writeFileSync(control, JSON.stringify({ thinking: value })),
        }
    }
    async function controlPost(path: string, body: unknown) {
        const current = state()!
        const response = await fetch(`http://127.0.0.1:${current.httpPort}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${current.controlSecret}` },
            body: JSON.stringify(body),
        })
        return response.json() as Promise<any>
    }
    async function cli() {
        // `configuration` freezes HAPPY_HOME_DIR at import: import the CLI side fresh per home.
        vi.resetModules()
        vi.stubEnv('HAPPY_HOME_DIR', home)
        return import('./controlClient')
    }

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'daemon-restart-it-'))
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        const pids = existsSync(join(home, 'daemons.pids')) ? readFileSync(join(home, 'daemons.pids'), 'utf8').trim().split('\n').map(Number) : []
        for (const pid of [...pids, ...children.map((child) => child.pid ?? 0)]) {
            if (pid > 0) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
        }
        children.length = 0
        rmSync(home, { recursive: true, force: true })
    })

    it('(1) refuses new launches while draining and becomes ready when the turn ends', async () => {
        const daemon = await startDaemon()
        const a = startSession('a', true)
        await waitFor(async () => (await probe(1, '/sessions'))?.includes('a'), 30_000, 'session a report')

        const { stopDaemon } = await cli()
        const stopping = stopDaemon({ intent: 'restart', reason: 'user-restart', graceSeconds: 60 })
        await waitFor(async () => (await probe(1, '/spawn'))?.code === 'daemon-restarting', 30_000, 'admission closed')
        expect(await probe(1, '/spawn')).toMatchObject({ type: 'error', code: 'daemon-restarting', deadlineAt: expect.any(Number) })

        a.setThinking(false)
        await expect(stopping).resolves.toBe('stopped')
        await waitFor(() => !isAlive(daemon.pid), 15_000, 'daemon exit')
        expect(isAlive(a.pid)).toBe(true)
        expect(ledger()).toEqual([expect.objectContaining({ outcome: 'idle', reason: 'user-restart', intent: 'restart', trigger: 'request', inTurnCountAtStart: 1, sessionsAfter: 'kept' })])
    })

    it('(2) gives up at the grace without killing the turn; the session survives into the next daemon', async () => {
        const daemon = await startDaemon()
        const b = startSession('b', true)
        await waitFor(async () => (await probe(1, '/sessions'))?.includes('b'), 30_000, 'session b report')

        const { stopDaemon } = await cli()
        await expect(stopDaemon({ intent: 'restart', reason: 'user-restart', graceSeconds: 2 })).resolves.toBe('stopped')
        await waitFor(() => !isAlive(daemon.pid), 15_000, 'daemon exit')
        expect(isAlive(b.pid)).toBe(true)
        expect(ledger()).toEqual([expect.objectContaining({ outcome: 'deadline', inTurnCountAtDeadline: 1, sessionsAfter: 'kept', graceSeconds: 2 })])

        // The same session reports to the replacement daemon.
        rmSync(file('probe-1.port'), { force: true })
        await startDaemon()
        await waitFor(async () => (await probe(1, '/sessions'))?.includes('b'), 30_000, 'session b reporting to the new daemon')
    })

    it('(4a) a stop nobody renews is called off and admission reopens', async () => {
        await startDaemon()
        startSession('a', true)
        await waitFor(async () => (await probe(1, '/sessions'))?.includes('a'), 30_000, 'session a report')
        const instanceId = (await controlPost('/restart-drain/capabilities', {})).instanceId
        const begun = await controlPost('/restart-drain/begin', { requestId: 'r-4a', expectedInstanceId: instanceId, reason: 'account-switch', intent: 'stop', leaseSeconds: 2 })
        expect(begun).toMatchObject({ state: 'draining', intent: 'stop' })
        expect((await probe(1, '/spawn')).code).toBe('daemon-restarting')
        await waitFor(async () => (await probe(1, '/spawn'))?.type === 'success', 15_000, 'admission reopened')
        expect(ledger()).toEqual([expect.objectContaining({ outcome: 'cancelled', reason: 'account-switch', intent: 'stop' })])
    })

    it('(4b) a restart whose caller vanished finishes by itself into a new daemon identity', async () => {
        const first = await startDaemon()
        const a = startSession('a', true)
        await waitFor(async () => (await probe(1, '/sessions'))?.includes('a'), 30_000, 'session a report')
        const instanceId = (await controlPost('/restart-drain/capabilities', {})).instanceId
        await controlPost('/restart-drain/begin', { requestId: 'r-4b', expectedInstanceId: instanceId, reason: 'user-restart', intent: 'restart', leaseSeconds: 2, graceSeconds: 60 })
        await new Promise((r) => setTimeout(r, 2_500))
        a.setThinking(false)
        const second = await waitForGeneration(2)
        expect(second.pid).not.toBe(first.pid)
        expect(second.identity?.pid).toBe(second.pid)
        expect(isAlive(a.pid)).toBe(true)
        expect(ledger()).toEqual([expect.objectContaining({ outcome: 'idle', intent: 'restart', trigger: 'request' })])
    })

    it('(7a) bundle replaced with a long-lived idle session: hands off without refusing anything', async () => {
        const first = await startDaemon()
        const idle = startSession('idle', false)
        await waitFor(async () => (await probe(1, '/sessions'))?.includes('idle'), 30_000, 'idle session report')
        writeFileSync(file('bundle-replaced'), '1')
        const second = await waitForGeneration(2)
        expect(second.pid).not.toBe(first.pid)
        expect(isAlive(idle.pid)).toBe(true)
        expect(ledger()).toEqual([expect.objectContaining({ trigger: 'handoff-prewait', outcome: 'idle', reason: 'bundle-replaced' })])
    })

    it('(7b) a turn that keeps running: pre-wait keeps admission open, the cap drains and refuses, then hands off', async () => {
        await startDaemon({ HAPPY_DAEMON_HANDOFF_PREWAIT_CAP_MS: '3000', HAPPY_DAEMON_RESTART_DRAIN_GRACE_SECONDS: '60' })
        const a = startSession('a', true)
        await waitFor(async () => (await probe(1, '/sessions'))?.includes('a'), 30_000, 'session a report')
        writeFileSync(file('bundle-replaced'), '1')
        await waitFor(async () => (await probe(1, '/lifecycle'))?.pendingHandoff, 15_000, 'pending handoff')
        expect(await probe(1, '/spawn')).toMatchObject({ type: 'success' })
        await waitFor(async () => (await probe(1, '/lifecycle'))?.state === 'draining', 30_000, 'cap drain')
        expect(await probe(1, '/spawn')).toMatchObject({ code: 'daemon-restarting' })
        a.setThinking(false)
        await waitForGeneration(2)
        expect(ledger()).toEqual([expect.objectContaining({ trigger: 'handoff-cap', outcome: 'idle' })])
    })

    it('(8) a terminal in use: no cap drain, then "지금 교대" at the terminal cap closes it with a reason', async () => {
        writeFileSync(join(home, 'terminals.json'), JSON.stringify({ open: 1, busy: 1 }))
        await startDaemon({ HAPPY_DAEMON_HANDOFF_PREWAIT_CAP_MS: '500', HAPPY_DAEMON_HANDOFF_TERMINAL_CAP_MS: '3000', HAPPY_DAEMON_RESTART_DRAIN_GRACE_SECONDS: '60' })
        writeFileSync(file('bundle-replaced'), '1')
        await waitFor(async () => (await probe(1, '/lifecycle'))?.pendingHandoff, 15_000, 'pending handoff')
        await new Promise((r) => setTimeout(r, 1_000))
        expect(await probe(1, '/lifecycle')).toMatchObject({ state: 'running', pendingHandoff: { busyTerminalCount: 1, forceAvailable: false } })
        expect(await probe(1, '/spawn')).toMatchObject({ type: 'success' })
        await waitFor(async () => (await probe(1, '/lifecycle'))?.pendingHandoff?.forceAvailable, 30_000, 'forceAvailable')
        await waitFor(async () => (await probe(1, '/lifecycle'))?.state === 'draining', 30_000, 'terminal-cap drain')
        expect(await probe(1, '/force-handoff')).toMatchObject({ ok: true })
        await waitForGeneration(2)
        expect(readFileSync(file('terminals-closed.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ generation: 1, reason: 'daemon-restart' }])
        expect(ledger()).toEqual([expect.objectContaining({ trigger: 'handoff-terminal-cap', outcome: 'force', busyTerminalCountAtDeadline: 1, closedTerminalCount: 1 })])
    })
})

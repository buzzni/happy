/**
 * Spawns a PTY-backed interactive shell on behalf of the web-ui remote
 * terminal panel. Mirrors startServer.ts's pure-utility shape — no logger,
 * no globals — so callers (apiMachine.ts terminal-* RPC, future
 * controlServer endpoints) can wire it into their own envelope shapes.
 *
 * Unlike startServer.ts the child stays alive under daemon supervision —
 * we hold the IPty handle so write/resize/kill can hit it. node-pty creates
 * the child as the leader of a fresh process group via setsid, so
 * `process.kill(-pid, signal)` reaches grandchildren too (e.g. the browser
 * launcher that `gh auth login` spawns). See specs/remote-terminal/.
 */

import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

export interface TerminateOpts {
    /** ms to wait for a graceful SIGHUP exit before escalating to SIGKILL. */
    graceMs?: number
    /** ms to wait for the process to disappear after SIGKILL. */
    killGraceMs?: number
}

/** Default graceful window. Long enough for a shell to run its EXIT traps. */
const DEFAULT_GRACE_MS = 2000
const DEFAULT_KILL_GRACE_MS = 1000
const LIVENESS_POLL_MS = 25

export interface PtySessionOpts {
    userId: string
    shell?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
}

export interface PtySession {
    readonly id: string
    readonly userId: string
    readonly pid: number
    readonly cols: number
    readonly rows: number
    write(data: string): void
    resize(cols: number, rows: number): void
    /**
     * Raw signal delivery to the child's process group. Prefer `terminate()`
     * for close paths — a bare signal is never a termination guarantee.
     */
    kill(signal?: NodeJS.Signals): void
    /** True while the child process still exists (has not been reaped). */
    isAlive(): boolean
    /**
     * Guaranteed teardown: SIGHUP, then SIGKILL if the process is still there
     * after `graceMs`. Never rejects, and is safe to call twice.
     *
     * Why this exists and why callers must not hand-roll it: closing a remote
     * terminal used to send a bare SIGTERM, which an interactive shell ignores
     * outright (bash(1): "When Bash is interactive, in the absence of any
     * traps, it ignores SIGTERM"), so every closed terminal leaked a live
     * `/bin/bash -l` plus its pty descriptors. See
     * specs/remote-terminal-close-leak/.
     *
     * The escalation timer closes over `pid`/`child` rather than reading any
     * registry, so dropping the session from a bookkeeping map cannot cancel
     * the guarantee — which is exactly how the original leak became permanent.
     */
    terminate(opts?: TerminateOpts): Promise<void>
    onData(cb: (chunk: string) => void): () => void
    onExit(cb: (code: number, signal: number | null) => void): () => void
}

const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'

export function createPtySession(opts: PtySessionOpts): PtySession {
    const id = randomUUID()
    const shell = opts.shell || process.env.SHELL || DEFAULT_SHELL
    const args = opts.args ?? ['-l']
    const cwd = opts.cwd || homedir()
    const env: { [key: string]: string } = { ...process.env, ...(opts.env ?? {}) } as { [key: string]: string }
    const initialCols = opts.cols ?? 80
    const initialRows = opts.rows ?? 24

    const child = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: initialCols,
        rows: initialRows,
        cwd,
        env,
    })

    const pid = child.pid
    let cols = initialCols
    let rows = initialRows
    // node-pty only reports an exit once it has reaped the child, so this flag
    // being true means the process is definitively gone.
    let reaped = false
    child.onExit(() => { reaped = true })

    const signalGroup = (signal: NodeJS.Signals) => {
        // Process-group kill so backgrounded jobs (browser launcher
        // from `gh auth login`, npm subshells, etc.) are reaped along
        // with the shell. Falls back to single-process kill if the PG
        // is already gone (e.g. natural exit followed by explicit kill).
        try {
            process.kill(-pid, signal)
        } catch {
            try { child.kill(signal) } catch {/* already dead */ }
        }
    }

    const isAlive = () => {
        if (reaped) return false
        try {
            process.kill(pid, 0)
            return true
        } catch {
            return false
        }
    }

    /** Poll until the process is gone or the window expires. */
    const waitGone = async (ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
            if (!isAlive()) return true
            await sleep(LIVENESS_POLL_MS)
        }
        return !isAlive()
    }

    return {
        id,
        userId: opts.userId,
        pid,
        get cols() { return cols },
        get rows() { return rows },
        write(data: string) {
            child.write(data)
        },
        resize(c: number, r: number) {
            cols = c
            rows = r
            child.resize(c, r)
        },
        // SIGHUP, not SIGTERM: this session is a *terminal*, and interactive
        // shells ignore SIGTERM by design. A SIGTERM default here silently
        // did nothing for years — see terminate()'s note.
        kill(signal: NodeJS.Signals = 'SIGHUP') {
            signalGroup(signal)
        },
        isAlive,
        async terminate(terminateOpts?: TerminateOpts) {
            if (!isAlive()) return
            signalGroup('SIGHUP')
            if (await waitGone(terminateOpts?.graceMs ?? DEFAULT_GRACE_MS)) return
            // Still there: something trapped or ignored SIGHUP. SIGKILL cannot
            // be trapped, so this is the point where termination stops being a
            // request and becomes a guarantee.
            signalGroup('SIGKILL')
            await waitGone(terminateOpts?.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
        },
        onData(cb) {
            const sub = child.onData(cb)
            return () => sub.dispose()
        },
        onExit(cb) {
            const sub = child.onExit(({ exitCode, signal }) => {
                cb(exitCode, signal ?? null)
            })
            return () => sub.dispose()
        },
    }
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import {
    addDaemonTerminalSession,
    getDaemonTerminalSession,
    getDaemonTerminalSessionCount,
    removeDaemonTerminalSession,
    markDaemonTerminalSessionExited,
    recordTerminalActivity,
    EXITED_TERMINAL_RETAIN_MS,
    killAllDaemonTerminalSessions,
    terminateAllDaemonTerminalSessions,
    recordBytesIn,
    recordBytesOut,
    getBusyDaemonTerminalCount,
    closeAllDaemonTerminalSessionsForRestart,
    BUSY_TERMINAL_INPUT_WINDOW_MS,
    _resetDaemonTerminalSessionsForTest,
} from './daemonTerminalSessions'
import { createPtySession, type PtySession } from './remoteTerminal'

describe('daemonTerminalSessions', () => {
    const tracked: PtySession[] = []

    beforeEach(() => {
        _resetDaemonTerminalSessionsForTest()
    })
    afterEach(() => {
        while (tracked.length) {
            try { tracked.pop()?.kill('SIGKILL') } catch {/* gone */ }
        }
    })

    function spawn(): PtySession {
        const s = createPtySession({
            userId: 'u1',
            shell: 'node',
            args: ['-e', 'setInterval(() => {}, 1000)'],
        })
        tracked.push(s)
        return s
    }

    it('add() returns an entry with userId, machineId, openedAt, zero counters', () => {
        const before = Date.now()
        const pty = spawn()
        const entry = addDaemonTerminalSession('abc', pty, {
            userId: 'alice',
            machineId: 'm1',
            idleTimeoutMs: 0,
        })
        expect(entry.id).toBe('abc')
        expect(entry.userId).toBe('alice')
        expect(entry.machineId).toBe('m1')
        expect(entry.session).toBe(pty)
        expect(entry.bytesIn).toBe(0)
        expect(entry.bytesOut).toBe(0)
        expect(entry.openedAt).toBeGreaterThanOrEqual(before)
    })

    it('get() round-trips by id and returns null for missing', () => {
        const pty = spawn()
        addDaemonTerminalSession('abc', pty, { userId: 'u', idleTimeoutMs: 0 })
        expect(getDaemonTerminalSession('abc')?.session.id).toBe(pty.id)
        expect(getDaemonTerminalSession('nope')).toBeNull()
        expect(getDaemonTerminalSession(undefined)).toBeNull()
        expect(getDaemonTerminalSession('')).toBeNull()
    })

    it('reports the active terminal count for daemon activity checks', () => {
        const pty = spawn()
        expect(getDaemonTerminalSessionCount()).toBe(0)
        addDaemonTerminalSession('abc', pty, { userId: 'u', idleTimeoutMs: 0 })
        expect(getDaemonTerminalSessionCount()).toBe(1)
        removeDaemonTerminalSession('abc')
        expect(getDaemonTerminalSessionCount()).toBe(0)
    })

    it('remove() reports whether the entry existed and clears it', () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 0 })
        expect(removeDaemonTerminalSession('a')).toBe(true)
        expect(removeDaemonTerminalSession('a')).toBe(false)
        expect(getDaemonTerminalSession('a')).toBeNull()
    })

    it('recordBytesIn/Out accumulate counters and update lastActivityAt', () => {
        const pty = spawn()
        const entry = addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 0 })
        const initialActivity = entry.lastActivityAt
        // Force a measurable wallclock gap before activity (Date.now resolves
        // to ms; sleep 5ms is enough on every platform we care about).
        return sleep(5).then(() => {
            recordBytesIn('a', 10)
            recordBytesIn('a', 5)
            recordBytesOut('a', 8)
            expect(entry.bytesIn).toBe(15)
            expect(entry.bytesOut).toBe(8)
            expect(entry.lastActivityAt).toBeGreaterThan(initialActivity)
        })
    })

    it('record* on missing or non-positive ignored', () => {
        const pty = spawn()
        const entry = addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 0 })
        recordBytesIn('nope', 100)
        recordBytesIn('a', 0)
        recordBytesIn('a', -3)
        recordBytesOut('a', 0)
        expect(entry.bytesIn).toBe(0)
        expect(entry.bytesOut).toBe(0)
    })

    it('idle timeout sends SIGHUP to the PTY after the configured ms', async () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 200 })
        const exited = new Promise<{ code: number; signal: number | null }>((res) => {
            pty.onExit((code, signal) => res({ code, signal }))
        })
        const exitInfo = await Promise.race([
            exited,
            sleep(2000).then(() => { throw new Error('PTY did not exit on idle within 2s') }),
        ])
        // SIGHUP terminates the process; code is non-zero or signal set —
        // exact value is platform-specific, just confirm something happened.
        expect(exitInfo).toBeDefined()
    })

    it('activity resets the idle timer (no kill while bytes flow)', async () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 200 })
        let exited = false
        pty.onExit(() => { exited = true })

        // Tickle activity every 100ms for 600ms — well past the 200ms idle.
        // PTY must NOT have been killed.
        const stopAt = Date.now() + 600
        while (Date.now() < stopAt) {
            recordBytesIn('a', 1)
            await sleep(100)
        }
        expect(exited).toBe(false)

        // Now stop tickling; should die after ~200ms.
        await sleep(400)
        expect(exited).toBe(true)
    })

    it('removeDaemonTerminalSession cancels the idle timer', async () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 150 })
        let exited = false
        pty.onExit(() => { exited = true })

        // Remove from map immediately; idle timer should be cancelled and
        // the PTY should NOT be killed by it.
        expect(removeDaemonTerminalSession('a')).toBe(true)

        await sleep(400) // 2.5x the idle window
        expect(exited).toBe(false)
    })

    // specs/codexcli-daemon-stream-durability B2a — the relay socket dropping
    // ends relay terminals only; a direct terminal rides its own WebSocket.
    it('killAll limited to a route leaves the other route\'s terminals running', async () => {
        const relay = spawn()
        const direct = spawn()
        addDaemonTerminalSession('relay-1', relay, { userId: 'u', idleTimeoutMs: 0 })
        addDaemonTerminalSession('direct-1', direct, { userId: 'u', idleTimeoutMs: 0, route: 'direct' })

        expect(killAllDaemonTerminalSessions('relay')).toBe(1)
        expect(getDaemonTerminalSession('relay-1')).toBeNull()
        expect(getDaemonTerminalSession('direct-1')?.route).toBe('direct')
        expect(direct.isAlive()).toBe(true)
        await direct.terminate()
    })

    it('killAll signals every session, clears timers, and empties the map', async () => {
        const a = spawn()
        const b = spawn()
        addDaemonTerminalSession('a', a, { userId: 'u', idleTimeoutMs: 0 })
        addDaemonTerminalSession('b', b, { userId: 'u', idleTimeoutMs: 0 })

        const exitsP = Promise.all([
            new Promise<void>((res) => a.onExit(() => res())),
            new Promise<void>((res) => b.onExit(() => res())),
        ])

        const killed = killAllDaemonTerminalSessions()
        expect(killed).toBe(2)
        expect(getDaemonTerminalSession('a')).toBeNull()
        expect(getDaemonTerminalSession('b')).toBeNull()

        await Promise.race([
            exitsP,
            sleep(3000).then(() => { throw new Error('PTYs did not exit within 3s of killAll') }),
        ])
    })

    /**
     * specs/remote-terminal-close-leak/ — the `node -e` fixture above dies on
     * any signal, so it can never catch the bug that actually shipped: an
     * interactive shell ignores SIGTERM and every teardown path here used to
     * send exactly that. These cases use a real `/bin/bash -l`.
     */
    describe.skipIf(process.platform === 'win32')('interactive shell teardown', () => {
        const shells: PtySession[] = []

        afterEach(() => {
            while (shells.length) {
                try { shells.pop()?.kill('SIGKILL') } catch {/* gone */ }
            }
        })

        function spawnLoginShell(): PtySession {
            const s = createPtySession({ userId: 'u1', shell: '/bin/bash', args: ['-l'] })
            shells.push(s)
            return s
        }

        async function waitUntilDead(s: PtySession, ms: number): Promise<void> {
            const end = Date.now() + ms
            while (Date.now() < end && s.isAlive()) await sleep(25)
        }

        it('killAll actually reaps interactive login shells', async () => {
            const a = spawnLoginShell()
            const b = spawnLoginShell()
            addDaemonTerminalSession('a', a, { userId: 'u', idleTimeoutMs: 0 })
            addDaemonTerminalSession('b', b, { userId: 'u', idleTimeoutMs: 0 })
            await sleep(300) // let bash install its signal dispositions

            expect(killAllDaemonTerminalSessions()).toBe(2)

            await waitUntilDead(a, 1800)
            await waitUntilDead(b, 1800)
            expect(a.isAlive()).toBe(false)
            expect(b.isAlive()).toBe(false)
        })

        it('idle timeout actually reaps an interactive login shell', async () => {
            const s = spawnLoginShell()
            addDaemonTerminalSession('a', s, { userId: 'u', idleTimeoutMs: 300 })
            await sleep(300)

            await waitUntilDead(s, 2500)
            expect(s.isAlive()).toBe(false)
        })
    })

    // Desktop specs/windows-build-support W0-5h: an app-close drain must know every terminal is gone.
    it('terminates every session and reports each outcome, leaving the registry empty', async () => {
        const outcomes = ['killed', 'escaped'] as const
        let n = 0
        const fake = (): PtySession => {
            const outcome = outcomes[n++]
            return { id: `t${n}`, userId: 'u1', pid: 1, cols: 80, rows: 24, write() {}, resize() {}, kill() {}, isAlive: () => true,
                terminate: async () => outcome, onData: () => () => {}, onExit: () => () => {} }
        }
        addDaemonTerminalSession('t1', fake(), { userId: 'u1' })
        addDaemonTerminalSession('t2', fake(), { userId: 'u1' })

        await expect(terminateAllDaemonTerminalSessions()).resolves.toEqual(['killed', 'escaped'])
        expect(getDaemonTerminalSessionCount()).toBe(0)
    })
    /*
     * Codex CLI benchmark D4 B-R2 — a terminal that ends while its client is
     * away is kept long enough for that client to come back and learn it ended.
     */
    describe('exited terminal retention', () => {
        const fake = (): PtySession & { terminate: ReturnType<typeof vi.fn> } => ({
            id: 'f', userId: 'u1', pid: 1, cols: 80, rows: 24, write() {}, resize() {}, kill() {}, isAlive: () => false,
            terminate: vi.fn(async () => 'already-gone' as const), onData: () => () => {}, onExit: () => () => {},
        }) as any

        afterEach(() => {
            vi.useRealTimers()
        })

        it('keeps the entry and its exit for the retain window, then drops it', () => {
            vi.useFakeTimers()
            addDaemonTerminalSession('a', fake(), { userId: 'u', idleTimeoutMs: 0 })

            expect(markDaemonTerminalSessionExited('a', { code: 2, signal: null })).toBe(true)
            expect(EXITED_TERMINAL_RETAIN_MS).toBe(30_000)
            vi.advanceTimersByTime(29_999)
            expect(getDaemonTerminalSession('a')?.exit).toEqual({ code: 2, signal: null })

            vi.advanceTimersByTime(1)
            expect(getDaemonTerminalSession('a')).toBeNull()
        })

        it('no longer counts an ended terminal as daemon activity', () => {
            addDaemonTerminalSession('a', fake(), { userId: 'u', idleTimeoutMs: 0 })
            markDaemonTerminalSessionExited('a', { code: 0, signal: null })

            expect(getDaemonTerminalSessionCount()).toBe(0)
        })

        it('does not re-arm the idle watchdog for an ended terminal', () => {
            vi.useFakeTimers()
            const pty = fake()
            addDaemonTerminalSession('a', pty, { userId: 'u', idleTimeoutMs: 1000 })
            markDaemonTerminalSessionExited('a', { code: 0, signal: null })

            recordTerminalActivity('a')
            recordBytesIn('a', 5)
            vi.advanceTimersByTime(2000)

            expect(pty.terminate).not.toHaveBeenCalled()
        })

        it('an explicit remove cancels the retain timer', () => {
            vi.useFakeTimers()
            addDaemonTerminalSession('a', fake(), { userId: 'u', idleTimeoutMs: 0 })
            markDaemonTerminalSessionExited('a', { code: 0, signal: null })
            removeDaemonTerminalSession('a')
            const again = addDaemonTerminalSession('a', fake(), { userId: 'u', idleTimeoutMs: 0 })

            vi.advanceTimersByTime(30_000)

            expect(getDaemonTerminalSession('a')).toBe(again)
        })

        it('reports false for an unknown session', () => {
            expect(markDaemonTerminalSessionExited('nope', { code: 0, signal: null })).toBe(false)
        })
    })

    describe('restart drain terminal use (aplus codexcli-daemon-restart-drain R23)', () => {
        it('counts a terminal as busy only after input, and only for 10 minutes', () => {
            addDaemonTerminalSession('t1', spawn(), { userId: 'u', idleTimeoutMs: 0 })
            addDaemonTerminalSession('t2', spawn(), { userId: 'u', idleTimeoutMs: 0 })
            recordBytesOut('t2', 100)
            expect(getBusyDaemonTerminalCount()).toBe(0)
            recordBytesIn('t1', 3)
            const typedAt = getDaemonTerminalSession('t1')!.lastInputAt!
            expect(getBusyDaemonTerminalCount(typedAt + 1_000)).toBe(1)
            expect(getBusyDaemonTerminalCount(typedAt + BUSY_TERMINAL_INPUT_WINDOW_MS)).toBe(0)
        })

        it('output alone never makes a terminal busy', () => {
            addDaemonTerminalSession('tail', spawn(), { userId: 'u', idleTimeoutMs: 0 })
            recordBytesOut('tail', 10)
            expect(getDaemonTerminalSession('tail')!.lastInputAt).toBeNull()
        })

        it('closes all for a restart, tagging the reason and awaiting teardown', async () => {
            const entry = addDaemonTerminalSession('t1', spawn(), { userId: 'u', idleTimeoutMs: 0 })
            addDaemonTerminalSession('t2', spawn(), { userId: 'u', idleTimeoutMs: 0 })
            await expect(closeAllDaemonTerminalSessionsForRestart()).resolves.toBe(2)
            expect(entry.closeReason).toBe('daemon-restart')
            expect(getDaemonTerminalSessionCount()).toBe(0)
        })

        /*
         * D4 B-R2 × R23: an ended terminal kept for resume is nobody's open
         * terminal — it must not hold a restart drain, and a restart close has
         * nothing left to tear down for it.
         */
        it('an ended terminal kept for resume is neither busy nor closed again for a restart', async () => {
            const ended = spawn()
            const live = addDaemonTerminalSession('live', spawn(), { userId: 'u', idleTimeoutMs: 0 })
            addDaemonTerminalSession('ended', ended, { userId: 'u', idleTimeoutMs: 0 })
            recordBytesIn('ended', 3)
            markDaemonTerminalSessionExited('ended', { code: 0, signal: null })
            const terminate = vi.spyOn(ended, 'terminate')

            expect(getBusyDaemonTerminalCount()).toBe(0)
            await expect(closeAllDaemonTerminalSessionsForRestart()).resolves.toBe(1)
            expect(terminate).not.toHaveBeenCalled()
            expect(live.closeReason).toBe('daemon-restart')
            expect(getDaemonTerminalSession('ended')).toBeNull()
        })
    })
})

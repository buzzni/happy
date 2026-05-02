import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import {
    addDaemonTerminalSession,
    getDaemonTerminalSession,
    removeDaemonTerminalSession,
    killAllDaemonTerminalSessions,
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

    it('round-trips a session by id', () => {
        const pty = spawn()
        addDaemonTerminalSession('abc', pty)
        const got = getDaemonTerminalSession('abc')
        expect(got).not.toBeNull()
        expect(got!.id).toBe(pty.id)
    })

    it('returns null for missing or empty id', () => {
        expect(getDaemonTerminalSession('nope')).toBeNull()
        expect(getDaemonTerminalSession(undefined)).toBeNull()
        expect(getDaemonTerminalSession(null)).toBeNull()
        expect(getDaemonTerminalSession('')).toBeNull()
    })

    it('remove returns whether the entry existed', () => {
        const pty = spawn()
        addDaemonTerminalSession('a', pty)
        expect(removeDaemonTerminalSession('a')).toBe(true)
        expect(removeDaemonTerminalSession('a')).toBe(false)
        expect(getDaemonTerminalSession('a')).toBeNull()
    })

    it('killAll signals every session and clears the map', async () => {
        const a = spawn()
        const b = spawn()
        addDaemonTerminalSession('a', a)
        addDaemonTerminalSession('b', b)

        const exitsP = Promise.all([
            new Promise<void>((res) => a.onExit(() => res())),
            new Promise<void>((res) => b.onExit(() => res())),
        ])

        const killed = killAllDaemonTerminalSessions('SIGTERM')
        expect(killed).toBe(2)
        expect(getDaemonTerminalSession('a')).toBeNull()
        expect(getDaemonTerminalSession('b')).toBeNull()

        // Bound the wait so a stuck signal surfaces as a clear failure.
        await Promise.race([
            exitsP,
            sleep(3000).then(() => { throw new Error('PTYs did not exit within 3s of killAll') }),
        ])
    })
})

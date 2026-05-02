/**
 * Per-daemon registry of active PTY-backed terminal sessions
 * (specs/remote-terminal/ Phase 2). Holds the mapping between server-
 * issued sessionId and the local PtySession handle so subsequent
 * terminal-frame-fwd / terminal-resize-fwd / terminal-close-fwd events
 * route to the right child.
 *
 * Pure data-structure module — no socket.io / api coupling. apiMachine.ts
 * uses these helpers to plumb socket events into PtySession actions.
 */

import { type PtySession } from './remoteTerminal'

const sessions = new Map<string, PtySession>()

export function addDaemonTerminalSession(id: string, session: PtySession): void {
    sessions.set(id, session)
}

export function getDaemonTerminalSession(id: string | undefined | null): PtySession | null {
    if (!id) return null
    return sessions.get(id) ?? null
}

export function removeDaemonTerminalSession(id: string): boolean {
    return sessions.delete(id)
}

export function killAllDaemonTerminalSessions(signal: NodeJS.Signals = 'SIGTERM'): number {
    let killed = 0
    for (const [id, session] of sessions) {
        try {
            session.kill(signal)
            killed++
        } catch {
            /* already dead */
        }
        sessions.delete(id)
    }
    return killed
}

export function _resetDaemonTerminalSessionsForTest(): void {
    sessions.clear()
}

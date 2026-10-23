/**
 * Answers one `terminal-resume` (Codex CLI benchmark D4 B-R1/B-R2), so every
 * transport that carries a resume answers it by the same rules.
 *
 * Today the relay path (apiMachine.ts `terminal-resume-fwd`) calls this; the
 * same-machine direct path (controlServerTerminalWs.ts) joins in B2.1. Paged
 * replay (B-R3) extends this same function — a page that leaves more to come
 * holds the exit back (see `terminal-closed` below).
 *
 * No socket here: the caller seals and emits, so this module is shared by a
 * socket.io and a raw WebSocket transport alike.
 */

import type { TerminalExit } from './daemonTerminalSessions'
import type { TerminalOutputBuffer, TerminalResumeAnswer } from './terminalOutputBuffer'

export type TerminalReplyEvent = 'terminal-frame' | 'terminal-snapshot' | 'terminal-frame-gap' | 'terminal-closed'

export interface TerminalResumeReplyInput {
    sessionId: string
    /** The terminal's replay buffer, or null when the daemon has no such terminal. */
    output: TerminalOutputBuffer | null
    /** Set once the PTY has exited; the exit goes out after the output left. */
    exit?: TerminalExit | null
    afterSeq: unknown
    /** Seals one plaintext chunk for the wire. May throw; the caller reports it. */
    seal: (plain: string) => string
    emit: (event: TerminalReplyEvent, payload: Record<string, unknown>) => void
}

export type TerminalResumeOutcome = TerminalResumeAnswer['kind'] | 'unknown-session'

export function replyToTerminalResume(input: TerminalResumeReplyInput): TerminalResumeOutcome {
    const { sessionId, output, exit, seal, emit } = input
    if (!output) {
        /*
         * Never had it, or it ended longer ago than the retain window. Rides
         * the existing closed event so a client that predates `reason` still
         * shows the terminal as ended instead of waiting on silence.
         */
        emit('terminal-closed', { sessionId, reason: 'unknown-session' })
        return 'unknown-session'
    }
    const afterSeq = typeof input.afterSeq === 'number' && Number.isFinite(input.afterSeq)
        ? Math.max(0, Math.trunc(input.afterSeq))
        : 0

    const answer = output.resume(afterSeq)
    if (answer.kind === 'replay') {
        for (const frame of answer.frames) emit('terminal-frame', { sessionId, seq: frame.seq, data: seal(frame.chunk) })
    } else if (answer.kind === 'snapshot') {
        emit('terminal-snapshot', { sessionId, seq: answer.seq, data: seal(answer.data) })
    } else if (answer.kind === 'gap') {
        // Nothing to send that would be true. Say where the hole starts rather
        // than letting the client believe it is current.
        emit('terminal-frame-gap', { sessionId, fromSeq: answer.fromSeq })
    }

    // An ended terminal's exit goes last, after whatever output is left, even
    // to a client that is already current: it may never have seen the close.
    if (exit) emit('terminal-closed', { sessionId, code: exit.code, signal: exit.signal })
    return answer.kind
}

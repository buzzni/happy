/**
 * What a daemon sends back for one `terminal-resume`, independent of the
 * transport it leaves on (Codex CLI benchmark D4 B-R1/B-R2).
 *
 * The relay path (apiMachine.ts `terminal-resume-fwd`) and the same-machine
 * direct path (controlServerTerminalWs.ts) answer a resume by the same rules,
 * so the rules live here and each transport only seals and sends the events.
 * Chunks are plaintext; sealing with the machine key is the caller's job.
 */

import type { DaemonTerminalEntry } from './daemonTerminalSessions'
import type { TerminalResumeAnswer } from './terminalOutputBuffer'

export type TerminalResumeEvent =
    | { event: 'terminal-frame'; seq: number; chunk: string }
    | { event: 'terminal-snapshot'; seq: number; chunk: string }
    | { event: 'terminal-frame-gap'; fromSeq: number }
    | { event: 'terminal-closed'; code: number; signal: number | null }
    /**
     * The daemon has no such terminal (never had it, or it ended longer ago
     * than the retain window). Rides the existing closed event so a client
     * that predates `reason` still shows the terminal as ended.
     */
    | { event: 'terminal-closed'; reason: 'unknown-session' }

export interface TerminalResumeReply {
    /** For the audit log: the buffer's answer, or `unknown-session`. */
    kind: TerminalResumeAnswer['kind'] | 'unknown-session'
    events: TerminalResumeEvent[]
}

export function planTerminalResume(entry: DaemonTerminalEntry | null, afterSeq: unknown): TerminalResumeReply {
    if (!entry) {
        return { kind: 'unknown-session', events: [{ event: 'terminal-closed', reason: 'unknown-session' }] }
    }
    const seen = typeof afterSeq === 'number' && Number.isFinite(afterSeq) ? Math.max(0, Math.trunc(afterSeq)) : 0
    const answer = entry.output.resume(seen)
    const events: TerminalResumeEvent[] = []
    if (answer.kind === 'replay') {
        for (const frame of answer.frames) events.push({ event: 'terminal-frame', seq: frame.seq, chunk: frame.chunk })
    } else if (answer.kind === 'snapshot') {
        events.push({ event: 'terminal-snapshot', seq: answer.seq, chunk: answer.data })
    } else if (answer.kind === 'gap') {
        // Nothing to send that would be true. Say where the hole starts
        // rather than letting the client believe it is current.
        events.push({ event: 'terminal-frame-gap', fromSeq: answer.fromSeq })
    }
    // An ended terminal's exit goes last, after whatever output is left, even
    // to a client that is already current: it may never have seen the close.
    if (entry.exit) events.push({ event: 'terminal-closed', code: entry.exit.code, signal: entry.exit.signal })
    return { kind: answer.kind, events }
}

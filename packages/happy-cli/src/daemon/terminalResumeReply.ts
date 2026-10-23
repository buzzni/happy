/**
 * Answers one `terminal-resume` (Codex CLI benchmark D4 B-R1·B-R2·B-R3) — the
 * same rules on the relay path (apiMachine.ts `terminal-resume-fwd`) and the
 * same-machine direct path (controlServerTerminalWs.ts), so the two cannot drift.
 *
 * A resume that names `maxChars` is answered one page at a time
 * (terminalOutputBuffer.ts). The client asks for the next page when the last
 * frame of a page says `more`. While that paged replay is under way, a resume
 * for a position the replay has already passed is a duplicate (a reconnect
 * racing a gap, or a second ask for the same hole) and starts nothing new —
 * the replay in flight already covers it.
 *
 * An ended terminal's exit goes out only once no page is left to come: the
 * client stops listening once it hears the terminal closed, and the pages
 * still to come hold its last output. That holds for the exit this answer
 * carries and for the live close path (a PTY's onExit), which waits for the
 * replay through `sendExitAfterReplay`.
 *
 * No socket here: the caller seals and emits, so this module is shared by a
 * socket.io and a raw WebSocket transport alike.
 */

import type { TerminalExit } from './daemonTerminalSessions'
import type { TerminalOutputBuffer, TerminalResumeAnswer } from './terminalOutputBuffer'

/**
 * How long a paged replay waits for its next page to be asked for before a
 * resume for an earlier position is again taken at face value, and before an
 * exit held behind it goes out anyway. Matches the desktop client's own
 * give-up time for a page that never came.
 */
export const PAGED_RESUME_STALE_MS = 10_000

interface PagedCursor {
    /** Seq of the last frame the replay in flight has sent. */
    cursor: number
    at: number
}

// Both keyed by the buffer, which lives exactly as long as the terminal does.
const pagedCursors = new WeakMap<TerminalOutputBuffer, PagedCursor>()
// An exit held back behind a replay, to go out if the client stops asking for pages.
const heldExits = new WeakMap<TerminalOutputBuffer, ReturnType<typeof setTimeout>>()

function releaseHeldExit(output: TerminalOutputBuffer): void {
    const timer = heldExits.get(output)
    if (timer === undefined) return
    clearTimeout(timer)
    heldExits.delete(output)
}

function holdExit(output: TerminalOutputBuffer, sendClosed: () => void, staleMs: number): void {
    releaseHeldExit(output)
    const timer = setTimeout(() => {
        heldExits.delete(output)
        pagedCursors.delete(output)
        sendClosed()
    }, staleMs)
    // A held exit must not keep the daemon process alive on its own.
    timer.unref?.()
    heldExits.set(output, timer)
}

/**
 * A new connection took the terminal over: whatever paged replay was in flight
 * went to the old one, and an exit held behind it is now for the new
 * connection's own resume to carry — sent on its own, it could arrive before
 * that replay and cut it short.
 */
export function resetPagedResume(output: TerminalOutputBuffer): void {
    pagedCursors.delete(output)
    releaseHeldExit(output)
}

/**
 * True while a paged replay of `output` still has pages to hand out and the
 * client has asked for one within the stale window.
 */
export function pagedReplayInFlight(output: TerminalOutputBuffer, now: number = Date.now()): boolean {
    const inFlight = pagedCursors.get(output)
    return inFlight !== undefined && now - inFlight.at < PAGED_RESUME_STALE_MS
}

export interface SendExitAfterReplayInput {
    output: TerminalOutputBuffer
    sendClosed: () => void
    /** Defaults to `pagedReplayInFlight`; tests stand in for a replay. */
    inFlight?: (output: TerminalOutputBuffer) => boolean
    staleMs?: number
}

/**
 * The live close path (a PTY's onExit): send the exit now, unless a replay is
 * mid-way. Then the answer to the last page carries the exit instead; if the
 * client stops asking for pages, the exit goes out once, after `staleMs`.
 */
export function sendExitAfterReplay(input: SendExitAfterReplayInput): 'sent' | 'held' {
    const { output, sendClosed } = input
    const inFlight = input.inFlight ?? pagedReplayInFlight
    releaseHeldExit(output)
    if (!inFlight(output)) {
        sendClosed()
        return 'sent'
    }
    holdExit(output, sendClosed, input.staleMs ?? PAGED_RESUME_STALE_MS)
    return 'held'
}

export type TerminalReplyEvent = 'terminal-frame' | 'terminal-snapshot' | 'terminal-frame-gap' | 'terminal-closed'

export interface TerminalResumeReplyInput {
    sessionId: string
    /** The terminal's replay buffer, or null when the daemon has no such terminal. */
    output: TerminalOutputBuffer | null
    /** Set once the PTY has exited; the exit goes out after the output left. */
    exit?: TerminalExit | null
    afterSeq: unknown
    maxChars?: unknown
    /** Seals one plaintext chunk for the wire. May throw; the caller reports it. */
    seal: (plain: string) => string
    emit: (event: TerminalReplyEvent, payload: Record<string, unknown>) => void
    now?: () => number
}

export type TerminalResumeOutcome = TerminalResumeAnswer['kind'] | 'merged' | 'unknown-session'

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
    const now = (input.now ?? Date.now)()
    const afterSeq = typeof input.afterSeq === 'number' && Number.isFinite(input.afterSeq)
        ? Math.max(0, Math.trunc(input.afterSeq))
        : 0
    const paged = typeof input.maxChars === 'number' && Number.isFinite(input.maxChars)

    if (!paged) {
        // A one-shot resume replays everything itself; nothing to merge with.
        pagedCursors.delete(output)
    } else {
        const inFlight = pagedCursors.get(output)
        if (inFlight && now - inFlight.at < PAGED_RESUME_STALE_MS && afterSeq < inFlight.cursor) {
            // The replay in flight covers this, and carries the exit on its last page.
            return 'merged'
        }
    }

    const answer = output.resume(afterSeq, paged ? input.maxChars as number : undefined)
    if (answer.kind === 'replay') {
        answer.frames.forEach((frame, index) => {
            const isLast = index === answer.frames.length - 1
            emit('terminal-frame', {
                sessionId,
                seq: frame.seq,
                data: seal(frame.chunk),
                ...(isLast && answer.more !== undefined ? { more: answer.more, nextSeq: answer.nextSeq } : {}),
            })
        })
    } else if (answer.kind === 'snapshot') {
        emit('terminal-snapshot', {
            sessionId,
            seq: answer.seq,
            data: seal(answer.data),
            ...(answer.more !== undefined ? { more: answer.more, nextSeq: answer.nextSeq, droppedChars: answer.droppedChars } : {}),
        })
    } else if (answer.kind === 'gap') {
        // Nothing to send that would be true. Say where the hole starts rather
        // than letting the client believe it is current.
        emit('terminal-frame-gap', {
            sessionId,
            fromSeq: answer.fromSeq,
            ...(answer.droppedChars !== undefined ? { droppedChars: answer.droppedChars } : {}),
        })
    }

    const pagesLeft = paged && (answer.kind === 'replay' || answer.kind === 'snapshot') && answer.more === true
    if (pagesLeft) pagedCursors.set(output, { cursor: answer.nextSeq ?? afterSeq, at: now })
    else if (paged) pagedCursors.delete(output)

    if (exit) {
        const sendClosed = () => emit('terminal-closed', { sessionId, code: exit.code, signal: exit.signal })
        if (pagesLeft) {
            // Held behind the pages still to come; goes out anyway if the client stops asking.
            holdExit(output, sendClosed, PAGED_RESUME_STALE_MS)
        } else {
            // An ended terminal's exit goes last, after whatever output is left, even
            // to a client that is already current: it may never have seen the close.
            // This answer carries it, so an exit held behind the replay is not sent again.
            releaseHeldExit(output)
            sendClosed()
        }
    }
    return answer.kind
}

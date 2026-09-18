/**
 * Bounded replay buffer for one terminal's output
 * (specs/desktop-terminal-reliability/ Phase 3, daemon side).
 *
 * Why the daemon owns this and not the relay: happy-server is multi-replica
 * with no sticky sessions, so a buffer kept there would live on whichever
 * replica the daemon happened to connect to, and a client reconnecting onto a
 * peer replica would find nothing. The daemon is the one place a session is
 * unambiguously singular — it is where the PTY runs.
 *
 * Frames are buffered as **plaintext**, before the secretbox hop. That is not a
 * weakening: this is the same process that owns the PTY and already has every
 * byte in memory. It is also what makes a snapshot possible at all — individual
 * frames are separately sealed, so no layer above this one can concatenate
 * them back into "what the screen looks like now".
 */

/** A frame that has been sent and can still be replayed. */
export interface BufferedTerminalFrame {
    seq: number
    chunk: string
}

/**
 * What a `terminal-resume` should be answered with.
 *
 * `replay` — every frame after `afterSeq` is still buffered; send them in order.
 * `snapshot` — `afterSeq` fell out of the buffer, but the whole buffer is a
 *   valid picture of the screen; send it as one frame and let the client reset.
 * `gap` — nothing useful to send (the buffer is empty, or the client is ahead
 *   of us). Tell the client where its hole starts instead of pretending.
 * `none` — the client is already current; say nothing.
 */
export type TerminalResumeAnswer =
    | { kind: 'replay'; frames: BufferedTerminalFrame[] }
    | { kind: 'snapshot'; seq: number; data: string }
    | { kind: 'gap'; fromSeq: number }
    | { kind: 'none' }

export interface TerminalOutputBuffer {
    /** Assigns the next seq, buffers the chunk, and returns that seq. */
    push(chunk: string): number
    /** Decides how to answer a resume for a client that has seen `afterSeq`. */
    resume(afterSeq: number): TerminalResumeAnswer
    /** Highest seq handed out so far. 0 before anything was sent. */
    lastSeq(): number
    /** Buffered characters — observability, and what the cap is measured in. */
    bufferedChars(): number
}

/**
 * Default ceiling, in characters.
 *
 * Matches the desktop client's own ring buffer (`maxBufferChars`, 1,000,000)
 * so the two ends agree on roughly how much history is recoverable. ~2 MB as
 * UTF-16, per terminal, and only for terminals that are actually open.
 */
export const DEFAULT_TERMINAL_BUFFER_CHARS = 1_000_000

export function createTerminalOutputBuffer(maxChars = DEFAULT_TERMINAL_BUFFER_CHARS): TerminalOutputBuffer {
    const frames: BufferedTerminalFrame[] = []
    let nextSeq = 0
    let chars = 0

    const trim = () => {
        // Drop whole frames from the front. A partially dropped frame would
        // corrupt the escape sequences inside it, which is worse than a gap.
        while (frames.length > 0 && chars > maxChars) {
            chars -= frames[0].chunk.length
            frames.shift()
        }
    }

    return {
        push(chunk) {
            nextSeq += 1
            frames.push({ seq: nextSeq, chunk })
            chars += chunk.length
            trim()
            return nextSeq
        },

        resume(afterSeq) {
            if (frames.length === 0) {
                // Nothing was ever sent, or everything was trimmed. Either way
                // there is no honest answer except "you are missing from here".
                return afterSeq >= nextSeq ? { kind: 'none' } : { kind: 'gap', fromSeq: afterSeq + 1 }
            }
            if (afterSeq >= nextSeq) return { kind: 'none' }
            const oldest = frames[0].seq
            if (afterSeq >= oldest - 1) {
                return { kind: 'replay', frames: frames.filter((frame) => frame.seq > afterSeq) }
            }
            // The client is further behind than the buffer reaches. The buffer
            // itself is still a coherent screen, so hand that over whole.
            return {
                kind: 'snapshot',
                seq: nextSeq,
                data: frames.map((frame) => frame.chunk).join(''),
            }
        },

        lastSeq() {
            return nextSeq
        },

        bufferedChars() {
            return chars
        },
    }
}

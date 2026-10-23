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
    | { kind: 'replay'; frames: BufferedTerminalFrame[] } & PageInfo
    | { kind: 'snapshot'; seq: number; data: string } & PageInfo & LossInfo
    | { kind: 'gap'; fromSeq: number } & LossInfo
    | { kind: 'none' }

/**
 * Present only on a paged answer (`resume(afterSeq, maxChars)`,
 * specs/codexcli-daemon-stream-durability B-R3). `nextSeq` is the seq of the
 * last frame in this page — the `afterSeq` the next page is asked with — and
 * `more` says whether there is a next page at all. A one-shot answer carries
 * neither, so its shape is exactly what it was before paging existed.
 */
interface PageInfo {
    more?: boolean
    nextSeq?: number
}

/** Paged answers only: characters that fell out of the buffer after the client's position. */
interface LossInfo {
    droppedChars?: number
}

/**
 * Largest page a paged resume hands out, in characters
 * (specs/codexcli-daemon-stream-durability B-R3: "메시지당 최대 256K자").
 * Also the default when a caller names a page size that is not a positive number.
 */
export const TERMINAL_RESUME_PAGE_CHARS = 262_144

export interface TerminalOutputBuffer {
    /** Assigns the next seq, buffers the chunk, and returns that seq. */
    push(chunk: string): number
    /**
     * Decides how to answer a resume for a client that has seen `afterSeq`.
     * With `maxChars` the answer is one page of at most that many characters
     * (capped at TERMINAL_RESUME_PAGE_CHARS, never splitting a frame); without
     * it, everything at once as before.
     */
    resume(afterSeq: number, maxChars?: number): TerminalResumeAnswer
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

/**
 * Default ceiling, in frames.
 *
 * The character cap alone does not bound memory: a retained frame costs its
 * `{seq, chunk}` object, its array slot and a separate string header on top of
 * the characters it accounts for — measured at ~47 bytes per frame, so a
 * buffer sitting exactly at the character cap made entirely of one-character
 * frames holds ~47 MB, not the ~2 MB the character cap suggests. That is
 * reachable without an adversary: the output coalescer flushes on an 8 ms
 * window, so any slow steady printer (a progress line, a spinner, `tail -f` on
 * a quiet log) produces up to 125 tiny frames a second.
 *
 * 20,000 frames keeps the per-terminal ceiling in the same order as the ~2 MB
 * the character cap implies, while still holding minutes of continuous output.
 */
export const DEFAULT_TERMINAL_BUFFER_FRAMES = 20_000

/**
 * How many trimmed frames still remember where they ended, so a paged answer
 * can say exactly how much output a client lost. A client further behind than
 * this is told a lower bound — it would have to miss more than this many
 * frames on top of a full buffer, far beyond a 30s disconnect.
 */
const TRIM_HISTORY_FRAMES = DEFAULT_TERMINAL_BUFFER_FRAMES

function pageSize(maxChars: number | undefined): number | null {
    if (maxChars === undefined) return null
    if (!Number.isFinite(maxChars) || maxChars <= 0) return TERMINAL_RESUME_PAGE_CHARS
    return Math.min(Math.trunc(maxChars), TERMINAL_RESUME_PAGE_CHARS) || 1
}

/** Leading frames that fit in `limit` characters — always at least one, so paging advances. */
function takePage(frames: BufferedTerminalFrame[], limit: number): BufferedTerminalFrame[] {
    let used = 0
    let count = 0
    while (count < frames.length) {
        const size = frames[count].chunk.length
        if (count > 0 && used + size > limit) break
        used += size
        count += 1
    }
    return frames.slice(0, count)
}

export function createTerminalOutputBuffer(
    maxChars = DEFAULT_TERMINAL_BUFFER_CHARS,
    maxFrames = DEFAULT_TERMINAL_BUFFER_FRAMES,
): TerminalOutputBuffer {
    const frames: BufferedTerminalFrame[] = []
    let nextSeq = 0
    let chars = 0
    // Characters ever trimmed, and — for the most recent trimmed frames — the
    // running total at the end of each one, indexed by seq. Trimming is always
    // from the front, so trimmed seqs are 1..trimmedThrough with no holes.
    let trimmedChars = 0
    let trimmedThrough = 0
    let trimEnds: number[] | null = null

    const trim = () => {
        // Drop whole frames from the front. A partially dropped frame would
        // corrupt the escape sequences inside it, which is worse than a gap.
        while (frames.length > 0 && (chars > maxChars || frames.length > maxFrames)) {
            const dropped = frames.shift()!
            chars -= dropped.chunk.length
            trimmedChars += dropped.chunk.length
            trimmedThrough = dropped.seq
            // Allocated only once a terminal actually overflows.
            trimEnds ??= []
            trimEnds[dropped.seq % TRIM_HISTORY_FRAMES] = trimmedChars
        }
    }

    /** Characters trimmed after `afterSeq` — what a client at that position can never get back. */
    const droppedAfter = (afterSeq: number): number => {
        if (afterSeq >= trimmedThrough) return 0
        if (afterSeq <= 0) return trimmedChars
        const oldestRemembered = Math.max(1, trimmedThrough - TRIM_HISTORY_FRAMES + 1)
        const at = Math.max(afterSeq, oldestRemembered)
        return trimmedChars - (trimEnds?.[at % TRIM_HISTORY_FRAMES] ?? 0)
    }

    return {
        push(chunk) {
            nextSeq += 1
            frames.push({ seq: nextSeq, chunk })
            chars += chunk.length
            trim()
            return nextSeq
        },

        resume(afterSeq, requestedPage) {
            const limit = pageSize(requestedPage)
            if (frames.length === 0) {
                // Nothing was ever sent, or everything was trimmed. Either way
                // there is no honest answer except "you are missing from here".
                if (afterSeq >= nextSeq) return { kind: 'none' }
                return limit === null
                    ? { kind: 'gap', fromSeq: afterSeq + 1 }
                    : { kind: 'gap', fromSeq: afterSeq + 1, droppedChars: droppedAfter(afterSeq) }
            }
            if (afterSeq >= nextSeq) return { kind: 'none' }
            const oldest = frames[0].seq
            if (afterSeq >= oldest - 1) {
                const pending = frames.filter((frame) => frame.seq > afterSeq)
                if (limit === null) return { kind: 'replay', frames: pending }
                const page = takePage(pending, limit)
                return { kind: 'replay', frames: page, more: page.length < pending.length, nextSeq: page[page.length - 1].seq }
            }
            // The client is further behind than the buffer reaches. The buffer
            // itself is still a coherent screen, so hand that over whole.
            if (limit === null) {
                return {
                    kind: 'snapshot',
                    seq: nextSeq,
                    data: frames.map((frame) => frame.chunk).join(''),
                }
            }
            // Paged: the snapshot is the reset plus the first page; what follows
            // is ordinary replay after its seq.
            const page = takePage(frames, limit)
            const last = page[page.length - 1].seq
            return {
                kind: 'snapshot',
                seq: last,
                data: page.map((frame) => frame.chunk).join(''),
                more: page.length < frames.length,
                nextSeq: last,
                droppedChars: droppedAfter(afterSeq),
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

/**
 * Coalesces `pty.onData` chunks before they're encrypted and emitted.
 *
 * Without this, every OS-read chunk becomes its own NaCl-encrypt + Socket.IO
 * emit + happy-server relay lookup + client-decrypt round trip — a `yes` or
 * `find /` firehose turns into a per-chunk message storm. Flushing on an
 * 8ms window or 4KB of buffered output (whichever comes first) keeps
 * interactive latency imperceptible (well under a frame at 60fps) while
 * collapsing bursts into a handful of frames.
 */
import { logger } from '@/ui/logger'

export const DEFAULT_TERMINAL_FLUSH_MS = 8
export const DEFAULT_TERMINAL_MAX_BYTES = 4096

export type TerminalOutputCoalescer = {
  push(chunk: string): void
  flush(): void
  dispose(): void
}

export function createTerminalOutputCoalescer(opts: {
  emit: (chunk: string) => void
  /** Included in the disposed-drop debug log so it can be correlated with
   * the session's other [REMOTE-TERMINAL] log lines. */
  sessionId?: string
  flushMs?: number
  maxBytes?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): TerminalOutputCoalescer {
  const flushMs = opts.flushMs ?? DEFAULT_TERMINAL_FLUSH_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_TERMINAL_MAX_BYTES
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let buffer = ''
  let timer: unknown = null
  let disposed = false

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (buffer.length === 0) return
    const chunk = buffer
    buffer = ''
    opts.emit(chunk)
  }

  return {
    push(chunk) {
      if (disposed) {
        if (chunk.length > 0) {
          logger.debug(`[terminal-output-coalescer] session=${opts.sessionId ?? '-'} dropped ${chunk.length} chars pushed after disposed`)
        }
        return
      }
      if (chunk.length === 0) return
      buffer += chunk
      if (buffer.length >= maxBytes) {
        flush()
        return
      }
      if (timer === null) {
        timer = setTimer(() => {
          timer = null
          flush()
        }, flushMs)
      }
    },
    flush,
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      buffer = ''
    },
  }
}

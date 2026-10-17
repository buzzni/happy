/**
 * Coalesces `pty.onData` chunks before they're encrypted and emitted.
 *
 * Without this, every OS-read chunk becomes its own NaCl-encrypt + Socket.IO
 * emit + happy-server relay lookup + client-decrypt round trip — a `yes` or
 * `find /` firehose turns into a per-chunk message storm.
 *
 * Output after a quiet period goes out at once: a keystroke echo is a few
 * bytes, and holding it for the window added the whole window to every
 * keystroke. That send opens an 8ms window; output arriving inside it is
 * buffered and flushed when the window ends (or at 4KB), and a flush with
 * output opens the next window, so a firehose still collapses into a
 * handful of frames.
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
  // Non-null while a window is open: output is buffered until it ends.
  let timer: unknown = null
  let disposed = false

  const emitBuffered = () => {
    if (buffer.length === 0) return
    const chunk = buffer
    buffer = ''
    opts.emit(chunk)
  }

  const openWindow = () => {
    timer = setTimer(() => {
      timer = null
      if (buffer.length === 0) return
      emitBuffered()
      openWindow()
    }, flushMs)
  }

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    emitBuffered()
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
      if (timer === null) {
        emitBuffered()
        openWindow()
        return
      }
      if (buffer.length >= maxBytes) emitBuffered()
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

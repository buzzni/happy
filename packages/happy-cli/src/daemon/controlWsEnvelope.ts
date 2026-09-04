/**
 * Request/response correlation for the control server's raw WebSocket routes
 * (ADR-061, specs/desktop-speed-breakthrough-local-direct T5).
 *
 * Socket.IO gives `emitWithAck` for free; a raw `ws` connection does not, so
 * the `/terminal` endpoint needs its own envelope: `{reqId, event, data}` out,
 * `{reqId, data}` or `{reqId, error}` back. This tracker is the client-side
 * half of that — pure, no socket, so it is testable without a live connection.
 */

export interface WsRequestEnvelope {
  reqId: string
  event: string
  data?: unknown
}

export interface WsResponseEnvelope {
  reqId: string
  data?: unknown
  error?: string
}

export interface PendingRequestTracker {
  /**
   * Registers a pending request and returns a promise that settles when a
   * matching response arrives via `resolve()`, or rejects after `timeoutMs`
   * with no response. Two calls with the same `reqId` are a caller bug — the
   * second throws rather than silently orphaning the first.
   */
  track(reqId: string, timeoutMs: number): Promise<WsResponseEnvelope>
  /**
   * Feeds an incoming response. A `reqId` with no pending entry — unknown,
   * already timed out, or a duplicate delivery — is dropped, not an error:
   * the sender has no way to know the receiver already forgot it.
   */
  resolve(response: WsResponseEnvelope): void
  /** Rejects every still-pending request (e.g. the socket closed). */
  rejectAll(reason: Error): void
  /** Number of requests still awaiting a response — for tests and cleanup. */
  pendingCount(): number
}

export function createPendingRequestTracker(opts?: {
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): PendingRequestTracker {
  const setTimer = opts?.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = opts?.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const pending = new Map<string, { resolve: (value: WsResponseEnvelope) => void; reject: (reason: Error) => void; timer: unknown }>()

  return {
    track(reqId, timeoutMs) {
      if (pending.has(reqId)) {
        throw new Error(`controlWsEnvelope: reqId "${reqId}" is already pending`)
      }
      return new Promise<WsResponseEnvelope>((resolvePromise, rejectPromise) => {
        const timer = setTimer(() => {
          pending.delete(reqId)
          rejectPromise(new Error(`controlWsEnvelope: request "${reqId}" timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(reqId, { resolve: resolvePromise, reject: rejectPromise, timer })
      })
    },
    resolve(response) {
      const entry = pending.get(response.reqId)
      if (!entry) return
      pending.delete(response.reqId)
      clearTimer(entry.timer)
      entry.resolve(response)
    },
    rejectAll(reason) {
      for (const [reqId, entry] of pending) {
        pending.delete(reqId)
        clearTimer(entry.timer)
        entry.reject(reason)
      }
    },
    pendingCount() {
      return pending.size
    },
  }
}

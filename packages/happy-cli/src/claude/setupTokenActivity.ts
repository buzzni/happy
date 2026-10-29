import { randomUUID } from 'node:crypto'
import type { SetupTokenActivity } from '@slopus/happy-wire'
/** Advisory turn lifecycle; reporting failures must not interrupt provider execution. */
export function createSetupTokenActivityReporter(deps: {
  sessionId(): string | null | undefined; binding(): string | undefined
  report(sessionId: string, binding: string, activity: SetupTokenActivity): Promise<{ ok: boolean }>
  warn(): void
}) {
  const instanceId = randomUUID()
  let current: { sessionId: string; binding: string; turnId: string; seq: number } | null = null
  let tail = Promise.resolve(), warned = false
  const pendingActive = new WeakSet<object>()
  const send = (turn: NonNullable<typeof current>, state: SetupTokenActivity['state']) => {
    if (state === 'active' && pendingActive.has(turn)) return
    if (state === 'active') pendingActive.add(turn)
    const activity = { instanceId, turnId: turn.turnId, seq: ++turn.seq, state }
    tail = tail.then(async () => {
      try {
      for (let attempt = 0; attempt < (state === 'finished' ? 2 : 1); attempt++) {
        try { if ((await deps.report(turn.sessionId, turn.binding, activity)).ok) return } catch { /* report failure is advisory */ }
      }
      if (!warned) { warned = true; deps.warn() }
      } finally { pendingActive.delete(turn) }
    })
  }
  const timer = setInterval(() => { if (current) send(current, 'active') }, 20_000)
  timer.unref?.()
  return {
    thinking(busy: boolean) {
      if (busy && !current) {
        const sessionId = deps.sessionId(), binding = deps.binding()
        if (!sessionId || !binding) return
        current = { sessionId, binding, turnId: randomUUID(), seq: 0 }; send(current, 'active')
      } else if (!busy && current) { const ended = current; current = null; send(ended, 'finished') }
    },
    flush: () => tail,
    async dispose() {
      clearInterval(timer)
      if (current) { const ended = current; current = null; send(ended, 'finished') }
      await tail
    },
  }
}

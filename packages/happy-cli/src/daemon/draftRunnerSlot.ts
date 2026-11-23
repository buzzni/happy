/** exited resolves only after the owned process tree is gone. */
export interface DraftRunner {
  exited: Promise<void>
  stop(): void
}

export type DraftRunnerProvider = 'claude' | 'codex'

export function isDraftRunnerProvider(provider: string): provider is DraftRunnerProvider {
  return provider === 'claude' || provider === 'codex'
}

export function createProviderDraftRunnerSlots<T extends DraftRunner>(launch: (provider: DraftRunnerProvider) => T, idleMs: number) {
  const claude = new DraftRunnerSlot(() => launch('claude'), idleMs)
  const codex = new DraftRunnerSlot(() => launch('codex'), idleMs)
  return { claude, codex, async close() {
    const results = await Promise.allSettled([claude.close(), codex.close()])
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
  } }
}

/** The idle lease bounds preparation. Only a sender needs a separate deadline for its handoff. */
export async function waitForDraftReady(ready: Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), 15_000)
    timer.unref()
  })
  try { return await Promise.race([ready, deadline]) }
  finally { clearTimeout(timer) }
}

interface Entry<T extends DraftRunner> {
  key: string
  reuseGroup?: string
  submitted?: true
  state: 'waiting' | 'claimed' | 'released'
  start: Promise<T | null>
  runner?: T
  timer?: NodeJS.Timeout
}

/** The caller binds the key to the draft and its validated launch scope. */
export class DraftRunnerSlot<T extends DraftRunner> {
  private current?: Entry<T>
  private drained = Promise.resolve()
  private closed = false

  constructor(private readonly launch: (key: string) => T, private readonly idleMs: number) {}

  prepare(key: string, reuseGroup?: string, launch: (key: string) => T = this.launch): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const current = this.current
    if (current?.key === key) {
      current.timer?.refresh()
      return current.start.then(Boolean)
    }
    if (current?.submitted) return Promise.resolve(false)
    if (current && reuseGroup && current.reuseGroup === reuseGroup) {
      current.key = key
      current.timer?.refresh()
      return current.start.then(Boolean)
    }
    if (current) this.release(current.key)

    const entry: Entry<T> = { key, reuseGroup, state: 'waiting', start: this.drained.then(() => {
      if (entry.state === 'released') return null
      const runner = launch(key)
      entry.runner = runner
      void runner.exited.then(() => this.forget(entry), () => {
        this.closed = true
        this.forget(entry)
        if (this.current) this.release(this.current.key)
        this.drained = runner.exited
      })
      return runner
    }).catch(() => {
      this.forget(entry)
      return null
    }) }
    this.current = entry
    entry.timer = setTimeout(() => this.release(entry.key), this.idleMs)
    entry.timer.unref()
    return entry.start.then(Boolean)
  }

  /** Reserve this slot for the pending send while it reaches the daemon. */
  renew(key: string): boolean {
    if (this.current?.key !== key) return false
    this.current.submitted = true
    this.current.timer?.refresh()
    return true
  }

  /** Transfer ownership synchronously, even if creation is queued behind an earlier exit. */
  claim(key: string): Promise<T | null> | null {
    const entry = this.current
    if (!entry || key !== entry.key) return null
    entry.state = 'claimed'
    this.forget(entry)
    return entry.start
  }

  release(key: string): void {
    const entry = this.current
    if (!entry || key !== entry.key) return
    entry.state = 'released'
    this.forget(entry)
    if (entry.runner) {
      this.drained = entry.runner.exited
      entry.runner.stop()
    }
  }

  close(): Promise<void> {
    this.closed = true
    if (this.current) this.release(this.current.key)
    return this.drained
  }

  private forget(entry: Entry<T>): void {
    clearTimeout(entry.timer)
    if (this.current === entry) this.current = undefined
  }
}

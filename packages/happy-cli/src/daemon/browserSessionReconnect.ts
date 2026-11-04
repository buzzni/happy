type ReconnectOptions = {
    sessionId: string
    current(): boolean | Promise<boolean>
    registered(): Promise<boolean>
    target(): { pid: number; token: unknown; owned: boolean } | undefined
    startTime(pid: number): Promise<string | undefined>
    alive(pid: number): boolean
    stop(): { stopped: boolean }
    deadlineMs?: number
}
type ReconnectResult = { supported: true; reconnect: boolean }
type PendingExit = { pid: number; start: string }

/** One daemon owns pending exits across calls; a missing tracking row is not exit evidence. */
export function createBrowserSessionReconnect() {
    const pendingExits = new Map<string, PendingExit>()
    const inFlight = new Map<string, Promise<ReconnectResult>>()
    const prepare = async (options: ReconnectOptions): Promise<ReconnectResult> => {
        const current = async () => { if (!await options.current()) throw Error('DESKTOP_BROWSER_LOGIN_REQUIRED') }
        const verifyExit = async (target: PendingExit) => {
            for (const deadline = Date.now() + (options.deadlineMs ?? 10_000); Date.now() < deadline;) {
                await current()
                const next = await options.startTime(target.pid)
                await current()
                if (next === undefined ? !options.alive(target.pid) : next !== target.start) return
                await new Promise(resolve => setTimeout(resolve, 50))
            }
            throw Error('BROWSER_SESSION_RECONNECT_UNCONFIRMED')
        }
        await current()
        const pending = pendingExits.get(options.sessionId)
        if (pending) {
            await verifyExit(pending)
            pendingExits.delete(options.sessionId)
        }
        const registered = await options.registered()
        await current()
        if (registered) return { supported: true, reconnect: false }
        const target = options.target()
        if (!target) return { supported: true, reconnect: true }
        const start = await options.startTime(target.pid)
        await current()
        if (options.target()?.token !== target.token) throw Error('BROWSER_SESSION_CHANGED')
        if (start === undefined) {
            if (options.alive(target.pid)) throw Error('BROWSER_SESSION_RECONNECT_UNCONFIRMED')
            return { supported: true, reconnect: true }
        }
        // Recovered or externally launched PIDs are not a child handle we can safely signal.
        if (!target.owned) throw Error('BROWSER_SESSION_RECONNECT_UNCONFIRMED')
        pendingExits.set(options.sessionId, { pid: target.pid, start })
        // stop() uses the live busy guard and may remove tracking before the process exits.
        if (!options.stop().stopped) {
            pendingExits.delete(options.sessionId)
            throw Error('BROWSER_SESSION_BUSY')
        }
        await verifyExit({ pid: target.pid, start })
        pendingExits.delete(options.sessionId)
        return { supported: true, reconnect: true }
    }
    return (options: ReconnectOptions): Promise<ReconnectResult> => {
        // A concurrent request must recheck the same pending exit, including after a timeout.
        const previous = inFlight.get(options.sessionId) ?? Promise.resolve()
        const result = previous.catch(() => {}).then(() => prepare(options))
        inFlight.set(options.sessionId, result)
        const clear = () => { if (inFlight.get(options.sessionId) === result) inFlight.delete(options.sessionId) }
        void result.then(clear, clear)
        return result
    }
}

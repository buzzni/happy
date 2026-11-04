/** Reconnect the tools of one idle conversation through normal resume. Never replay a user action. */
export async function prepareBrowserSessionReconnect<T>(options: {
    current(): boolean | Promise<boolean>
    registered(): Promise<boolean>
    target(): { pid: number; token: T; owned: boolean } | undefined
    startTime(pid: number): Promise<string | undefined>
    alive(pid: number): boolean
    stop(): { stopped: boolean }
    deadlineMs?: number
}): Promise<{ supported: true; reconnect: boolean }> {
    const current = async () => { if (!await options.current()) throw Error('DESKTOP_BROWSER_LOGIN_REQUIRED') }
    await current()
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
    // stop() uses the daemon's live busy guard. Identity is fixed before any signal is sent.
    if (!options.stop().stopped) throw Error('BROWSER_SESSION_BUSY')
    for (const deadline = Date.now() + (options.deadlineMs ?? 10_000); Date.now() < deadline;) {
        await current()
        const next = await options.startTime(target.pid)
        await current()
        if (next === undefined ? !options.alive(target.pid) : next !== start) return { supported: true, reconnect: true }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw Error('BROWSER_SESSION_RECONNECT_UNCONFIRMED')
}

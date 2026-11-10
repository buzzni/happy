import { CdpDriver } from './drivers/cdpDriver'
import type { NativeBrowserSession } from './nativeBrowserSession'

const unavailable = () => new Error('ABP personal browser is stopped')
const unconfirmed = () => new Error('ABP personal browser termination or fencing is unconfirmed')

/** One owned native session per demand. Metadata/admission never calls open.
 * Each replacement waits for the old lifetime's disconnect fencing; old tabs are
 * never adopted. The original native session still owns PID/UID/pipe checks. */
export function createPersonalBrowserDemand(open: () => Promise<NativeBrowserSession>) {
    const coldDriver = new CdpDriver({ connectPipe: async () => { throw unavailable() } })
    let current: NativeBrowserSession | undefined
    let starting: Promise<NativeBrowserSession> | undefined
    let retiring: Promise<void> = Promise.resolve()
    let closed = false, blocked: Error | undefined
    let stoppedListener = async () => {}
    let resolveStopped!: (value: { terminated: boolean }) => void
    const stopped = new Promise<{ terminated: boolean }>(resolve => { resolveStopped = resolve })
    let closing: Promise<{ terminated: boolean }> | undefined
    let idleStopping: NativeBrowserSession | undefined
    const assertOpen = () => { if (blocked) throw blocked; if (closed) throw unavailable() }

    const retire = (session: NativeBrowserSession, ended: { terminated: boolean } | Promise<{ terminated: boolean }>) => {
        retiring = (async () => {
            if (!(await ended).terminated) throw unconfirmed()
            await stoppedListener()
            if (current === session) current = undefined
        })().catch(error => { blocked = error instanceof Error ? error : unconfirmed() })
        return retiring
    }

    const start = async (): Promise<NativeBrowserSession> => {
        await retiring
        assertOpen()
        if (current) return current
        starting ??= (async () => {
            const session = await open()
            if (closed) {
                if (!(await session.close()).terminated) blocked = unconfirmed()
                throw blocked ?? unavailable()
            }
            current = session
            void session.stopped.then(result => {
                if (current !== session || closed || idleStopping === session) return
                retire(session, result)
            })
            return session
        })().catch(error => {
            if (error instanceof Error && /cleanup is unconfirmed/.test(error.message)) blocked = error
            throw error
        }).finally(() => { starting = undefined })
        return starting
    }

    return {
        get driver() { return current?.driver ?? coldDriver },
        stopped,
        start,
        onBrowserStopped(listener: () => Promise<void>) { stoppedListener = listener },
        /** Ends the current lifetime like the user's Quit; a request arriving meanwhile waits and starts a new one. */
        async stopIdle(): Promise<boolean> {
            const session = current
            if (!session || starting || closed || blocked || idleStopping) return false
            idleStopping = session
            await retire(session, session.close()).finally(() => { idleStopping = undefined })
            return !blocked
        },
        async check(): Promise<void> { await retiring; assertOpen(); await current?.check() },
        close(): Promise<{ terminated: boolean }> {
            if (closing) return closing
            closed = true // Before awaiting an in-flight launch.
            closing = (async () => {
                await starting?.catch(() => {})
                const result = current ? await current.close() : { terminated: true }
                await retiring
                const confirmed = { terminated: result.terminated && !blocked }
                resolveStopped(confirmed)
                return confirmed
            })()
            return closing
        },
    }
}

/** Stops the browser once it stayed unused for `idleMs`: no open space and no page, so a closed
 * task does not leave a windowless Chrome behind. Each check that finds it in use restarts the period. */
export function createPersonalBrowserIdleStop(options: { idleMs: number; now: () => number; unused: () => Promise<boolean>; stop: () => Promise<boolean> }) {
    let since: number | undefined
    return async (): Promise<boolean> => {
        if (!await options.unused()) { since = undefined; return false }
        since ??= options.now()
        if (options.now() - since < options.idleMs) return false
        since = undefined
        return options.stop()
    }
}

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
    const assertOpen = () => { if (blocked) throw blocked; if (closed) throw unavailable() }

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
                if (current !== session || closed) return
                retiring = (async () => {
                    if (!result.terminated) throw unconfirmed()
                    await stoppedListener()
                    if (current === session) current = undefined
                })().catch(error => { blocked = error instanceof Error ? error : unconfirmed() })
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

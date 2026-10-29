import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { openNativeBrowserSession, type NativeBrowserSessionOptions } from './nativeBrowserSession'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.useRealTimers() })
function fixture() {
    const input = new PassThrough(), output = new PassThrough()
    input.on('data', chunk => {
        const { id } = JSON.parse(chunk.toString().slice(0, -1))
        output.write(JSON.stringify({ id, result: {} }) + '\0')
    })
    const owner = { bootId: 'boot-a', pid: 1234, pidStartTime: '100' }
    const status = { version: 1, identity: 'browser-user', epoch: 'policy-1', generation: 'filter-1', violations: '0', enforcing: true }
    const snapshot = vi.fn(async (): Promise<unknown> => ({ ...status }))
    const terminate = vi.fn(async () => {})
    const readOwner = vi.fn((_pid: number) => ({ ...owner }))
    const readPrincipal = vi.fn((_pid: number): string | undefined => 'browser-user')
    const options: NativeBrowserSessionOptions = { input, output, owner, protection: { identity: status.identity, epoch: status.epoch, snapshot }, terminate,
        checkIntervalMs: 50, checkTimeoutMs: 100 }
    const open = async () => {
        const result = await openNativeBrowserSession(options, { readOwner, readPrincipal })
        closers.push(result.close)
        return result
    }
    return { options, status, snapshot, terminate, readOwner, readPrincipal, input, output, open }
}

it('binds the driver to the exact process and requires fresh protection at startup', async () => {
    const h = fixture(), session = await h.open()
    expect(session.driver.isConnected()).toBe(true)
    expect(h.snapshot).toHaveBeenCalledTimes(2)
    expect(h.readOwner.mock.calls.every(([pid]) => pid === h.options.owner.pid)).toBe(true)
    expect(session.driver.browserInstanceId()).toMatch(/^native-/)
    expect(await session.close()).toEqual({ terminated: true })
    expect(await session.stopped).toEqual({ terminated: true })
    expect(session.driver.isConnected()).toBe(false)
    expect(h.terminate).toHaveBeenCalledTimes(1)
})

it.each(['unknown', 'identity', 'epoch', 'inactive', 'malformed'])('refuses initial %s protection before CDP commands', async kind => {
    const h = fixture()
    if (kind === 'unknown') h.snapshot.mockRejectedValue(new Error('unreachable'))
    if (kind === 'identity') h.status.identity = 'another-user'
    if (kind === 'epoch') h.status.epoch = 'old-policy'
    if (kind === 'inactive') h.status.enforcing = false
    if (kind === 'malformed') h.snapshot.mockResolvedValue({ ...h.status, violations: 0 })
    await expect(h.open()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(h.input.destroyed).toBe(true)
    expect(h.output.destroyed).toBe(true)
    expect(h.terminate).toHaveBeenCalledTimes(1)
})

it.each(['pid-reuse', 'reboot', 'guard-restart', 'bypass', 'counter-reset', 'query-error', 'process-user'])('closes admission and terminates on %s without reconnecting', async kind => {
    const h = fixture()
    h.status.violations = '2'
    const session = await h.open()
    if (kind === 'pid-reuse') h.readOwner.mockReturnValue({ ...h.options.owner, pidStartTime: '101' })
    if (kind === 'reboot') h.readOwner.mockReturnValue({ ...h.options.owner, bootId: 'boot-b' })
    if (kind === 'guard-restart') h.status.generation = 'filter-2'
    if (kind === 'bypass') h.status.violations = '3'
    if (kind === 'counter-reset') h.status.violations = '0'
    if (kind === 'query-error') h.snapshot.mockRejectedValue(new Error('unreachable'))
    if (kind === 'process-user') h.readPrincipal.mockReturnValue('unprotected-user')
    await expect(session.check()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(session.driver.isConnected()).toBe(false)
    expect(await session.stopped).toEqual({ terminated: true })
    await expect(session.driver.reconnect()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(h.terminate).toHaveBeenCalledTimes(1)
})

it('refuses a process whose lifetime matches but whose OS identity is not protected', async () => {
    const h = fixture()
    h.readPrincipal.mockReturnValue('unprotected-user')
    await expect(h.open()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(h.terminate).toHaveBeenCalledTimes(1)
})

it('reports unconfirmed termination instead of claiming shutdown success', async () => {
    const h = fixture(), session = await h.open()
    h.terminate.mockRejectedValue(new Error('access denied'))
    expect(await session.close()).toEqual({ terminated: false })
    expect(session.driver.isConnected()).toBe(false)
    expect(await session.close()).toEqual({ terminated: false })
    expect(h.terminate).toHaveBeenCalledTimes(1)
})

it('exposes an unconfirmed stop even when startup fails before returning a session', async () => {
    const h = fixture()
    h.snapshot.mockRejectedValue(new Error('guard unavailable'))
    h.terminate.mockRejectedValue(new Error('termination unknown'))
    await expect(h.open()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE', retryable: false, mayHaveSideEffects: true })
    expect(h.input.destroyed).toBe(true)
    expect(h.terminate).toHaveBeenCalledTimes(1)
})

it('stops after pipe EOF even if the driver cannot send a browser-close command', async () => {
    const h = fixture(), session = await h.open()
    h.output.end()
    expect(await session.stopped).toEqual({ terminated: true })
    expect(h.terminate).toHaveBeenCalledTimes(1)
})

it('expires a hanging protection query and never overlaps monitor calls', async () => {
    vi.useFakeTimers()
    const h = fixture(), session = await h.open()
    h.snapshot.mockImplementation(() => new Promise(() => {}))
    const before = h.snapshot.mock.calls.length
    await vi.advanceTimersByTimeAsync(200)
    expect(h.snapshot).toHaveBeenCalledTimes(before + 1)
    expect(await session.stopped).toEqual({ terminated: true })
    expect(session.driver.isConnected()).toBe(false)
})

it('does not reconnect when closed during a pending protection check', async () => {
    const h = fixture(), session = await h.open()
    let resolve!: (value: unknown) => void
    h.snapshot.mockImplementation(() => new Promise(r => { resolve = r }))
    const checking = session.check().catch(error => error)
    expect(await session.close()).toEqual({ terminated: true })
    await Promise.resolve()
    resolve({ ...h.status })
    expect(await checking).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(session.driver.isConnected()).toBe(false)
})


it('runs explicit basic mode without a Guard but still stops on process identity changes', async () => {
    const h = fixture()
    h.options.protection = { mode: 'basic', identity: 'browser-user' }
    const session = await h.open()
    expect(session.driver.isConnected()).toBe(true)
    expect(h.snapshot).not.toHaveBeenCalled()
    h.readPrincipal.mockReturnValue('another-user')
    await expect(session.check()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(await session.stopped).toEqual({ terminated: true })
})

it('cannot downgrade a live guarded session by changing its options', async () => {
    const h = fixture(), session = await h.open()
    h.options.protection = { mode: 'basic', identity: 'browser-user' }
    h.snapshot.mockRejectedValue(new Error('guard lost'))
    await expect(session.check()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(await session.stopped).toEqual({ terminated: true })
})

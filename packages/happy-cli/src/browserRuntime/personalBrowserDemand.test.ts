import { expect, it, vi } from 'vitest'
import { CdpDriver } from './drivers/cdpDriver'
import type { NativeBrowserSession } from './nativeBrowserSession'
import { createPersonalBrowserDemand } from './personalBrowserDemand'

function session() {
    let stopped!: (value: { terminated: boolean }) => void
    const value: NativeBrowserSession = {
        driver: new CdpDriver({ connectPipe: async () => { throw new Error('test session is disconnected') } }),
        stopped: new Promise(resolve => { stopped = resolve }),
        check: vi.fn(async () => {}),
        close: vi.fn(async () => { stopped({ terminated: true }); return { terminated: true } }),
    }
    return { value, stopped }
}

it('does not launch on admission, shares a demand start, and stays cold after the user quits Chrome', async () => {
    const first = session(), second = session()
    const open = vi.fn().mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value)
    const demand = createPersonalBrowserDemand(open)
    await demand.check()
    expect(open).not.toHaveBeenCalled()
    expect(await Promise.all([demand.start(), demand.start()])).toEqual([first.value, first.value])
    expect(open).toHaveBeenCalledTimes(1)
    const retired = vi.fn(async () => {})
    demand.onBrowserStopped(retired)
    first.stopped({ terminated: true })
    await vi.waitFor(() => expect(retired).toHaveBeenCalledOnce())
    await demand.check()
    expect(open).toHaveBeenCalledTimes(1)
    expect(demand.driver).not.toBe(first.value.driver)
    expect(await demand.start()).toBe(second.value)
    expect(open).toHaveBeenCalledTimes(2)
    await demand.close()
})

it('finishes disconnect fencing before a new request may start a fresh browser', async () => {
    const first = session(), second = session()
    let release!: () => void
    const fenced = new Promise<void>(resolve => { release = resolve })
    const open = vi.fn().mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value)
    const demand = createPersonalBrowserDemand(open)
    demand.onBrowserStopped(() => fenced)
    await demand.start()
    first.stopped({ terminated: true })
    await Promise.resolve()
    const next = demand.start()
    await Promise.resolve()
    expect(open).toHaveBeenCalledTimes(1)
    release()
    expect(await next).toBe(second.value)
    await demand.close()
})

it('closes a late start after shutdown and refuses unconfirmed process cleanup', async () => {
    const started = session()
    let finish!: (value: NativeBrowserSession) => void
    const demand = createPersonalBrowserDemand(() => new Promise(resolve => { finish = resolve }))
    const pending = demand.start().catch(error => error)
    await Promise.resolve()
    const closing = demand.close()
    finish(started.value)
    expect(await pending).toBeInstanceOf(Error)
    expect(await closing).toEqual({ terminated: true })
    expect(started.value.close).toHaveBeenCalledOnce()
    await expect(demand.start()).rejects.toThrow()

    const broken = session()
    const open = vi.fn(async () => broken.value)
    const blocked = createPersonalBrowserDemand(open)
    await blocked.start()
    broken.stopped({ terminated: false })
    await Promise.resolve()
    await expect(blocked.start()).rejects.toThrow(/termination|confirmed/)
    expect(open).toHaveBeenCalledOnce()
    await blocked.close()
})

it('keeps an unconfirmed startup cleanup blocked and can close without ever launching', async () => {
    const open = vi.fn(async () => { throw new Error('ABP personal startup cleanup is unconfirmed') })
    const demand = createPersonalBrowserDemand(open)
    await expect(demand.start()).rejects.toThrow('cleanup is unconfirmed')
    await expect(demand.start()).rejects.toThrow('cleanup is unconfirmed')
    expect(open).toHaveBeenCalledOnce()
    expect(await demand.close()).toEqual({ terminated: false })
    const cold = createPersonalBrowserDemand(open)
    expect(await cold.close()).toEqual({ terminated: true })
    await expect(cold.start()).rejects.toThrow('stopped')
    expect(open).toHaveBeenCalledOnce()
})

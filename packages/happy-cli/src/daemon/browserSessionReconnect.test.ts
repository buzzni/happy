import { expect, it, vi } from 'vitest'
import { createBrowserSessionReconnect } from './browserSessionReconnect'
const prepareBrowserSessionReconnect = createBrowserSessionReconnect()
let sequence = 0
const target = { pid: 123, token: {}, owned: true }
const fixture = () => ({ sessionId: `session-${++sequence}`, current: () => true, registered: async () => false, target: () => target,
    alive: () => false, startTime: vi.fn<() => Promise<string | undefined>>().mockResolvedValueOnce('start').mockResolvedValue(undefined), stop: vi.fn(() => ({ stopped: true })) })
it('stops only missing browser bindings and proves the exact process ended before normal resume', async () => {
    const f = fixture()
    expect(await prepareBrowserSessionReconnect(f)).toEqual({ supported: true, reconnect: true })
    expect(f.stop).toHaveBeenCalledOnce()
    const ready = fixture(); ready.registered = async () => true
    expect(await prepareBrowserSessionReconnect(ready)).toEqual({ supported: true, reconnect: false })
    expect(ready.stop).not.toHaveBeenCalled()
})
it('denies busy work, unknown exit, replaced targets and changed login epochs', async () => {
    const busy = fixture(); busy.stop.mockReturnValue({ stopped: false })
    await expect(prepareBrowserSessionReconnect(busy)).rejects.toThrow('BUSY')
    const stuck = fixture(); stuck.startTime.mockReset().mockResolvedValue('same')
    await expect(prepareBrowserSessionReconnect({ ...stuck, deadlineMs: 1 })).rejects.toThrow('UNCONFIRMED')
    const replaced = fixture(); replaced.startTime.mockReset().mockImplementationOnce(async () => { replaced.target = () => ({ ...target, token: {} }); return 'start' })
    await expect(prepareBrowserSessionReconnect(replaced)).rejects.toThrow('CHANGED')
    expect(replaced.stop).not.toHaveBeenCalled()
    const logout = fixture(); logout.registered = async () => { logout.current = () => false; return false }
    await expect(prepareBrowserSessionReconnect(logout)).rejects.toThrow('LOGIN_REQUIRED')
    expect(logout.stop).not.toHaveBeenCalled()
})

it('never treats a failed native identity query on a live process as proof of exit', async () => {
    const f = fixture(); f.startTime.mockReset().mockResolvedValue(undefined)
    await expect(prepareBrowserSessionReconnect({ ...f, alive: () => true })).rejects.toThrow('UNCONFIRMED')
    expect(f.stop).not.toHaveBeenCalled()
    f.startTime.mockReset().mockResolvedValueOnce('start').mockResolvedValue(undefined)
    await expect(prepareBrowserSessionReconnect({ ...f, alive: () => true, deadlineMs: 1 })).rejects.toThrow('UNCONFIRMED')
})

it('rechecks the live Desktop login after identity lookup and before sending a stop', async () => {
    const f = fixture(); let checks = 0
    await expect(prepareBrowserSessionReconnect({ ...f, current: async () => ++checks < 3 })).rejects.toThrow('LOGIN_REQUIRED')
    expect(f.stop).not.toHaveBeenCalled()
})

it('preserves live recovered and external processes without a daemon-owned child handle', async () => {
    const f = fixture(); f.target = () => ({ ...target, owned: false })
    await expect(prepareBrowserSessionReconnect(f)).rejects.toThrow('UNCONFIRMED')
    expect(f.stop).not.toHaveBeenCalled()
    f.startTime.mockReset().mockResolvedValue(undefined)
    expect(await prepareBrowserSessionReconnect(f)).toEqual({ supported: true, reconnect: true })
    expect(f.stop).not.toHaveBeenCalled()
})

it('keeps an unconfirmed stopped process pending when tracking disappears and the caller retries', async () => {
    const f = fixture()
    let tracked: typeof target | undefined = target
    let running = true
    f.target = () => tracked!
    f.alive = () => running
    f.startTime.mockReset().mockImplementation(async () => running ? 'original-start' : undefined)
    f.stop.mockImplementation(() => { tracked = undefined; return { stopped: true } })
    const options = { ...f, deadlineMs: 1 }
    await expect(prepareBrowserSessionReconnect(options)).rejects.toThrow('UNCONFIRMED')
    await expect(prepareBrowserSessionReconnect(options)).rejects.toThrow('UNCONFIRMED')
    expect(f.stop).toHaveBeenCalledOnce()
    running = false
    expect(await prepareBrowserSessionReconnect(options)).toEqual({ supported: true, reconnect: true })
})

it('serializes concurrent retries and keeps pending exits ahead of new registration reports', async () => {
    const f = fixture()
    let tracked: typeof target | undefined = target
    f.target = () => tracked!
    f.alive = () => true
    f.startTime.mockReset().mockResolvedValue('original-start')
    f.stop.mockImplementation(() => { tracked = undefined; return { stopped: true } })
    const options = { ...f, deadlineMs: 1 }
    const results = await Promise.allSettled([
        prepareBrowserSessionReconnect(options), prepareBrowserSessionReconnect(options),
    ])
    for (const result of results) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') expect(result.reason.message).toContain('UNCONFIRMED')
    }
    f.registered = async () => true
    await expect(prepareBrowserSessionReconnect({ ...f, deadlineMs: 1 })).rejects.toThrow('UNCONFIRMED')
    expect(f.stop).toHaveBeenCalledOnce()
})

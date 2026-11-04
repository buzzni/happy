import { expect, it, vi } from 'vitest'
import { prepareBrowserSessionReconnect } from './browserSessionReconnect'
const target = { pid: 123, token: {}, owned: true }
const fixture = () => ({ current: () => true, registered: async () => false, target: () => target,
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

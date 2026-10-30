import { expect, it, vi } from 'vitest'
import { createMacNativeBrowserProtection } from './macNativeBrowserProtection'

function fixture() {
    const status = { version: 1, filterRunning: true, browserUid: 250, policyEpoch: 3, startedAt: 123456, browserDrops: 0 }
    const verifyExecutable = vi.fn(async () => {})
    const run = vi.fn(async (file: string) => ({ stdout: file === '/usr/bin/codesign' ? '' : JSON.stringify({ status, protects: true }) }))
    const guard = createMacNativeBrowserProtection({ browserUid: 250, epoch: 3 }, { platform: 'darwin', verifyExecutable, run })
    return { status, verifyExecutable, run, guard }
}

it('checks fixed helper storage and signer before querying its authenticated XPC channel', async () => {
    const h = fixture()
    expect(await h.guard.snapshot()).toEqual({ version: 1, identity: '250', epoch: '3', generation: '123456', violations: '0', enforcing: true })
    expect(h.verifyExecutable).toHaveBeenCalledWith('/Library/Application Support/SaycodeNative/bin/network-guard-status')
    expect(h.run.mock.calls[0]).toEqual(['/usr/bin/codesign', ['--verify', '--strict', '-R', '=anchor apple generic and certificate leaf[subject.OU] = "36C77K9BJ2" and identifier "com.saycode.nativeh.networkguard.status-check"', '/Library/Application Support/SaycodeNative/bin/network-guard-status']])
    expect(h.run.mock.calls[1]).toEqual(['/Library/Application Support/SaycodeNative/bin/network-guard-status', ['250', '3']])
})

it.each(['storage', 'signature'])('does not execute a helper with untrusted %s', async reason => {
    const h = fixture()
    if (reason === 'storage') h.verifyExecutable.mockRejectedValue(new Error('unsafe path'))
    else h.run.mockRejectedValue(new Error('wrong signer'))
    await expect(h.guard.snapshot()).rejects.toThrow()
    expect(h.run.mock.calls.every(([path]) => path === '/usr/bin/codesign')).toBe(true)
})

it.each(['user', 'epoch', 'inactive', 'error', 'precision', 'unknown', 'claim'])('rejects a %s protection reply', async kind => {
    const h = fixture()
    let payload: unknown = { status: h.status, protects: true }
    if (kind === 'user') h.status.browserUid++
    if (kind === 'epoch') h.status.policyEpoch++
    if (kind === 'inactive') h.status.filterRunning = false
    if (kind === 'error') payload = { status: { ...h.status, policyError: 'untrustedFile' }, protects: true }
    if (kind === 'precision') h.status.browserDrops = Number.MAX_SAFE_INTEGER + 1
    if (kind === 'unknown') payload = { error: 'unreachable' }
    if (kind === 'claim') payload = { status: h.status, protects: false }
    h.run.mockImplementation(async path => ({ stdout: path === '/usr/bin/codesign' ? '' : JSON.stringify(payload) }))
    await expect(h.guard.snapshot()).rejects.toThrow()
})

it('rejects unsupported hosts and invalid service identities before accessing the OS', () => {
    const io = { platform: 'win32' as const, verifyExecutable: vi.fn(), run: vi.fn() }
    expect(() => createMacNativeBrowserProtection({ browserUid: 250, epoch: 3 }, io)).toThrow()
    expect(() => createMacNativeBrowserProtection({ browserUid: 0, epoch: 3 }, { ...io, platform: 'darwin' })).toThrow()
    expect(io.run).not.toHaveBeenCalled()
})

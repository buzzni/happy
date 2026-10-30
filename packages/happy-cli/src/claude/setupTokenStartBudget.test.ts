import { expect, it, vi } from 'vitest'
import { waitForSetupTokenStart } from './setupTokenStartBudget'
const allowed = { state: 'allowed' as const, validForMs: 15000 }
it('waits for admission and reuses the same logical start identity', async () => {
  const request = vi.fn().mockResolvedValueOnce({ state: 'wait', retryAfterMs: 30, preferredAccountIds: [] }).mockResolvedValue(allowed)
  const notify = vi.fn()
  expect(await waitForSetupTokenStart({ request, notify, signal: new AbortController().signal })).toBe(true)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[0][0]).toBe(request.mock.calls[1][0])
  expect(notify).toHaveBeenCalledTimes(1)
})
it('cancels waiting without requesting another permit', async () => {
  const controller = new AbortController()
  const request = vi.fn().mockResolvedValue({ state: 'wait', retryAfterMs: 600000, preferredAccountIds: [] })
  const result = waitForSetupTokenStart({ request, notify: () => controller.abort(), signal: controller.signal })
  expect(await result).toBe(false)
  expect(request).toHaveBeenCalledTimes(1)
})
it('never authorizes a start on server failure', async () => {
  await expect(waitForSetupTokenStart({ request: async () => { throw new Error('offline') }, notify: vi.fn(), signal: new AbortController().signal })).rejects.toThrow('offline')
})
it('refuses a permission that expired while its response was in transit', async () => {
  await expect(waitForSetupTokenStart({ request: async () => ({ ...allowed, validForMs: 0 }), notify: vi.fn(), signal: new AbortController().signal })).rejects.toThrow('START_EXPIRED')
})
it('does not dispatch after cancellation during an in-flight permission', async () => {
  const controller = new AbortController()
  expect(await waitForSetupTokenStart({ request: async () => { controller.abort(); return allowed }, notify: vi.fn(), signal: controller.signal })).toBe(false)
})

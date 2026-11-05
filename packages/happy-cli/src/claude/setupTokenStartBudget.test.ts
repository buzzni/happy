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
it('moves to an account with start budget left instead of waiting', async () => {
  const request = vi.fn().mockResolvedValue({ state: 'wait', retryAfterMs: 600000, preferredAccountIds: ['b'] })
  const notify = vi.fn(), moveToPreferred = vi.fn(async () => true)
  expect(await waitForSetupTokenStart({ request, notify, moveToPreferred, signal: new AbortController().signal })).toBe(false)
  expect(moveToPreferred).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
})
it('waits when the move fails, and asks to move again on the next recheck', async () => {
  const request = vi.fn().mockResolvedValueOnce({ state: 'wait', retryAfterMs: 30, preferredAccountIds: ['b'] })
    .mockResolvedValueOnce({ state: 'wait', retryAfterMs: 30, preferredAccountIds: ['b'] }).mockResolvedValue(allowed)
  const notify = vi.fn(), moveToPreferred = vi.fn(async () => false)
  expect(await waitForSetupTokenStart({ request, notify, moveToPreferred, signal: new AbortController().signal })).toBe(true)
  expect(moveToPreferred).toHaveBeenCalledTimes(2)
  expect(notify).toHaveBeenCalledTimes(1)
})
it('does not ask to move when no account has start budget left', async () => {
  const request = vi.fn().mockResolvedValueOnce({ state: 'wait', retryAfterMs: 30, preferredAccountIds: [] }).mockResolvedValue(allowed)
  const moveToPreferred = vi.fn(async () => true)
  expect(await waitForSetupTokenStart({ request, notify: vi.fn(), moveToPreferred, signal: new AbortController().signal })).toBe(true)
  expect(moveToPreferred).not.toHaveBeenCalled()
})

it('bounds retries when no replacement is available and never authorizes the waiting input', async () => {
  const request = vi.fn(async () => ({ state:'wait' as const, retryAfterMs:1, preferredAccountIds:[] }))
  const notify = vi.fn(), moveToPreferred = vi.fn(async()=>false)
  await expect(waitForSetupTokenStart({request,notify,moveToPreferred,signal:new AbortController().signal})).rejects.toThrow('SETUP_TOKEN_START_WAIT_EXHAUSTED')
  expect(request).toHaveBeenCalledTimes(60)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(moveToPreferred).not.toHaveBeenCalled()
})

it('moves off confirmed start exhaustion without admitting the old provider or using start budget', async () => {
 const request=vi.fn().mockRejectedValue(new Error('SETUP_TOKEN_START_ACCOUNT_EXHAUSTED'))
 const moveFromExhausted=vi.fn(async()=>true),moveToPreferred=vi.fn(),notify=vi.fn()
 expect(await waitForSetupTokenStart({request,moveFromExhausted,moveToPreferred,notify,signal:new AbortController().signal})).toBe(false)
 expect(moveFromExhausted).toHaveBeenCalledOnce();expect(moveToPreferred).not.toHaveBeenCalled();expect(request).toHaveBeenCalledOnce()
})
it.each(['SETUP_TOKEN_START_UNAVAILABLE','SETUP_TOKEN_START_ACCOUNT_EXHAUSTED'])('fails closed when %s cannot recover',async message=>{
 const moveFromExhausted=vi.fn(async()=>false)
 await expect(waitForSetupTokenStart({request:async()=>{throw new Error(message)},moveFromExhausted,notify:vi.fn(),signal:new AbortController().signal})).rejects.toThrow(message)
 expect(moveFromExhausted).toHaveBeenCalledTimes(message.endsWith('ACCOUNT_EXHAUSTED')?1:0)
})

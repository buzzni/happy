import { afterEach, expect, it, vi } from 'vitest'
import { createSetupTokenActivityReporter } from './setupTokenActivity'
afterEach(() => vi.useRealTimers())
it('captures the actual binding, heartbeats, closes a turn and starts another identity', async () => {
  vi.useFakeTimers()
  const report = vi.fn(async () => ({ ok: true })), warn = vi.fn()
  let binding: string | undefined = 'binding-a'
  const r = createSetupTokenActivityReporter({ sessionId: () => 's', binding: () => binding, report, warn })
  r.thinking(true); await r.flush()
  binding = 'binding-b'
  await vi.advanceTimersByTimeAsync(20000)
  r.thinking(false); await r.flush()
  r.thinking(true); await r.flush()
  const calls = report.mock.calls as unknown as Array<[string, string, { instanceId: string; turnId: string; seq: number; state: string }]>
  expect(calls.map(c => [c[1], c[2].state])).toEqual([['binding-a','active'],['binding-a','active'],['binding-a','finished'],['binding-b','active']])
  expect(calls[0][2].turnId).not.toBe(calls[3][2].turnId)
  expect(calls[2][2].seq).toBeGreaterThan(calls[1][2].seq)
  await r.dispose(); expect(report).toHaveBeenLastCalledWith('s', 'binding-b', expect.objectContaining({state:'finished'}))
})
it('keeps the turn running across reporting failure and retries terminal reports without resurrecting it', async () => {
  vi.useFakeTimers()
  const report = vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValue({ok:true}), warn = vi.fn()
  const r = createSetupTokenActivityReporter({sessionId:()=> 's',binding:()=> 'binding',report,warn})
  r.thinking(true); await r.flush(); expect(warn).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(20000); r.thinking(false); await r.dispose()
  expect(report.mock.calls.at(-1)?.[2].state).toBe('finished')
})
it('does not report personal or unbound execution', async () => {
  const report = vi.fn(), r = createSetupTokenActivityReporter({sessionId:()=> 's',binding:()=>undefined,report,warn:vi.fn()})
  r.thinking(true); await r.dispose(); expect(report).not.toHaveBeenCalled()
})

it('coalesces heartbeats while a report is slow and retries the same terminal sequence', async () => {
  vi.useFakeTimers()
  let release!: (value: {ok:boolean}) => void
  const report = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValueOnce({ok:false}).mockResolvedValue({ok:true})
  const r = createSetupTokenActivityReporter({sessionId:()=> 's',binding:()=> 'b',report,warn:vi.fn()})
  r.thinking(true); await Promise.resolve()
  await vi.advanceTimersByTimeAsync(200000)
  r.thinking(false)
  release({ok:true}); await r.dispose()
  expect(report.mock.calls.map(c => c[2].state)).toEqual(['active','finished','finished'])
  expect(report.mock.calls[1][2]).toEqual(report.mock.calls[2][2])
})

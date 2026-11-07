import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { observeAutomationContextChild, reportAutomationContextExit } from './automationContextExit'

vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn() } }))
afterEach(() => vi.useRealTimers())
const input = () => ({ sessionId: 'automation-run:r1', provider: 'codex' as const,
  evidence: { providerExitedCleanly: true, foregroundDrained: true, backgroundDrained: true, writeProducersDrained: true } })

it('reports only bounded private exit evidence and waits for the IPC delivery callback even under backpressure', async () => {
  let delivered!: (error: Error | null) => void
  const send = vi.fn((_message, done) => { delivered = done; return false })
  let settled = false
  const pending = reportAutomationContextExit(input(), { connected: true, send }).then(value => { settled = true; return value })
  expect(settled).toBe(false)
  expect(send.mock.calls[0][0]).toEqual({ type: 'automation-context-exit', version: 1, ...input() })
  delivered(null); expect(await pending).toBe(true)
})

it('does not attach ordinary manual sessions to the automatic-exit protocol', async () => {
  const send = vi.fn()
  expect(await reportAutomationContextExit({ ...input(), sessionId: 'manual-session' }, { connected: true, send })).toBe(false)
  expect(send).not.toHaveBeenCalled()
})

it.each(['disconnected', 'error', 'timeout'])('reports an unconfirmed IPC delivery on %s without hanging shutdown', async reason => {
  vi.useFakeTimers()
  const send = vi.fn((_message, done) => { if (reason === 'error') done(new Error('closed')); return true })
  const result = reportAutomationContextExit(input(), { connected: reason !== 'disconnected', send })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(await result).toBe(false)
  if (reason === 'disconnected') expect(send).not.toHaveBeenCalled()
})

it('rejects malformed or unbounded evidence instead of sending permissive truthy flags or private task fields', async () => {
  const send = vi.fn()
  for (const changed of [{ sessionId: 'automation-run:../other' }, { provider: 'gemini' },
    { evidence: { ...input().evidence, providerExitedCleanly: 1 } }, { initialPrompt: 'private task' }]) {
    await expect(reportAutomationContextExit({ ...input(), ...changed } as Parameters<typeof reportAutomationContextExit>[0],
      { connected: true, send })).rejects.toThrow()
  }
  expect(send).not.toHaveBeenCalled()
})

it.each(['clean', 'missing', 'wrong-session', 'wrong-provider', 'partial', 'conflict', 'nonzero', 'persistence-failure'])(
  'accepts only matching private IPC plus owned clean child close (%s)', async kind => {
    const message = { type: 'automation-context-exit', version: 1, ...input() }
    if (kind === 'wrong-session') message.sessionId = 'automation-run:other'
    if (kind === 'wrong-provider') (message as { provider: string }).provider = 'claude'
    if (kind === 'partial') message.evidence.backgroundDrained = false
    const messages = kind === 'missing' ? [] : [message]
    if (kind === 'conflict') messages.push({ ...message, evidence: { ...message.evidence, writeProducersDrained: false } })
    const child = spawn(process.execPath, ['-e', `
      for (const message of ${JSON.stringify(messages)}) process.send(message);
      process.exitCode = ${kind === 'nonzero' ? 1 : 0};
      process.disconnect();
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let release!: () => void
    const durable = new Promise<void>(resolve => { release = resolve })
    const persist = vi.fn(() => { if (kind === 'persistence-failure') throw new Error('fsync failed'); return durable })
    const result = observeAutomationContextChild({ child, sessionId: input().sessionId, provider: input().provider, persist })
    let settled = false
    void result.then(() => { settled = true })
    try {
      if (kind === 'clean') {
        await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
        expect(child.exitCode).toBe(0)
        expect(settled).toBe(false)
      }
    } finally { release() }
    expect(await result).toBe(kind === 'clean')
    expect(persist).toHaveBeenCalledTimes(kind === 'clean' || kind === 'persistence-failure' ? 1 : 0)
  })

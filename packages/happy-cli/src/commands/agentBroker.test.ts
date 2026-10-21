import { afterEach, describe, expect, it } from 'vitest'
import { startAgentBroker } from './agentBroker'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())) })
describe('session agent broker', () => {
  it('rejects caller env, browser origins and unauthenticated requests; preserves model options', async () => {
    const calls: string[][] = []
    const broker = await startAgentBroker({ execute: async (argv) => {
      calls.push(argv); return { stdout: '{"ok":true}\n', exitCode: 0 }
    } })
    cleanup.push(broker.close)
    const send = (body: unknown, headers: Record<string, string> = {}) => fetch(broker.environment.SAYCODE_AGENT_BROKER_URL, {
      method: 'POST', headers: { authorization: `Bearer ${broker.environment.SAYCODE_AGENT_BROKER_CAPABILITY}`, ...headers }, body: JSON.stringify(body),
    })
    expect((await send({ version: 1, argv: ['whoami'] }, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await send({ version: 1, argv: ['whoami'] }, { origin: 'https://evil.test' })).status).toBe(403)
    expect((await send({ version: 1, argv: ['whoami'], env: { SAYCODE_AGENT_DEPTH: '0' } })).status).toBe(400)
    expect((await send({ version: 2, argv: ['whoami'] })).status).toBe(400)
    expect((await send({ version: 1, argv: ['login'] })).status).toBe(400)
    expect((await send({ version: 1, argv: ['spawn', '--prompt', 'x'.repeat(1024 * 1024)] })).status).toBe(413)
    const argv = ['spawn', '--agent', 'codex', '--model', 'gpt-6-astra', '--effort', 'high', '--prompt', 'review']
    expect(await (await send({ version: 1, argv })).json()).toEqual({ stdout: '{"ok":true}\n', exitCode: 0 })
    expect(calls).toEqual([argv])
  })
  it('serializes spawn admission and revokes active calls on close', async () => {
    let release!: () => void
    let cancelled = false
    const broker = await startAgentBroker({ execute: async (_argv, signal) => {
      signal.addEventListener('abort', () => { cancelled = true; release() })
      await new Promise<void>(resolve => { release = resolve })
      return { stdout: '{"ok":true}\n', exitCode: 0 }
    } })
    const send = () => fetch(broker.environment.SAYCODE_AGENT_BROKER_URL, { method: 'POST',
      headers: { authorization: `Bearer ${broker.environment.SAYCODE_AGENT_BROKER_CAPABILITY}` },
      body: JSON.stringify({ version: 1, argv: ['spawn', '--prompt', 'review'] }) })
    const first = send().catch(() => null)
    while (!release) await new Promise(r => setTimeout(r, 5))
    expect((await send())?.status).toBe(409)
    await broker.close(); await first
    expect(cancelled).toBe(true)
    await expect(send()).rejects.toThrow()
  })
})

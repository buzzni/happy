import { describe, expect, it, vi } from 'vitest'
import { createRequestEnvironmentMemory } from './requestEnvironmentMemory'

describe('createRequestEnvironmentMemory', () => {
  it('remembers the environment a client sent for the session a spawn started', async () => {
    const memory = createRequestEnvironmentMemory()
    const spawn = memory.rememberSpawn(vi.fn(async (_options: { directory: string; environmentVariables?: Record<string, string> }) => (
      { type: 'success' as const, sessionId: 'session-1' })))

    await spawn({ directory: '/chat', environmentVariables: { ORG_SECRET: 'org-value' } })

    expect(memory.recall('session-1')).toEqual({ ORG_SECRET: 'org-value' })
  })

  it('updates the memory from a resume or a recovery that carried an environment', async () => {
    const memory = createRequestEnvironmentMemory()
    const resume = memory.rememberResume(vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' })))
    const recover = memory.rememberResume(vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-2' })))

    await resume('session-1', { environmentVariables: { ORG_SECRET: 'first' } })
    await resume('session-1', {})
    expect(memory.recall('session-1')).toEqual({ ORG_SECRET: 'first' })

    // A new-session recovery continues the conversation under the returned id.
    await recover('session-1', { environmentVariables: { ORG_SECRET: 'second' } })
    expect(memory.recall('session-2')).toEqual({ ORG_SECRET: 'second' })
  })

  it('remembers nothing for a failed start or an empty environment', async () => {
    const memory = createRequestEnvironmentMemory()
    await memory.rememberSpawn(vi.fn(async () => ({ type: 'error' as const, errorMessage: 'nope' })))({ environmentVariables: { A: '1' } })
    await memory.rememberResume(vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' })))('session-1', { environmentVariables: {} })

    expect(memory.recall('session-1')).toBeUndefined()
  })

  it('keeps a bounded number of sessions, dropping the least recently remembered', async () => {
    const memory = createRequestEnvironmentMemory(2)
    const resume = memory.rememberResume(async (sessionId: string) => ({ type: 'success' as const, sessionId }))

    await resume('a', { environmentVariables: { K: 'a' } })
    await resume('b', { environmentVariables: { K: 'b' } })
    await resume('a', { environmentVariables: { K: 'a2' } })
    await resume('c', { environmentVariables: { K: 'c' } })

    expect(memory.recall('b')).toBeUndefined()
    expect(memory.recall('a')).toEqual({ K: 'a2' })
    expect(memory.recall('c')).toEqual({ K: 'c' })
  })
})

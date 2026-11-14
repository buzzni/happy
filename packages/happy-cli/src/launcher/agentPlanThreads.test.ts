import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentPlanThreadsDir, isAgentPlanThread, recordAgentPlanThread, hasClaudeAgentPlanThread, readAgentPlanThread } from './agentPlanThreads'

const homes: string[] = []
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }) })
function dir(): string {
    const home = mkdtempSync(join(tmpdir(), 'agent-plan-threads-'))
    homes.push(home)
    return agentPlanThreadsDir(home)
}

describe('agent plan thread markers (spec §6.3-4)', () => {
    it('marks a thread a plan session ran, owner-only and without the grant secret', async () => {
        const threads = dir()
        expect(isAgentPlanThread(threads, 'thread-1')).toBe(false)
        await recordAgentPlanThread(threads, 'thread-1', { sessionId: 'happy-1', grantId: 'grant-1' })
        expect(isAgentPlanThread(threads, 'thread-1')).toBe(true)
        expect(isAgentPlanThread(threads, 'thread-2')).toBe(false)
        const path = join(threads, 'thread-1.json')
        expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
            version: 1, source: 'platform-plan', sessionId: 'happy-1', grantId: 'grant-1', descriptorVersion: 1,
        })
        expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).not.toContain('secret')
    })

    it('keeps the first record when the same thread is marked again', async () => {
        const threads = dir()
        await recordAgentPlanThread(threads, 'thread-1', { sessionId: 'happy-1', grantId: 'grant-1' })
        await recordAgentPlanThread(threads, 'thread-1', { sessionId: 'happy-2', grantId: 'grant-2' })
        expect(JSON.parse(readFileSync(join(threads, 'thread-1.json'), 'utf8')).sessionId).toBe('happy-1')
    })

    it('updates Claude authority after an authorized continuation so another continuation validates the latest grant', async () => {
        const threads = dir()
        await recordAgentPlanThread(threads, 'claude-1', { sessionId: 'happy-1', grantId: 'grant-1', agent: 'claude' })
        await recordAgentPlanThread(threads, 'claude-1', { sessionId: 'happy-2', grantId: 'grant-2', agent: 'claude' })
        expect(JSON.parse(readFileSync(join(threads, 'claude-1.json'), 'utf8')).grantId).toBe('grant-2')
    })

    it('treats a corrupt marker as guarded without breaking unrelated fresh launches', () => {
        const threads = dir(); mkdirSync(threads, { recursive: true })
        writeFileSync(join(threads, 'broken.json'), '{partial')
        expect(hasClaudeAgentPlanThread(threads)).toBe(true)
        expect(() => readAgentPlanThread(threads, 'broken')).toThrow()
    })

    it('never treats a path-like id as a thread', async () => {
        const threads = dir()
        expect(isAgentPlanThread(threads, '../../etc/passwd')).toBe(false)
        await expect(recordAgentPlanThread(threads, '../escape', { sessionId: 's', grantId: 'g' })).rejects.toThrow()
    })
})

import { describe, expect, it } from 'vitest'
import {
    WORKER_AGENT_NAME,
    buildWorkerAgents,
    readWorkerConfigFromEnv,
} from './workerAgents'

describe('buildWorkerAgents', () => {
    it('returns a no-op result when no worker model is set', () => {
        expect(buildWorkerAgents({})).toEqual({ delegationPrompt: '' })
        expect(buildWorkerAgents({ workerModel: null })).toEqual({ delegationPrompt: '' })
        expect(buildWorkerAgents({ workerModel: '' })).toEqual({ delegationPrompt: '' })
    })

    it('treats inherit/default as disabled (no cost saving)', () => {
        for (const model of ['inherit', 'default', 'INHERIT', ' Default ']) {
            expect(buildWorkerAgents({ workerModel: model })).toEqual({ delegationPrompt: '' })
        }
    })

    it('registers a worker subagent bound to the given model', () => {
        const result = buildWorkerAgents({ workerModel: 'haiku' })
        expect(result.agents).toBeDefined()
        const worker = result.agents![WORKER_AGENT_NAME]
        expect(worker.model).toBe('haiku')
        expect(worker.description).toMatch(/mechanical/i)
        expect(worker.prompt).toMatch(/worker/i)
        expect(result.delegationPrompt).toMatch(new RegExp(WORKER_AGENT_NAME))
        expect(result.delegationPrompt).toMatch(/delegate/i)
    })

    it('defers explicit durable child requests to Saycode session orchestration', () => {
        const prompt = buildWorkerAgents({ workerModel: 'haiku' }).delegationPrompt
        expect(prompt).toContain('visible, reopenable, or controllable later')
        expect(prompt).toContain('do not use this Task/Agent worker')
        expect(prompt).toContain('happy agent')
    })

    it('accepts a full model id and trims whitespace', () => {
        const worker = buildWorkerAgents({ workerModel: '  claude-haiku-4-5  ' }).agents![WORKER_AGENT_NAME]
        expect(worker.model).toBe('claude-haiku-4-5')
    })

    it('sets worker effort when valid, omits it otherwise', () => {
        expect(buildWorkerAgents({ workerModel: 'sonnet', workerEffort: 'low' }).agents![WORKER_AGENT_NAME].effort).toBe('low')
        expect(buildWorkerAgents({ workerModel: 'sonnet', workerEffort: 'bogus' }).agents![WORKER_AGENT_NAME].effort).toBeUndefined()
        expect(buildWorkerAgents({ workerModel: 'sonnet' }).agents![WORKER_AGENT_NAME].effort).toBeUndefined()
    })
})

describe('readWorkerConfigFromEnv', () => {
    it('reads worker model and effort from HAPPY_WORKER_* env', () => {
        expect(readWorkerConfigFromEnv({ HAPPY_WORKER_MODEL: 'haiku', HAPPY_WORKER_EFFORT: 'low' }))
            .toEqual({ workerModel: 'haiku', workerEffort: 'low' })
    })

    it('returns undefined fields when env is empty', () => {
        expect(readWorkerConfigFromEnv({})).toEqual({ workerModel: undefined, workerEffort: undefined })
    })

    it('round-trips through buildWorkerAgents from env', () => {
        const cfg = readWorkerConfigFromEnv({ HAPPY_WORKER_MODEL: 'sonnet', HAPPY_WORKER_EFFORT: 'medium' })
        const worker = buildWorkerAgents(cfg).agents![WORKER_AGENT_NAME]
        expect(worker.model).toBe('sonnet')
        expect(worker.effort).toBe('medium')
    })
})

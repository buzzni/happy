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

    it('maps Z.AI worker models to Claude aliases and disables Fable', () => {
        const zaiEnv = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }

        expect(readWorkerConfigFromEnv({
            ...zaiEnv,
            HAPPY_WORKER_MODEL: 'claude-sonnet-5',
        }).workerModel).toBe('sonnet')
        expect(readWorkerConfigFromEnv({
            ...zaiEnv,
            HAPPY_WORKER_MODEL: 'claude-fable-5',
        }).workerModel).toBeUndefined()
    })

    // 'default'/'inherit' 는 여기서 "메인 모델 상속 = 위임 끄기" 라는 뜻이다.
    // 런타임 정규화가 이를 구체 모델로 번역하면 z.ai 세션에서만 위임이 켜지고
    // orchestrator 시스템 프롬프트까지 바뀐다. 기존 테스트는 buildWorkerAgents 를
    // 직접 호출해(정규화를 건너뛰어) 이 조합을 한 번도 밟지 않았다.
    it('keeps the inherit sentinel intact on Z.AI so delegation stays off', () => {
        const zaiEnv = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }
        for (const model of ['default', 'inherit', ' Default ']) {
            const cfg = readWorkerConfigFromEnv({ ...zaiEnv, HAPPY_WORKER_MODEL: model })
            expect(buildWorkerAgents(cfg)).toEqual({ delegationPrompt: '' })
        }
    })

    it('round-trips through buildWorkerAgents from env', () => {
        const cfg = readWorkerConfigFromEnv({ HAPPY_WORKER_MODEL: 'sonnet', HAPPY_WORKER_EFFORT: 'medium' })
        const worker = buildWorkerAgents(cfg).agents![WORKER_AGENT_NAME]
        expect(worker.model).toBe('sonnet')
        expect(worker.effort).toBe('medium')
    })
})

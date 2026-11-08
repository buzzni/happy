import { describe, expect, it } from 'vitest'
import { foldModelToOrgEndpoint, isOrgEndpointRuntime } from './orgEndpointModel'

// aplus specs/org-llm-endpoints r2 — the endpoint only knows its own model names.
const endpointEnv = {
    HAPPY_AI_AUTH_SOURCE: 'org-endpoint',
    ANTHROPIC_MODEL: 'corp-model',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'corp-big',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'corp-model',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'corp-small',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'corp-big',
}

describe('foldModelToOrgEndpoint', () => {
    it.each([
        ['opus', 'corp-big'], ['sonnet', 'corp-model'], ['haiku', 'corp-small'], ['fable', 'corp-big'],
        ['opus[1m]', 'corp-big'], ['haiku[1m]', 'corp-small'],
    ])('maps the tier alias %s to the endpoint mapping %s', (alias, mapped) => {
        expect(foldModelToOrgEndpoint(alias, endpointEnv)).toBe(mapped)
    })

    it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5', 'claude-haiku-4-5', 'default', 'opusplan', 'something-else', 'sonnet-4-6'])(
        'folds %s to the endpoint model, which is all the endpoint serves', (requested) => {
            expect(foldModelToOrgEndpoint(requested, endpointEnv)).toBe('corp-model')
        })

    it('leaves a name the endpoint itself defines alone, so folding twice changes nothing', () => {
        for (const own of ['corp-model', 'corp-big', 'corp-small']) expect(foldModelToOrgEndpoint(own, endpointEnv)).toBe(own)
        const once = foldModelToOrgEndpoint('claude-opus-5-5', endpointEnv)
        expect(foldModelToOrgEndpoint(once, endpointEnv)).toBe(once)
    })

    it('has no model to fold when none was requested', () => {
        expect(foldModelToOrgEndpoint(undefined, endpointEnv)).toBeUndefined()
        expect(foldModelToOrgEndpoint('', endpointEnv)).toBe('')
    })

    it('does nothing outside an endpoint session', () => {
        expect(foldModelToOrgEndpoint('claude-opus-5-5', { ANTHROPIC_MODEL: 'corp-model' })).toBe('claude-opus-5-5')
        expect(foldModelToOrgEndpoint('claude-opus-5-5', { ...endpointEnv, HAPPY_AI_AUTH_SOURCE: 'org-bundle' })).toBe('claude-opus-5-5')
    })

    it('does not guess when the session names no model', () => {
        expect(foldModelToOrgEndpoint('claude-opus-5-5', { HAPPY_AI_AUTH_SOURCE: 'org-endpoint' })).toBe('claude-opus-5-5')
        expect(isOrgEndpointRuntime({ HAPPY_AI_AUTH_SOURCE: 'org-endpoint' })).toBe(false)
        expect(isOrgEndpointRuntime(endpointEnv)).toBe(true)
    })
})

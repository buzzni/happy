import { describe, expect, it } from 'vitest'
import { assertRemoteOnlyForOrgEndpoint, orgEndpointLocalModeRefusal } from './orgEndpointLocalMode'

// aplus specs/org-llm-endpoints r3 — the terminal's Claude is a global install the daemon cannot pin or verify.
describe('orgEndpointLocalModeRefusal', () => {
    it('refuses an organization LLM endpoint session with a sentence the user can act on', () => {
        const refusal = orgEndpointLocalModeRefusal({ HAPPY_AI_AUTH_SOURCE: 'org-endpoint' })
        expect(refusal).toMatch(/사내 LLM/)
        expect(refusal).toMatch(/터미널/)
        expect(refusal).not.toMatch(/org-endpoint|HAPPY_/)
    })

    it.each(['org-bundle', 'personal-subscription', 'zai', ''])('lets a session on %s switch', source => {
        expect(orgEndpointLocalModeRefusal({ HAPPY_AI_AUTH_SOURCE: source })).toBeUndefined()
    })

    it('lets a session with no recorded source switch', () => {
        expect(orgEndpointLocalModeRefusal({})).toBeUndefined()
    })
})

describe('assertRemoteOnlyForOrgEndpoint', () => {
    it('stops an endpoint session that is about to start or continue in the terminal', () => {
        expect(() => assertRemoteOnlyForOrgEndpoint({ HAPPY_AI_AUTH_SOURCE: 'org-endpoint' }, 'local')).toThrow(/터미널/)
    })

    it('lets an endpoint session run remote and every other session run in either mode', () => {
        expect(() => assertRemoteOnlyForOrgEndpoint({ HAPPY_AI_AUTH_SOURCE: 'org-endpoint' }, 'remote')).not.toThrow()
        expect(() => assertRemoteOnlyForOrgEndpoint({ HAPPY_AI_AUTH_SOURCE: 'org-bundle' }, 'local')).not.toThrow()
        expect(() => assertRemoteOnlyForOrgEndpoint({}, 'local')).not.toThrow()
    })
})

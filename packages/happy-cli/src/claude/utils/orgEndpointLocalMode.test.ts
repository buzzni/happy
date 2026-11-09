import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PersistedSession } from '@/persistence'
import { ORG_ENDPOINT_BINDING_ENV } from '@/utils/childEnv'
import { assertRemoteOnlyForOrgEndpoint, orgEndpointContinuationRefusal, orgEndpointLocalModeRefusal } from './orgEndpointLocalMode'

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

// The two entries into local mode that have no test harness of their own: the runner's start and the mode loop.
describe('every way into local mode asks the same refusal', () => {
    const source = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8')

    it('stops a start in local mode and a loop turning local, before the terminal\'s Claude could run', () => {
        expect(source('runClaude.ts')).toMatch(/assertRemoteOnlyForOrgEndpoint\(process\.env, options\.startingMode \?\? 'local'\);/)
        expect(source('loop.ts')).toMatch(/assertRemoteOnlyForOrgEndpoint\(process\.env, mode\);\s*switch \(mode\) \{/)
    })

    it('stops a start that would continue an endpoint conversation, before the session or Claude exists', () => {
        expect(source('runClaude.ts')).toMatch(/assertRemoteOnlyForOrgEndpoint\(process\.env, options\.startingMode \?\? 'local'\);\s*const continuationRefusal = orgEndpointContinuationRefusal\(\{\s*env: process\.env, claudeArgs: options\.claudeArgs,\s*lastConversation: \(\) => claudeFindLastSession\(workingDirectory\), records: readPersistedSessions\(\),\s*\}\);\s*if \(continuationRefusal\) throw new Error\(continuationRefusal\);/)
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

// `happy claude --resume <id>` (what `happy resume` runs) carries no endpoint env, so the guard above cannot see it.
describe('orgEndpointContinuationRefusal', () => {
    const record = (claudeSessionId: string, env?: Record<string, string>): PersistedSession => ({
        encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 1, metadataVersion: 1, agentStateVersion: 1, savedAt: 1,
        metadata: { path: '/p', host: 'h', claudeSessionId }, ...(env ? { agentEnvironment: env } : {}),
    } as PersistedSession)
    const records = {
        bound: record('aaaa-endpoint', { [ORG_ENDPOINT_BINDING_ENV]: 'b:e:t:1' }),
        // A corrupt binding is still a binding.
        corrupt: record('cccc-corrupt', { [ORG_ENDPOINT_BINDING_ENV]: '' }),
        plain: record('bbbb-plain'),
    }
    const refusal = (claudeArgs: string[] | undefined, last: string | null = null, env: Record<string, string> = {}) =>
        orgEndpointContinuationRefusal({ env, claudeArgs, lastConversation: () => last, records })

    it.each([
        [['--resume', 'aaaa-endpoint']], [['-r', 'aaaa-endpoint']], [['--resume=aaaa-endpoint']],
        [['--happy-starting-mode', 'remote', '--resume', 'aaaa-endpoint']], [['--resume', 'cccc-corrupt']],
    ])('refuses a launch naming an endpoint conversation (%j), in either mode', (args) => {
        expect(refusal(args)).toMatch(/사내 LLM/)
    })

    it.each([[['--continue']], [['-c']], [['--resume']], [['-r', '--verbose']]])('refuses %j when it picks an endpoint conversation as the last one', (args) => {
        expect(refusal(args, 'aaaa-endpoint')).toMatch(/사내 LLM/)
        expect(refusal(args, 'bbbb-plain')).toBeUndefined()
        expect(refusal(args, null)).toBeUndefined()
    })

    it('lets a launch continue any other conversation, or none', () => {
        expect(refusal(['--resume', 'bbbb-plain'], 'aaaa-endpoint')).toBeUndefined()
        expect(refusal([], 'aaaa-endpoint')).toBeUndefined()
        expect(refusal(undefined, 'aaaa-endpoint')).toBeUndefined()
    })

    it('lets the endpoint session itself continue its conversation', () => {
        expect(refusal(['--resume', 'aaaa-endpoint'], null, { HAPPY_AI_AUTH_SOURCE: 'org-endpoint' })).toBeUndefined()
    })
})

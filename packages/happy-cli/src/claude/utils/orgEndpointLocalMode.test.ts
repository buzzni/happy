import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { markOrgEndpointConversation } from './orgEndpointConversation'
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

    it('stops the terminal\'s Claude itself, so the offline fallback that calls it directly is covered too', () => {
        expect(source('claudeLocal.ts')).toMatch(/\}\) \{\s*\/\/[^\n]*\n\s*assertRemoteOnlyForOrgEndpoint\(process\.env, 'local'\);\s*\/\/ Ensure project directory exists/)
    })

    it('stops a start that would continue an endpoint conversation, before the session or Claude exists', () => {
        expect(source('runClaude.ts')).toMatch(/assertRemoteOnlyForOrgEndpoint\(process\.env, options\.startingMode \?\? 'local'\);\s*const continuationRefusal = orgEndpointContinuationRefusal\(\{\s*env: process\.env, claudeArgs: options\.claudeArgs, projectDir: getProjectPath\(workingDirectory\),\s*lastConversation: \(\) => claudeFindLastSession\(workingDirectory\),\s*\}\);\s*if \(continuationRefusal\) throw new Error\(continuationRefusal\);/)
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
    const ENDPOINT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
    const PLAIN = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
    const projects = mkdtempSync(join(tmpdir(), 'org-endpoint-continuation-'))
    const repo = join(projects, '-work-repo')
    const otherRepo = join(projects, '-work-other')
    markOrgEndpointConversation(repo, ENDPOINT, { version: 1, bindingId: 'b', endpointId: 'e' })
    const refusal = (claudeArgs: string[] | undefined, last: string | null = null, env: Record<string, string> = {}, projectDir = repo) =>
        orgEndpointContinuationRefusal({ env, claudeArgs, projectDir, lastConversation: () => last })

    it.each([
        [['--resume', ENDPOINT]], [['-r', ENDPOINT]], [[`--resume=${ENDPOINT}`]], [['--resume', ENDPOINT.toUpperCase()]],
        [['--happy-starting-mode', 'remote', '--resume', ENDPOINT]], [['--resume', ENDPOINT, '--fork-session']],
    ])('refuses a launch naming an endpoint conversation (%j), in either mode', (args) => {
        expect(refusal(args)).toMatch(/사내 LLM/)
    })

    it('refuses a named endpoint conversation from another project directory too', () => {
        expect(refusal(['--resume', ENDPOINT], null, {}, otherRepo)).toMatch(/사내 LLM/)
    })

    it.each([[['--continue']], [['-c']]])('refuses %j when it picks an endpoint conversation as the last one', (args) => {
        expect(refusal(args, ENDPOINT)).toMatch(/사내 LLM/)
        expect(refusal(args, PLAIN)).toBeUndefined()
        expect(refusal(args, null)).toBeUndefined()
    })

    it.each([[['--resume']], [['-r']], [['--resume', '--verbose']]])('refuses Claude\'s own picker (%j) where it would list an endpoint conversation', (args) => {
        expect(refusal(args)).toMatch(/사내 LLM/)
        expect(refusal(args, null, {}, otherRepo)).toBeUndefined()
    })

    it('lets a launch continue any other conversation, or none', () => {
        expect(refusal(['--resume', PLAIN], ENDPOINT)).toBeUndefined()
        expect(refusal([], ENDPOINT)).toBeUndefined()
        expect(refusal(undefined, ENDPOINT)).toBeUndefined()
    })

    it('lets the endpoint session itself continue its conversation', () => {
        expect(refusal(['--resume', ENDPOINT], null, { HAPPY_AI_AUTH_SOURCE: 'org-endpoint' })).toBeUndefined()
    })
})

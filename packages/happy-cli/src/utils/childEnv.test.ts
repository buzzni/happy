import { describe, expect, it } from 'vitest'
import { buildManagedSessionSpawnEnvironment } from '../daemon/sessionEnv'
import { NON_INHERITABLE_ENV, sanitizeChildEnv } from './childEnv'

describe('sanitizeChildEnv', () => {
    it.each(['valid-record', ''])('removes a bound child token before forgetting its lineage (%s)', (binding) => {
        const child = { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: binding, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-bound',
            HAPPY_AI_AUTH_SOURCE: 'org-bundle', SAFE: 'kept' }
        const daemon = sanitizeChildEnv(child)
        // After scoped revoke, an unbound session has no managed environment overlay.
        const unrelated = buildManagedSessionSpawnEnvironment(daemon, {}, {})
        expect(unrelated).toEqual({ SAFE: 'kept' })
        expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-bound')
    })

    it('removes reconnect and fork lineage variables while keeping everything else', () => {
        // 2026-07-19 incident: a resumed child restarted the daemon, the daemon
        // inherited HAPPY_RECONNECT_* from that child, and every subsequently
        // spawned session reconnected to the same happy session instead of
        // creating its own — chats from every project queued into one session.
        const env = {
            PATH: '/usr/bin',
            HAPPY_HOME_DIR: '/Users/u/.happy_remote',
            HAPPY_RECONNECT_SESSION_ID: 'cmr-poisoned',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'key',
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'legacy',
            HAPPY_RECONNECT_SEQ: '119',
            HAPPY_RECONNECT_METADATA_VERSION: '3',
            HAPPY_RECONNECT_AGENT_STATE_VERSION: '4',
            HAPPY_RECONNECT_SNAPSHOT: 'snapshot',
            HAPPY_FORKED_FROM_SESSION_ID: 'cmr-parent',
            HAPPY_FORKED_FROM_MESSAGE_ID: 'msg-1',
            HAPPY_FORK_CLAUDE_SESSION_ID: 'claude-1',
            HAPPY_FORK_CODEX_THREAD_ID: 'codex-1',
            HAPPY_CREATED_BY_ACCOUNT_ID: 'acct-stale',
            HAPPY_CREATED_BY_DISPLAY_NAME: 'Stale Name',
            // A scheduled run's child must not be recorded as a scheduled run too.
            HAPPY_CREATED_BY_SOURCE: 'schedule',
            HAPPY_INITIAL_PROMPT: 'stale automation prompt',
            HAPPY_INITIAL_MODEL: 'stale-model',
            HAPPY_INITIAL_EFFORT: 'stale-effort',
            HAPPY_AUTOMATION_RUN_ONCE: '1',
            APLUS_SESSION_URL: 'https://saycode.ai/session/parent-session',
            APLUS_SESSION_ID: 'parent-session',
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/parent',
            HAPPY_CHECKPOINT_SPAWN_CONTEXT: '{"schemaVersion":1,"projectId":"stale","worktreeId":null,"checkpointRoot":"/stale"}',
        }
        const scrubbed = sanitizeChildEnv(env)
        expect(scrubbed).toEqual({
            PATH: '/usr/bin',
            HAPPY_HOME_DIR: '/Users/u/.happy_remote',
        })
        // input is not mutated — resumeSession re-adds its own explicit values
        expect(env.HAPPY_RECONNECT_SESSION_ID).toBe('cmr-poisoned')
    })

    it('removes an inherited applied AI auth source so it cannot be re-reported', () => {
        // The daemon can be restarted by a child and then inherits that child's
        // whole environment. An un-scrubbed HAPPY_AI_AUTH_SOURCE means every
        // later session on that machine meters its tokens against somebody
        // else's credential.
        const scrubbed = sanitizeChildEnv({
            PATH: '/usr/bin',
            HAPPY_AI_AUTH_SOURCE: 'personal-subscription',
            HAPPY_AI_AUTH_CONNECTION_VERSION: '7',
        })
        expect(scrubbed).toEqual({ PATH: '/usr/bin' })
    })

    it('drops undefined values so the result is safe for spawn env', () => {
        const scrubbed = sanitizeChildEnv({ KEEP: 'x', GONE: undefined })
        expect(scrubbed).toEqual({ KEEP: 'x' })
    })

    it('covers every lineage prefix used by spawn/resume paths', () => {
        expect(NON_INHERITABLE_ENV).toContain('HAPPY_RECONNECT_')
        expect(NON_INHERITABLE_ENV).toContain('HAPPY_FORK')
        expect(NON_INHERITABLE_ENV).toContain('HAPPY_CREATED_BY')
        // HAPPY_INITIAL_ covers PROMPT(_LOCAL_ID) and the MODEL/EFFORT seeds.
        expect(NON_INHERITABLE_ENV).toContain('HAPPY_INITIAL_')
        expect(NON_INHERITABLE_ENV).toContain('HAPPY_AUTOMATION_')
        // APLUS_SESSION_* is rewritten after the child confirms its id, but the
        // daemon still scrubs stale lineage before process launch.
        expect(NON_INHERITABLE_ENV).toContain('APLUS_SESSION_')
        expect(NON_INHERITABLE_ENV).toContain('SAYCODE_AGENT_')
        expect(NON_INHERITABLE_ENV).toContain('HAPPY_CHECKPOINT_')
    })
})

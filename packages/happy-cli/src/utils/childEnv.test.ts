import { describe, expect, it } from 'vitest'
import { buildManagedSessionSpawnEnvironment } from '../daemon/sessionEnv'
import { clearInheritedSessionLineage, NON_INHERITABLE_ENV, nonInheritableEnvEntry, sanitizeChildEnv } from './childEnv'

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
        const prefixes = NON_INHERITABLE_ENV.map((entry) => entry.prefix)
        expect(prefixes).toContain('HAPPY_RECONNECT_')
        expect(prefixes).toContain('HAPPY_FORK')
        expect(prefixes).toContain('HAPPY_CREATED_BY')
        // HAPPY_INITIAL_ covers PROMPT(_LOCAL_ID) and the MODEL/EFFORT seeds.
        expect(prefixes).toContain('HAPPY_INITIAL_')
        expect(prefixes).toContain('HAPPY_AUTOMATION_')
        // APLUS_SESSION_* is rewritten after the child confirms its id, but the
        // daemon still scrubs stale lineage before process launch.
        expect(prefixes).toContain('APLUS_SESSION_')
        expect(prefixes).toContain('SAYCODE_AGENT_')
        expect(prefixes).toContain('HAPPY_CHECKPOINT_')
    })

    it('matches names case-insensitively, as Windows resolves them', () => {
        expect(sanitizeChildEnv({
            happy_reconnect_session_id: 'cmr-poisoned',
            Happy_Fork_Claude_Session_Id: 'claude-1',
            saycode_agent_root: '/parent',
            Path: 'C:\\Windows',
        })).toEqual({ Path: 'C:\\Windows' })
    })

    it('drops a lower-case bound bearer with its lower-case binding marker', () => {
        expect(sanitizeChildEnv({ happy_ai_auth_setup_token_binding: 'x', claude_code_oauth_token: 'bound', SAFE: '1' })).toEqual({ SAFE: '1' })
    })

    it('drops the per-session browser task secret at every boundary', () => {
        const env = { HAPPY_BROWSER_TASK_SESSION_SECRET: 'secret', PATH: '/usr/bin' }
        expect(sanitizeChildEnv(env)).toEqual({ PATH: '/usr/bin' })
        expect(sanitizeChildEnv(env, { boundary: 'in-session' })).toEqual({ PATH: '/usr/bin' })
    })

    it('keeps what child runtimes need to run', () => {
        const required = {
            HOME: '/Users/u', PATH: '/usr/bin', SHELL: '/bin/zsh', TMPDIR: '/tmp/x', LANG: 'ko_KR.UTF-8',
            HAPPY_HOME_DIR: '/Users/u/.happy_remote', HAPPY_SERVER_URL: 'https://relay.example',
            HAPPY_WEBAPP_URL: 'https://saycode.ai', HAPPY_PROJECT_SANDBOX_CONFIG: '{}',
            CLAUDE_CONFIG_DIR: '/Users/u/.claude', CODEX_HOME: '/Users/u/.codex',
            ANTHROPIC_API_KEY: 'personal', HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:1',
        }
        expect(sanitizeChildEnv(required)).toEqual(required)
        expect(sanitizeChildEnv(required, { boundary: 'in-session' })).toEqual(required)
    })

    it('inside a session keeps its own scope and drops lineage and spawn seeds', () => {
        const env = {
            PATH: '/usr/bin',
            HAPPY_RECONNECT_SESSION_ID: 'cmr-1', HAPPY_RECONNECT_ENCRYPTION_KEY: 'key',
            HAPPY_FORK_CODEX_THREAD_ID: 'codex-1', HAPPY_CREATED_BY_ACCOUNT_ID: 'acct',
            HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: '/tmp/ctx', HAPPY_INITIAL_PROMPT: 'first prompt',
            APLUS_SESSION_ID: 'session-1', SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo',
            HAPPY_AI_AUTH_SOURCE: 'org-bundle', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: 'binding',
            CLAUDE_CODE_OAUTH_TOKEN: 'bound', HAPPY_CHECKPOINT_SPAWN_CONTEXT: '{}', HAPPY_WRITE_SCOPE_SESSION: '1',
        }
        expect(sanitizeChildEnv(env, { boundary: 'in-session' })).toEqual({
            PATH: '/usr/bin',
            APLUS_SESSION_ID: 'session-1', SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo',
            HAPPY_AI_AUTH_SOURCE: 'org-bundle', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: 'binding',
            // The bound token is the one this session's agent must spend.
            CLAUDE_CODE_OAUTH_TOKEN: 'bound', HAPPY_CHECKPOINT_SPAWN_CONTEXT: '{}', HAPPY_WRITE_SCOPE_SESSION: '1',
        })
    })

    it('classifies every entry by what its value names', () => {
        expect(nonInheritableEnvEntry('HAPPY_RECONNECT_SNAPSHOT')?.kind).toBe('session-lineage')
        expect(nonInheritableEnvEntry('HAPPY_INITIAL_MODEL')?.kind).toBe('spawn-seed')
        expect(nonInheritableEnvEntry('SAYCODE_AGENT_DEPTH')?.kind).toBe('session-scope')
        expect(nonInheritableEnvEntry('HAPPY_HOME_DIR')).toBeUndefined()
    })

    it('stays linear on a huge environment with long, prefix-like names', () => {
        const env: Record<string, string> = {}
        for (let index = 0; index < 20_000; index += 1) {
            env[`HAPPY_${'X'.repeat(512)}_${index}`] = 'v'.repeat(256)
            env[`HAPPY_RECONNECT_${index}`] = 'poison'
        }
        const started = performance.now()
        const sanitized = sanitizeChildEnv(env)
        const elapsed = performance.now() - started
        expect(Object.keys(sanitized)).toHaveLength(20_000)
        // ~40k keys × 14 prefixes; a quadratic or regex-backtracking matcher is orders of magnitude slower.
        expect(elapsed).toBeLessThan(2_000)
    })
})

describe('clearInheritedSessionLineage', () => {
    it('forgets another session in place and keeps this run\'s own seeds and scope', () => {
        const env: NodeJS.ProcessEnv = {
            PATH: '/usr/bin', HAPPY_RECONNECT_SESSION_ID: 'cmr-1', happy_forked_from_session_id: 'parent',
            HAPPY_CREATED_BY_ACCOUNT_ID: 'acct', HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: '/tmp/ctx',
            HAPPY_INITIAL_PROMPT: 'this run', APLUS_SESSION_ID: 'self',
        }
        clearInheritedSessionLineage(env)
        expect(env).toEqual({ PATH: '/usr/bin', HAPPY_INITIAL_PROMPT: 'this run', APLUS_SESSION_ID: 'self' })
    })
})

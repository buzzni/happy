import { describe, expect, it } from 'vitest'
import {
    buildResumedSessionSpawnEnvironment,
    buildSessionSpawnEnvironment,
    captureSaycodeAgentEnvironment,
    scrubSessionLineageEnv,
    SESSION_LINEAGE_ENV_PREFIXES,
} from './sessionEnv'

describe('scrubSessionLineageEnv', () => {
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
            HAPPY_INITIAL_PROMPT: 'stale automation prompt',
            HAPPY_INITIAL_MODEL: 'stale-model',
            HAPPY_INITIAL_EFFORT: 'stale-effort',
            HAPPY_AUTOMATION_RUN_ONCE: '1',
            APLUS_SESSION_URL: 'https://saycode.ai/session/parent-session',
            APLUS_SESSION_ID: 'parent-session',
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/parent',
        }
        const scrubbed = scrubSessionLineageEnv(env)
        expect(scrubbed).toEqual({
            PATH: '/usr/bin',
            HAPPY_HOME_DIR: '/Users/u/.happy_remote',
        })
        // input is not mutated — resumeSession re-adds its own explicit values
        expect(env.HAPPY_RECONNECT_SESSION_ID).toBe('cmr-poisoned')
    })

    it('drops undefined values so the result is safe for spawn env', () => {
        const scrubbed = scrubSessionLineageEnv({ KEEP: 'x', GONE: undefined })
        expect(scrubbed).toEqual({ KEEP: 'x' })
    })

    it('covers every lineage prefix used by spawn/resume paths', () => {
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_RECONNECT_')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_FORK')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_CREATED_BY')
        // HAPPY_INITIAL_ covers PROMPT(_LOCAL_ID) and the MODEL/EFFORT seeds.
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_INITIAL_')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_AUTOMATION_')
        // APLUS_SESSION_* is rewritten after the child confirms its id, but the
        // daemon still scrubs stale lineage before process launch.
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('APLUS_SESSION_')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('SAYCODE_AGENT_')
    })
})

describe('buildSessionSpawnEnvironment', () => {
    it('scrubs inherited lineage before applying the explicit spawn environment', () => {
        expect(buildSessionSpawnEnvironment(
            {
                PATH: '/usr/bin',
                HAPPY_RECONNECT_SESSION_ID: 'stale-session',
                APLUS_SESSION_ID: 'parent-session',
            },
            {
                HAPPY_RECONNECT_SESSION_ID: 'target-session',
                TASK_TOKEN: 'task-token',
            },
        )).toEqual({
            PATH: '/usr/bin',
            HAPPY_RECONNECT_SESSION_ID: 'target-session',
            TASK_TOKEN: 'task-token',
        })
    })
})

describe('Saycode agent resume environment', () => {
    it('captures only the validated Saycode agent capability fields', () => {
        expect(captureSaycodeAgentEnvironment({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '4',
            SAYCODE_AGENT_ID: 'child-1',
            SECRET: 'must-not-be-captured',
        })).toEqual({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '4',
            SAYCODE_AGENT_ID: 'child-1',
        })
    })

    it('restores the captured capability and current session id on resume', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: {
                PATH: '/usr/bin',
                SAYCODE_AGENT_ROOT: '/stale',
                APLUS_SESSION_ID: 'parent-session',
            },
            explicit: { HAPPY_RECONNECT_SESSION_ID: 'session-2' },
            agentEnvironment: {
                SAYCODE_AGENT_ENV: '1',
                SAYCODE_AGENT_ROOT: '/repo/app',
                SAYCODE_AGENT_DEPTH: '1',
                SAYCODE_AGENT_MAX_SPAWN: '4',
                SAYCODE_AGENT_ID: 'child-1',
            },
            sessionId: 'session-2',
        })).toEqual({
            PATH: '/usr/bin',
            HAPPY_RECONNECT_SESSION_ID: 'session-2',
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '4',
            SAYCODE_AGENT_ID: 'child-1',
            APLUS_SESSION_ID: 'session-2',
        })
    })

    it('does not invent agent capability for a legacy session', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/stale' },
            explicit: { HAPPY_RECONNECT_SESSION_ID: 'legacy-session' },
            sessionId: 'legacy-session',
        })).toEqual({
            HAPPY_RECONNECT_SESSION_ID: 'legacy-session',
            APLUS_SESSION_ID: 'legacy-session',
        })
    })
})

describe('mergeResumeSessionEnvironment', () => {
    it('strips lineage keys from inherited and runtime env while preserving trusted resume values', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: { KEEP_INHERITED: 'yes', HAPPY_RECONNECT_SESSION_ID: 'stale' },
            runtime: { KEEP_RUNTIME: 'yes', APLUS_SESSION_ID: 'forged' },
            automation: { KEEP_AUTOMATION: 'yes', HAPPY_AUTOMATION_ID: 'forged' },
            explicit: { HAPPY_RECONNECT_SESSION_ID: 'session-1' },
            sessionId: 'session-1',
        })).toEqual({
            KEEP_INHERITED: 'yes',
            KEEP_RUNTIME: 'yes',
            KEEP_AUTOMATION: 'yes',
            HAPPY_RECONNECT_SESSION_ID: 'session-1',
            APLUS_SESSION_ID: 'session-1',
        })
    })
})

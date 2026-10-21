import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every path that starts an agent, a session host or a user shell builds its
 * environment through utils/childEnv. A path that goes back to `...process.env`
 * is how the 2026-07-19 reconnect leak happened; the behaviour itself is tested
 * next to each path, this only keeps a new or rewritten path from skipping it.
 * Each entry is the call every spawn site in the file makes, and how many sites there are.
 */
const SPAWN_PATHS: Record<string, [call: string, sites: number]> = {
    'daemon/sessionEnv.ts': ['sanitizeChildEnv(', 4],
    'daemon/run.ts': ['sanitizeChildEnv(process.env)', 1],
    'utils/spawnHappyCLI.ts': ['sanitizeChildEnv(', 1],
    'channelHost/channelHostSupervisor.ts': ['sanitizeChildEnv(process.env)', 1],
    'claude/claudeLocal.ts': ["sanitizeChildEnv(process.env, { boundary: 'in-session' })", 1],
    'claude/sdk/query.ts': ["sanitizeChildEnv(process.env, { boundary: 'in-session' })", 1],
    'claude/utils/bashStream.ts': ["{ boundary: 'in-session' }", 1],
    'codex/codexAppServerClient.ts': ["sanitizeChildEnv(process.env, { boundary: 'in-session' })", 1],
    'memory/codexRecallHost.ts': ["sanitizeChildEnv(input.env, { boundary: 'in-session' })", 1],
    'memory/codexIngestHost.ts': ["sanitizeChildEnv(input.env, { boundary: 'in-session' })", 1],
    'agent/acp/AcpBackend.ts': ["sanitizeChildEnv(process.env, { boundary: 'in-session' })", 1],
    'daemon/remoteTerminal.ts': ['sanitizeChildEnv({ ...process.env, ...(opts.env ?? {}) })', 2],
    'daemon/automations/managedScriptRunner.ts': ['sanitizeChildEnv(', 2],
    'modules/common/registerCommonHandlers.ts': ['sanitizeChildEnv(process.env, { boundary: bashEnvBoundary })', 1],
    'claude/runClaude.ts': ['clearInheritedSessionLineage(process.env)', 1],
    'codex/runCodex.ts': ['clearInheritedSessionLineage(process.env)', 1],
}

describe('child environment wiring', () => {
    it.each(Object.entries(SPAWN_PATHS))('%s builds child env through utils/childEnv at every site', (file, [call, sites]) => {
        expect(readFileSync(join(__dirname, '..', file), 'utf8').split(call).length - 1).toBe(sites)
    })

    it('keeps the session scope of a session handler and not of the machine', () => {
        expect(readFileSync(join(__dirname, '..', 'api/apiSession.ts'), 'utf8')).toContain("childEnvBoundary: 'in-session'")
        expect(readFileSync(join(__dirname, '..', 'api/apiMachine.ts'), 'utf8')).not.toContain('childEnvBoundary')
    })
})

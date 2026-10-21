import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every path that starts an agent, a session host or a user shell builds its
 * environment through utils/childEnv. A path that goes back to `...process.env`
 * is how the 2026-07-19 reconnect leak happened; the behaviour itself is tested
 * next to each path, this only keeps a new or rewritten path from skipping it.
 */
const SPAWN_PATHS: Record<string, string> = {
    'daemon/sessionEnv.ts': 'sanitizeChildEnv(',
    'daemon/run.ts': 'sanitizeChildEnv(process.env)',
    'utils/spawnHappyCLI.ts': 'sanitizeChildEnv(',
    'channelHost/channelHostSupervisor.ts': 'sanitizeChildEnv(process.env)',
    'claude/claudeLocal.ts': "sanitizeChildEnv(process.env, { boundary: 'in-session' })",
    'claude/sdk/query.ts': "sanitizeChildEnv(process.env, { boundary: 'in-session' })",
    'claude/utils/bashStream.ts': "{ boundary: 'in-session' }",
    'codex/codexAppServerClient.ts': "sanitizeChildEnv(process.env, { boundary: 'in-session' })",
    'agent/acp/AcpBackend.ts': "sanitizeChildEnv(process.env, { boundary: 'in-session' })",
    'daemon/remoteTerminal.ts': 'sanitizeChildEnv(process.env)',
    'daemon/automations/managedScriptRunner.ts': 'sanitizeChildEnv(process.env)',
    'modules/common/registerCommonHandlers.ts': 'sanitizeChildEnv(process.env, { boundary: bashEnvBoundary })',
    'claude/runClaude.ts': 'clearInheritedSessionLineage(process.env)',
    'codex/runCodex.ts': 'clearInheritedSessionLineage(process.env)',
}

describe('child environment wiring', () => {
    it.each(Object.entries(SPAWN_PATHS))('%s builds child env through utils/childEnv', (file, call) => {
        expect(readFileSync(join(__dirname, '..', file), 'utf8')).toContain(call)
    })

    it('keeps the session scope of a session handler and not of the machine', () => {
        expect(readFileSync(join(__dirname, '..', 'api/apiSession.ts'), 'utf8')).toContain("childEnvBoundary: 'in-session'")
        expect(readFileSync(join(__dirname, '..', 'api/apiMachine.ts'), 'utf8')).not.toContain('childEnvBoundary')
    })
})

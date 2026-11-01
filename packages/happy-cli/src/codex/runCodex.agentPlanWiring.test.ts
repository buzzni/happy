/**
 * aplus specs/org-agent-plan §6.3-2 — the plan branch is wired into the runner in the right order (AGENTS §1.13).
 *
 * runCodex is one large function; its plan pieces are unit-tested in agentPlanSession.test.ts and
 * codexAppServerClient.agentPlan.test.ts. This checks, in source, that the runner actually calls them and in the
 * order the guarantees depend on.
 */
import { describe, expect, it } from 'vitest'

async function source(): Promise<string> {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    return readFile(fileURLToPath(new URL('runCodex.ts', import.meta.url)), 'utf8')
}

describe('runCodex plan branch wiring', () => {
    it('consumes the seeds first, binds after the session exists and before the daemon is told it started', async () => {
        const text = await source()
        const consume = text.indexOf('const agentPlanLaunch = consumeAgentPlanLaunch(process.env);')
        const firstEnvReader = text.indexOf('const deferredContinuation = createDeferredContinuationContextConsumer(process.env);')
        const createSession = text.indexOf('response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });')
        const bind = text.indexOf('agentPlanSession = await startAgentPlanSession({ launch: agentPlanLaunch, sessionId: response.id, env: process.env });')
        const reportStarted = text.indexOf('const result = await notifyDaemonSessionStarted(response.id, metadata, {')
        for (const index of [consume, firstEnvReader, createSession, bind, reportStarted]) expect(index).toBeGreaterThan(0)
        expect(consume).toBeLessThan(firstEnvReader)
        expect(bind).toBeGreaterThan(createSession)
        expect(bind).toBeLessThan(reportStarted)
    })

    it('refuses a plan inside a managed run, and an offline plan start', async () => {
        const text = await source()
        expect(text).toContain("if (agentPlanLaunch && managedStartup) throw new AgentPlanLaunchError('agent_plan_managed_conflict');")
        expect(text).toContain("if (!response) throw new AgentPlanLaunchError('agent_plan_session_unavailable'")
    })

    it('hands the client the plan provider arguments and closes the proxy with the runner', async () => {
        const text = await source()
        expect(text).toMatch(/new CodexAppServerClient\([\s\S]*?recallHost !== null,\s*undefined,\s*agentPlanSession\?\.providerArgs \?\? null,\s*\);/)
        expect(text).toContain('await agentPlanSession?.close().catch(() => undefined);')
    })

    it('reports the plan source only right after Codex connected with it', async () => {
        const text = await source()
        expect(text).toMatch(/await client\.connect\(\);\s*logger\.debug\('\[codex\]: client\.connect done'\);\s*if \(agentPlanSession\) reportAgentPlanApplied\(process\.env, client\.agentPlanApplied\);/)
        expect(text.match(/reportAgentPlanApplied\(/g)).toHaveLength(1)
    })
})


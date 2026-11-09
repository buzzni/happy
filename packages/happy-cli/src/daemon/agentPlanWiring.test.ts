/**
 * aplus specs/org-agent-plan §6.3 — the plan path is actually wired into the daemon (AGENTS §1.13).
 *
 * `agentPlanGrantEnvelope.test.ts` calls the pure functions directly; nothing there proves the spawn path runs
 * them. run.ts's spawnSession lives inside one large closure, so — like aiAuthSelectionWiring.test.ts — the
 * wiring is checked in source, and the capability through the exported metadata.
 */
import { describe, expect, it } from 'vitest'
import { MachineMetadataSchema } from '@/api/types'
import { AGENT_PLAN_CAPABILITY } from '@/launcher/agentPlanLaunch'
import { initialMachineMetadata } from './run'

async function runSource(): Promise<string> {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    return readFile(fileURLToPath(new URL('run.ts', import.meta.url)), 'utf8')
}

describe('agentPlan capability', () => {
    it('is advertised by this (non-Windows) daemon next to the untouched aiAuthSelection', () => {
        expect(process.platform).not.toBe('win32')
        expect(initialMachineMetadata.agentPlan).toEqual({ version: 1 })
        expect(initialMachineMetadata.aiAuthSelection).toEqual({ version: 1 })
    })

    it('passes the metadata schema, and the version is closed', () => {
        expect(MachineMetadataSchema.safeParse({ ...initialMachineMetadata, agentPlan: AGENT_PLAN_CAPABILITY }).success).toBe(true)
        expect(MachineMetadataSchema.safeParse({ ...initialMachineMetadata, agentPlan: { version: 2 } }).success).toBe(false)
        const { agentPlan: _omitted, ...without } = initialMachineMetadata
        expect(MachineMetadataSchema.safeParse(without).success).toBe(true)
    })
})

describe('spawn wiring', () => {
    it('restores the daemon trusted Studio origin after scrubbing a resumed session environment', async () => {
        const text = await runSource()
        const start = text.indexOf('const mcpEnvironment = prepareMcpChildEnvironment({')
        const end = text.indexOf('}, mcpCallerGrantConsumer);', start)
        expect(start).toBeGreaterThan(0)
        expect(end).toBeGreaterThan(start)
        expect(text.slice(start, end)).toContain('trustedStudioOrigin: readTrustedStudioOrigin(process.env)')
    })

    it('opens the envelope with the published grant key, refusing before anything launches', async () => {
        const text = await runSource()
        expect(text).toMatch(/new AgentPlanGrantEnvelopeConsumer\(\{\s*machineId,\s*secretKey: mcpCallerGrantKeyPair\.secretKey,/)
        expect(text).toMatch(/prepareAgentPlanLaunch\(\{\s*agentPlan: options\.agentPlan,\s*agent: options\.agent,\s*aiAuthSelection: options\.aiAuthSelection,/)
        expect(text).toContain('studioOrigin: readTrustedStudioOrigin(process.env)')
        expect(text).toContain('errorMessage: `Agent plan grant rejected (${agentPlanLaunch.reason})`')
    })

    it('adds the seeds after variable expansion and spends the grant only right before launch', async () => {
        const text = await runSource()
        const expansion = text.indexOf('extraEnv = expandEnvironmentVariables(extraEnv, process.env);')
        const seeds = text.indexOf('Object.assign(extraEnv, agentPlanLaunch.environment);')
        const mcpRefusal = text.indexOf('errorMessage: `MCP caller grant rejected (${consumed.reason})`')
        const claim = text.indexOf('const agentPlanClaimRefusal = agentPlanLaunch.claim();')
        const tmuxLaunch = text.indexOf('const tmuxResult = await tmux.spawnInTmux(')
        const regularLaunch = text.indexOf('return finishSpawn(spawnTrackedHappyProcess({')
        for (const index of [expansion, seeds, mcpRefusal, claim, tmuxLaunch, regularLaunch]) expect(index).toBeGreaterThan(0)
        expect(seeds).toBeGreaterThan(expansion)
        // An unrelated refusal (the MCP envelope) comes before the claim, so the client's retry is not a replay.
        expect(claim).toBeGreaterThan(mcpRefusal)
        expect(claim).toBeGreaterThan(seeds)
        expect(claim).toBeLessThan(tmuxLaunch)
        expect(claim).toBeLessThan(regularLaunch)
    })

    it('refuses an envelope-less continuation of a plan thread, checked against the daemon home', async () => {
        const text = await runSource()
        expect(text).toContain("resumeCodexThreadId: options.agent === 'codex' ? options.resumeCodexThreadId : undefined,")
        expect(text).toContain('isPlanThread: (threadId) => isAgentPlanThread(agentPlanThreadsDir(configuration.happyHomeDir), threadId),')
        expect(text).toContain('threadsDir: agentPlanThreadsDir(configuration.happyHomeDir),')
    })
})


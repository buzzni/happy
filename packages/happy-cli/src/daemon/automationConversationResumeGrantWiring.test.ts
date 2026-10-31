/**
 * A scheduled run that delivers into a stopped ordinary conversation must resume it with the
 * caller grant the run exchanged, or a shared PC's child comes back with only the org-wide MCP
 * servers (2026-10-31: Slack, Gmail and Saycode were missing from every run). Both ends are
 * closures inside runDaemon, so — like spawnCallerGrantOrder.test.ts — this pins the wiring in
 * the source; the grant decision itself is unit-tested as resolveResumeMcpGrantSource.
 */
import { describe, expect, it } from 'vitest'

async function runSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  return readFile(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8')
}

function slice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  expect(start, startMarker).toBeGreaterThan(-1)
  expect(end, endMarker).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('scheduled conversation delivery resumes with the exchanged grant', () => {
  it('passes the run spawn context to resumeSession as a trusted MCP context', async () => {
    const delivery = slice(await runSource(), 'deliverConversation: (input) => deliverAutomationConversation(', 'readSeq:')
    expect(delivery).toMatch(/ensureRunning: async \(sessionId, mcpSpawnContext\) => \(await resumeSession\(\s*sessionId,\s*mcpSpawnContext \? \{ trustedMcpContext: mcpSpawnContext \} : undefined,/)
  })

  it('resolves the resumed child grant from that context before preparing its environment', async () => {
    const resume = slice(await runSource(), 'const spawnResumedSession = async (', 'const resumeInFlight = new Map')
    const resolve = resume.indexOf('resolveResumeMcpGrantSource({')
    const prepare = resume.indexOf('prepareMcpChildEnvironment({')
    expect(resolve).toBeGreaterThan(-1)
    expect(prepare).toBeGreaterThan(resolve)
    expect(resume).toContain('trustedMcpContext: options?.trustedMcpContext,')
    expect(resume).toContain('trustedMcpCallerGrant: resumeGrantSource.trustedMcpCallerGrant,')
    expect(resume).toContain('mcpConfigProjectId: resumeMcpConfigProjectId,')
  })
})

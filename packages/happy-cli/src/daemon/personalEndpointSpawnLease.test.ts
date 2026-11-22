import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import * as os from 'node:os'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { buildPersonalEndpointEnvironment, PERSONAL_ENDPOINT_BINDING_ENV, personalEndpointMarker } from './personalLlmEndpoint'
import { prepareWorkMachineNewSession } from './workMachineNewSession'
import { buildManagedSessionSpawnEnvironment, buildSpawnRequestEnvironment, overlayManagedCredentialEnvironment, stripManagedCredentialConflicts, verifyAiAuthSelection } from './sessionEnv'

// Execute the actual daemon closure with process/network boundaries replaced. This catches
// early returns and rejected promises without starting a daemon or copying its cleanup logic.
const source = ts.createSourceFile('run.ts', readFileSync(new URL('./run.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let initializer: ts.Expression | undefined
function find(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'spawnSessionUnchecked') initializer = node.initializer
    ts.forEachChild(node, find)
}
find(source)
if (!initializer) throw new Error('Daemon spawn entry point missing')
const compiled = new Script(ts.transpileModule(`(${initializer.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)
const selection = { kind: 'personal-endpoint', issuer: 'https://studio.test', ownerUserId: 'owner', endpointId: 'ep', generation: 1, ticket: 'a'.repeat(43) } as const
const options = { directory: '/fixture', agent: 'claude', aiAuthSelection: selection, mcpConfigProjectId: 'project' }
type Result = { type: string; sessionId?: string; errorMessage?: string }
function fixture() {
    const env = buildPersonalEndpointEnvironment(selection, 'pc', { version: 1, leaseId: 'lease', baseUrl: 'http://127.0.0.1:1234/inference/lease', relayToken: 'relay-secret-long-value', model: 'local-model', modelTiers: {}, maxContextTokens: 32768, apiTimeoutMs: 30000, workspace: { projectId: 'project' }, purpose: 'start' })
    const release = vi.fn(async () => undefined)
    const acquire = vi.fn(async () => env)
    const overlay = vi.fn(async (_selection: unknown, value: Record<string, string>) => value)
    const inject = vi.fn((): Record<string, string> => ({}))
    const spawn = vi.fn(async (): Promise<Result> => ({ type: 'success', sessionId: 'child' }))
    const deps = {
        process, os, logger: { debug: vi.fn(), warn: vi.fn() }, fs: { access: vi.fn(async () => undefined) },
        launchReadiness: { isReady: () => true }, standaloneWindows: undefined,
        configuration: { happyHomeDir: '/fixture/home' }, machineId: 'pc',
        prepareAdditionalDirectories: async () => ({ accepted: [], skipped: [] }),
        resolveDaemonAllowedRoot: () => undefined, resolveDaemonApprovedRoots: () => undefined,
        prepareAgentPlanLaunch: () => ({ ok: true, environment: {}, claim: () => undefined }),
        readTrustedStudioOrigin: () => 'https://studio.test', agentPlanThreadsDir: () => '/fixture/threads', agentPlanGrantConsumer: {},
        normalizeSessionSource: () => undefined, ownedMachineLaunches: new Map(), machineRotationFor: async () => null,
        personalEndpointEnvironment: acquire, PERSONAL_ENDPOINT_BINDING_ENV, readSetupTokenResumeSelection: () => undefined,
        applyManualPersonal: overlay, readAppliedOrgLlmEndpoint: () => undefined, personalEndpointMarker,
        injectMcpCallerGrant: inject, stripManagedCredentialConflicts, buildSpawnRequestEnvironment,
        injectCheckpointSpawnContext: (value: object) => value, buildSessionRequesterEnv: () => ({}), expandEnvironmentVariables: (value: object) => value,
        releasePersonalEndpointEnvironment: release, pendingMachineStarts: new Set(),
        credentials: { token: 'fixture' }, managedIdentity: { status: 'inactive' }, lessonStudioOrigin: undefined,
        applyLessonLaunchEnvironment: async ({ environment }: { environment: object }) => ({ environment, decision: { owner: 'none', reason: 'fixture' } }),
        overlayManagedCredentialEnvironment, orgScopeHintEnvironment: () => ({}), replaceApprovedWriteRootsInEnvironment: () => undefined,
        resolveSandboxTrustFloor: () => 'fixture', browserTaskBroker: undefined, browserTaskLineage: () => ({}),
        browserTaskSpawnSeed: () => ({ registration: undefined, environment: {} }),
        prepareLaunchMcpServers: () => ({ environment: {}, report: async () => undefined }),
        shouldFilterSpawnCredentials: () => false, resolveInheritedSpawnEnvironment: () => ({}), isTmuxAvailable: async () => false,
        ownedPipeOnlyLaunch: undefined, contextOwnedChildren: new Map(), resolveRegularSpawnAgentArgs: () => ['claude'],
        applyAppliedAiAuthSourceEnv: (value: object) => value, applyConfirmedPromptDeliveryFlag: (value: object) => value,
        buildManagedSessionSpawnEnvironment, verifyAiAuthSelection, writeScopeRuntime: undefined, spawnTrackedHappyProcess: spawn,
        workMachine: null, prepareWorkMachineNewSession, daemonCreatedSessionMetadata: () => ({ path: '/fixture' }),
        persistDaemonCreatedSession: async () => ({ status: 'committed' }),
    }
    const start = compiled.runInNewContext(deps) as (input: typeof options) => Promise<Result>
    return { start: () => start(options), release, acquire, overlay, inject, spawn, env }
}

describe('personal relay custody during daemon start', () => {
    it('releases a just-acquired lease when credential overlay throws', async () => {
        const f = fixture(); f.overlay.mockRejectedValueOnce(new Error('overlay-rejected'))
        expect(await f.start()).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('overlay-rejected') })
        expect(f.acquire).toHaveBeenCalledOnce()
        expect(f.release).toHaveBeenCalledExactlyOnceWith(f.env)
    })
    it('releases when launch preparation throws after applying the credential', async () => {
        const f = fixture(); f.inject.mockImplementationOnce(() => { throw new Error('mcp-rejected') })
        expect(await f.start()).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('mcp-rejected') })
        expect(f.acquire).toHaveBeenCalledOnce()
        expect(f.release).toHaveBeenCalledExactlyOnceWith(f.env)
    })
    it('releases when invalid environment validation returns before finishSpawn', async () => {
        const f = fixture(); f.inject.mockReturnValueOnce({ BAD: '${UNSET_FIXTURE_VARIABLE}' })
        expect(await f.start()).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('Session environment is invalid') })
        expect(f.acquire).toHaveBeenCalledOnce()
        expect(f.spawn).not.toHaveBeenCalled()
        expect(f.release).toHaveBeenCalledExactlyOnceWith(f.env)
    })
    it('awaits and releases a rejected child spawn', async () => {
        const f = fixture(); f.spawn.mockRejectedValueOnce(new Error('spawn-rejected'))
        expect(await f.start()).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('spawn-rejected') })
        expect(f.spawn).toHaveBeenCalledOnce()
        expect(f.release).toHaveBeenCalledExactlyOnceWith(f.env)
    })
    it('releases a child launch refusal once', async () => {
        const f = fixture(); f.spawn.mockResolvedValueOnce({ type: 'error', errorMessage: 'child-refused' })
        expect(await f.start()).toMatchObject({ type: 'error', errorMessage: 'child-refused' })
        expect(f.spawn).toHaveBeenCalledOnce()
        expect(f.release).toHaveBeenCalledExactlyOnceWith(f.env)
    })
    it('transfers custody on confirmed success without releasing the live child relay', async () => {
        const f = fixture()
        expect(await f.start()).toMatchObject({ type: 'success', sessionId: 'child', appliedAiAuthSource: 'personal-endpoint' })
        expect(f.spawn).toHaveBeenCalledOnce()
        expect(f.release).not.toHaveBeenCalled()
    })
})

/** Public broker/client boundary, with real persistence and runtime authorization. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startBroker, withRevokingGrants } from './broker'
import { AttentionOutbox } from './attention'
import { TaskStore } from './taskStore'
import { BrowserRuntime } from './runtime'
import { FakeClock } from './clock'
import { FakeBrowserDriver } from './testing/fakeDriver'
import { fixtureSitePolicies } from './testing/fixtureSitePolicy'
import { verifyToken } from './auth'
import { handleBrowserClientCommand } from '../commands/browserClientCommand'
import { AGENT_OPERATIONS, type AgentGrant, type AuthContext } from './contracts'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
const key = 'local-client-test-key-not-a-production-secret'
async function harness() {
    const dir = await mkdtemp(join(tmpdir(), 'local-client-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const store = await TaskStore.open(dir); cleanups.push(() => store.close())
    const clock = new FakeClock(1_000_000)
    const attention = await AttentionOutbox.open(dir); attention.attach(store)
    const driver = new FakeBrowserDriver()
    const runtime = new BrowserRuntime({ store, clock, sites: fixtureSitePolicies(['https://fixture.test']),
        drivers: { main: driver }, spaceIdleReclaimMs: 1_000 })
    const base: AgentGrant = { kind: 'agent-grant', principalId: 'u' as never, workspaceId: 'w' as never, machineId: 'm' as never,
        profileId: 'main' as never, agentSessionId: 'parent' as never, grantId: 'parent-g' as never,
        allowedOrigins: ['https://fixture.test'], operations: [...AGENT_OPERATIONS], taskSpaceIds: [], issuedAtMs: clock.now(), expiresAtMs: clock.now() + 3600000 }
    const auth = { credential: base, verifiedAtMs: clock.now() }
    const space = await runtime.createSpace(auth, { profileId: base.profileId, requestId: 'space' as never })
    const socketPath = join(dir, 'broker.sock')
    let revokeFailure = false
    let afterAttach: (() => Promise<void>) | undefined
    let server = createServer()
    const options = { server, socketPath, stateDir: dir, attention, now: () => clock.now(), agentKey: key,
        daemonTokenSha256: createHash('sha256').update('daemon').digest('hex'),
        identity: { machineId: base.machineId, workspaceId: base.workspaceId }, profiles: new Map([[base.profileId, base.principalId]]),
        allowedOrigins: base.allowedOrigins, revokeGrant: async (id: any) => { if (revokeFailure) throw new Error('test revocation persistence unavailable'); await runtime.revokeGrant(id) }, endSession: (id: string) => runtime.endSession(id),
        setLocalClientValidator: (check: (id: string) => boolean) => runtime.setLocalClientValidator(check),
        attachLocalClient: async (owner: AuthContext, client: AgentGrant, until: number) => { await runtime.attachLocalClient(owner, client, until); await afterAttach?.() },
        cleanupLocalClient: (id: string) => runtime.endLocalClient(id),
        checkLocalClient: (client: AgentGrant) => runtime.checkLocalClient(client),
    }
    let broker = await startBroker(options)
    cleanups.push(() => broker.close())
    const call = (path: string, secret: string, body: unknown = {}, daemon = false) => new Promise<any>(resolve => {
        // Exercise the real broker HTTP handler without binding a socket in restricted test environments.
        const req = Object.assign(Readable.from([JSON.stringify(body)]), { url: path, method: 'POST',
            headers: { [daemon ? 'x-abp-daemon-token' : 'x-abp-session-secret']: secret } })
        let status = 0
        server.emit('request', req as any, { writeHead: (code: number) => { status = code }, end: (raw: string) => resolve({ status, ...JSON.parse(raw) }) } as any)
    })
    const registered = await call('/v1/sessions/register', 'daemon', { schemaVersion: 1 }, true)
    await call('/v1/sessions/bind', 'daemon', { schemaVersion: 1, registrationId: registered.result.registrationId, agentSessionId: 'parent' }, true)
    const parentSecret = registered.result.sessionSecret
    const create = (extra = {}, secret = parentSecret) => call('/v1/clients/register', secret, { schemaVersion: 1, profileId: 'main', taskSpaceId: space.taskSpaceId, origins: ['https://fixture.test'], leaseMs: 60000, ...extra })
    const grant = (secret: string) => call('/v1/clients/grant', secret, { schemaVersion: 1 })
    return { dir, clock, store, runtime, driver, auth, space, call, create, grant, parentSecret, setAfterAttach: (fn: () => Promise<void>) => { afterAttach = fn }, broker: () => broker, setRevokeFailure: (v: boolean) => { revokeFailure = v },
        restart: async () => { await broker.close(); server = createServer(); broker = await startBroker({ ...options, server }) } }
}
it('issues only the selected space/site/operations, survives restart and never reveals secrets in status or disk', async () => {
    const h = await harness(); const created = await h.create()
    expect(created.status).toBe(200)
    const { clientSecret, clientSessionId, expiresAtMs } = created.result
    const first = await h.grant(clientSecret); expect(first.status).toBe(200)
    const auth = verifyToken(first.result.token, { agentKey: key }, h.clock.now())
    expect(auth.credential).toMatchObject({ principalId: 'u', agentSessionId: clientSessionId, taskSpaceIds: [h.space.taskSpaceId], allowedOrigins: ['https://fixture.test'], expiresAtMs })
    for (const op of ['createSpace', 'joinSpace', 'listSpaces', 'closeSpace', 'approve']) expect(auth.credential.operations).not.toContain(op)
    await expect(h.runtime.createTask(auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'client-task' as never })).resolves.toMatchObject({ taskSpaceId: h.space.taskSpaceId })
    expect((await h.call('/v1/agent-grants', clientSecret, { schemaVersion: 1, agentSessionId: clientSessionId })).status).toBe(401)
    expect((await h.create({}, clientSecret)).status).toBe(401)
    const status = await h.call('/v1/clients/status', clientSecret, { schemaVersion: 1 })
    expect(status.status).toBe(200); expect(JSON.stringify(status)).not.toContain(clientSecret)
    expect(await readFile(join(h.dir, 'browser-local-clients.json'), 'utf8')).not.toContain(clientSecret)
    await h.restart(); expect((await h.grant(clientSecret)).status).toBe(200)
})
it('rejects forged credentials, widening, arbitrary fields and non-member spaces', async () => {
    const h = await harness()
    expect((await h.create({}, 'fake')).status).toBe(401)
    expect((await h.create({ origins: ['https://outside.test'] })).status).toBe(403)
    expect((await h.create({ operations: ['approve'] })).status).toBe(400)
    expect((await h.create({ leaseMs: 3600001 })).status).toBe(400)
    const other = await h.runtime.createSpace({ ...h.auth, credential: { ...h.auth.credential, agentSessionId: 'other' as never } }, { profileId: 'main' as never, requestId: 'other' as never })
    expect((await h.create({ taskSpaceId: other.taskSpaceId })).status).toBe(403)
})
it('keeps an idle space across parent termination only until its fixed lease and cancels the client on expiry', async () => {
    const h = await harness(); const c = await h.create(); expect(c.status).toBe(200)
    await h.runtime.endSession('parent')
    h.clock.advance(2000); await h.runtime.reclaimSpaces()
    expect(h.store.getSpace(h.space.taskSpaceId)?.closed).not.toBe(true)
    expect((await h.grant(c.result.clientSecret)).status).toBe(200)
    h.clock.advance(60000)
    expect((await h.grant(c.result.clientSecret)).status).toBe(401)
    await h.broker().sweepOrphans(); await h.runtime.reclaimSpaces()
    expect(h.store.getSpace(h.space.taskSpaceId)?.closed).toBe(true)
})
it('revokes issued grants and denies renewal after explicit space closure', async () => {
    const h = await harness(); const c = await h.create(); expect(c.status).toBe(200)
    const issued = await h.grant(c.result.clientSecret)
    expect((await h.call('/v1/clients/revoke', c.result.clientSecret, { schemaVersion: 1 })).status).toBe(200)
    expect(withRevokingGrants(h.store.getRevocations(), h.broker()).has(issued.result.grantId)).toBe(true)
    expect((await h.grant(c.result.clientSecret)).status).toBe(401)
    const next = await h.create(); expect(next.status).toBe(200)
    await h.runtime.closeSpace(h.auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'close' as never })
    expect((await h.grant(next.result.clientSecret)).ok).toBe(false)
})

it('collects through the CLI and real runtime contracts, closes its tab, and cannot close an agent tab', async () => {
    const h = await harness(), file = join(h.dir, 'connection.json'), output: any[] = []
    const parentTask = await h.runtime.createTask(h.auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'parent-task' as never })
    const parentPage = await h.runtime.openPage(h.auth, { taskId: parentTask.taskId, url: 'https://fixture.test/', requestId: 'parent-page' as never })
    const deps = {
        allowCreate: true,
        env: { HAPPY_BROWSER_TASK_SESSION_SECRET: h.parentSecret, HAPPY_BROWSER_TASK_BROKER_SOCKET: '/fixture.sock', HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:38700' },
        output: (value: unknown) => output.push(value),
        broker: async (_socket: string, action: string, secret: string, body: unknown) => {
            const reply = await h.call(`/v1/clients/${action}`, secret, body)
            if (!reply.ok) throw new Error(reply.error.code)
            return reply.result
        },
        runtime: async (_url: string, token: string, operation: string, body: unknown) => {
            const auth = verifyToken(token, { agentKey: key }, h.clock.now())
            return (h.runtime as any)[operation](auth, body)
        },
    }
    expect(await handleBrowserClientCommand(['create', '--space', h.space.taskSpaceId, '--profile', 'main', '--origin', 'https://fixture.test', '--out', file], deps)).toBe(0)
    expect(await handleBrowserClientCommand(['collect', '--file', file, '--url', 'https://fixture.test/'], deps)).toBe(0)
    expect(output.at(-1)).toMatchObject({ ok: true })
    expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).toEqual([parentPage.tabId])
    const client = JSON.parse(await readFile(file, 'utf8'))
    const issued = await h.grant(client.clientSecret)
    const auth = verifyToken(issued.result.token, { agentKey: key }, h.clock.now())
    await expect(h.runtime.getTask(auth, { taskId: parentTask.taskId })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    await expect(h.runtime.closePage(auth, { taskSpaceId: h.space.taskSpaceId, tabId: parentPage.tabId, requestId: 'steal-tab' as never })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
})

it('fences a failed revocation and completes its durable tombstone on restart', async () => {
    const h = await harness(), c = await h.create(); expect(c.status).toBe(200)
    const issued = await h.grant(c.result.clientSecret)
    const auth = verifyToken(issued.result.token, { agentKey: key }, h.clock.now())
    h.setRevokeFailure(true)
    expect((await h.call('/v1/clients/revoke', c.result.clientSecret, { schemaVersion: 1 })).status).toBe(500)
    expect(h.broker().pendingRevocations()).toBe(0) // Local client cleanup does not close global admission.
    expect((await h.grant(c.result.clientSecret)).status).toBe(401)
    await expect(h.runtime.createTask(auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'after-revoke' as never })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    h.setRevokeFailure(false); await h.restart(); await h.broker().sweepOrphans()
    expect(h.broker().pendingRevocations()).toBe(0)
    expect(h.store.isRevoked(issued.result.grantId)).toBe(true)
    expect((await h.grant(c.result.clientSecret)).status).toBe(401)
})
it('denies another owner and expired issued tokens even before the cleanup sweep', async () => {
    const h = await harness()
    const foreign = await h.runtime.createSpace({ ...h.auth, credential: { ...h.auth.credential, principalId: 'other-user' as never } }, { profileId: 'main' as never, requestId: 'foreign' as never })
    expect((await h.create({ taskSpaceId: foreign.taskSpaceId })).status).toBe(403)
    const c = await h.create(), issued = await h.grant(c.result.clientSecret)
    const auth = verifyToken(issued.result.token, { agentKey: key }, h.clock.now())
    h.clock.advance(60001)
    await expect(h.runtime.createTask(auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'expired' as never })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})
it('owner lists and revokes a connection without its secret; client cannot use owner endpoints', async () => {
    const h = await harness(); const created = (await h.create()).result
    const listed = await h.call('/v1/clients/list', h.parentSecret, { schemaVersion: 1, profileId: 'main' })
    expect(listed.result.clients).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(created.clientSecret)
    expect((await h.call('/v1/clients/list', created.clientSecret, { schemaVersion: 1, profileId: 'main' })).status).toBe(401)
    expect((await h.call('/v1/clients/revoke-owned', h.parentSecret, { schemaVersion: 1, profileId: 'main', clientSessionId: created.clientSessionId })).status).toBe(200)
    expect((await h.grant(created.clientSecret)).status).toBe(401)
})
it('reuses the final lease token instead of exhausting its grant quota', async () => {
    const h = await harness(); const { clientSecret } = (await h.create()).result
    const first = (await h.grant(clientSecret)).result
    h.clock.advance(40_000)
    for (let n = 0; n < 260; n++) expect((await h.grant(clientSecret)).result.grantId).toBe(first.grantId)
})
it('malformed client storage disables clients without disabling ordinary owner browser use', async () => {
    const h = await harness(); const { clientSecret } = (await h.create()).result
    const token = (await h.grant(clientSecret)).result.token
    const auth = verifyToken(token, { agentKey: key }, h.clock.now())
    const task = await h.runtime.createTask(auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'corrupt-tab-task' as never })
    const page = await h.runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test', requestId: 'corrupt-tab-page' as never })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(h.dir, 'browser-local-clients.json'), '{bad')
    await h.restart()
    expect((await h.grant(clientSecret)).status).not.toBe(200)
    await expect(h.runtime.createTask(auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'corrupt-client' as never })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(h.runtime.createTask(h.auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'ordinary-owner' as never })).resolves.toBeDefined()
    expect(h.broker().pendingRevocations()).toBe(0)
    h.clock.advance(60_001); await h.runtime.reclaimSpaces()
    expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).not.toContain(page.tabId)
})
it('does not revive an ended owner session to attach a new local client', async () => {
    const h = await harness()
    await h.runtime.endSession('parent')
    expect((await h.create()).status).not.toBe(200)
    expect(h.store.getSpace(h.space.taskSpaceId)?.endedSessionIds).toContain('parent')
})
it('revocation cleans up abandoned client tabs while preserving owner tabs', async () => {
    const h = await harness()
    const ownerTask = await h.runtime.createTask(h.auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'owner-cleanup-task' as never })
    const ownerPage = await h.runtime.openPage(h.auth, { taskId: ownerTask.taskId, url: 'https://fixture.test', requestId: 'owner-cleanup-page' as never })
    const { clientSecret } = (await h.create()).result
    const auth = verifyToken((await h.grant(clientSecret)).result.token, { agentKey: key }, h.clock.now())
    const task = await h.runtime.createTask(auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'abandoned-task' as never })
    const page = await h.runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test', requestId: 'abandoned-page' as never })
    expect((await h.call('/v1/clients/revoke', clientSecret, { schemaVersion: 1 })).status).toBe(200)
    expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).not.toContain(page.tabId)
    expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).toContain(ownerPage.tabId)
})
it('rolls back a registration if the owner is revoked during attachment', async () => {
    const h = await harness()
    h.setAfterAttach(async () => {
        expect((await h.call('/v1/sessions/revoke', 'daemon', { schemaVersion: 1, agentSessionId: 'parent', endSession: true }, true)).status).toBe(200)
    })
    expect((await h.create()).status).toBe(401)
    expect(Object.keys(h.store.getSpace(h.space.taskSpaceId)?.localClientLeases ?? {})).toHaveLength(0)
})
it('refreshes a token before a collection budget is exhausted and rejects unknown versions', async () => {
    const h = await harness(); const { clientSecret } = (await h.create({ leaseMs: 600_000 })).result
    const first = (await h.grant(clientSecret)).result
    h.clock.advance(121_000)
    const next = (await h.grant(clientSecret)).result
    expect(next.grantId).not.toBe(first.grantId)
    expect(next.tokenExpiresAtMs - h.clock.now()).toBe(300_000)
    expect((await h.call('/v1/clients/grant', clientSecret, { schemaVersion: 2 })).status).toBe(400)
})
it('revocation succeeds with cleanup pending and does not spend an active connection slot', async () => {
    const h = await harness(); const created = (await h.create()).result
    const issued = (await h.grant(created.clientSecret)).result
    const auth = verifyToken(issued.token, { agentKey: key }, h.clock.now())
    const task = await h.runtime.createTask(auth, { taskSpaceId: h.space.taskSpaceId, requestId: 'blocked-task' as never })
    const page = await h.runtime.openPage(auth, { taskId: task.taskId, url: 'https://fixture.test', requestId: 'blocked-page' as never })
    h.driver.blockUnload(page.tabId, true)
    const revoked = await h.call('/v1/clients/revoke', created.clientSecret, { schemaVersion: 1 })
    expect(revoked.status).toBe(200)
    expect(revoked.result).toMatchObject({ revoked: true, cleanupPending: true })
    expect(h.store.isRevoked(issued.grantId)).toBe(true)
    expect((await h.grant(created.clientSecret)).status).toBe(401)
    for (let n = 0; n < 16; n++) expect((await h.create()).status).toBe(200)
    expect((await h.create()).status).toBe(409)
    h.driver.blockUnload(page.tabId, false)
    await h.broker().sweepOrphans()
    expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).toContain(page.tabId) // backoff, not repeated close attempts
    h.clock.advance(60_001); await h.broker().sweepOrphans()
    expect(h.store.getSpace(h.space.taskSpaceId)?.tabs).not.toContain(page.tabId)
})
it('admits a new connection after all sixteen leases expire before the next cleanup sweep', async () => {
    const h = await harness()
    for (let n = 0; n < 16; n++) expect((await h.create()).status).toBe(200)
    expect((await h.create()).status).toBe(409)
    h.clock.advance(60_001)
    expect((await h.create()).status).toBe(200)
})

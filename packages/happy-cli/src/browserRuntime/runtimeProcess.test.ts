/**
 * Root start failure (production launcher): if dropping root fails, the
 * Runtime must stop before it opens the state volume, contacts a browser or
 * serves the task API, and must not keep the sockets it bound as root.
 */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PrivilegeOps } from './privilegeDrop'
import type { ProfileId } from './contracts'
import { createProfileResourceQuota, browserReadiness, connectAtStart, runRuntime } from './runtimeProcess'

const ENV_KEYS = ['ABP_STATE_DIR', 'ABP_CONFIG_FILE', 'ABP_KEYS_FILE', 'ABP_PROFILES', 'ABP_RUNTIME_UID', 'ABP_RUNTIME_GID', 'ABP_WRITER_FLOCK'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
    for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key] }
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
const reachable = (target: { port: number } | { path: string }) => new Promise<boolean>((resolve) => {
    const socket = connect(target as never)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
})

async function rootStart(privilege: Partial<PrivilegeOps>) {
    // Short path: unix socket paths are limited to ~104 bytes on macOS.
    const dir = await mkdtemp(join(tmpdir(), 'abp-rp-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const stateDir = join(dir, 'state')
    await mkdir(stateDir)
    let browserRequests = 0
    const browser = createServer((_req, res) => { browserRequests++; res.end('{}') })
    const browserPort = await listen(browser)
    cleanups.push(() => new Promise((resolve) => browser.close(() => resolve())))
    const probe = createServer()
    const runtimePort = await listen(probe)
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const config = join(dir, 'runtime.json')
    await writeFile(config, JSON.stringify({
        schemaVersion: 2, authMode: 'production', machineId: 'machine-h', workspaceId: 'workspace-1',
        profiles: [{ profileId: 'profile-a', principalId: 'user-1', assignmentId: 'a'.repeat(32), cdpHttpUrl: `http://127.0.0.1:${browserPort}`, instanceUrl: `http://127.0.0.1:${browserPort}/instance` }],
        trustedIssuers: [{ kid: 'k1', publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
        runtimeHost: '127.0.0.1', runtimePort,
        brokerSocketPath: join(dir, 'broker.sock'), adminSocketPath: join(dir, 'admin.sock'),
        daemonTokenSha256: createHash('sha256').update('synthetic-daemon-token').digest('hex'),
    }), { mode: 0o600 })
    for (const key of ENV_KEYS) delete process.env[key]
    Object.assign(process.env, { ABP_STATE_DIR: stateDir, ABP_CONFIG_FILE: config, ABP_RUNTIME_UID: '10870', ABP_RUNTIME_GID: '10870' })
    const ids = { uid: 0, gid: 0 }
    const ops: PrivilegeOps = {
        getuid: () => ids.uid, geteuid: () => ids.uid, getgid: () => ids.gid, getegid: () => ids.gid,
        setgroups: () => undefined, setgid: (id) => { ids.gid = id }, setuid: (id) => { ids.uid = id },
        readStatus: async () => 'CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n',
        ...privilege,
    }
    const outcome = await runRuntime({ privilege: ops }).then(() => 'started', (error: Error) => error.message)
    return { outcome, dir, stateDir, runtimePort, browserRequests: () => browserRequests }
}

describe('Runtime root start', () => {
    it.each<[string, Partial<PrivilegeOps>, RegExp]>([
        ['setuid fails', { setuid: () => { throw new Error('EPERM, Operation not permitted') } }, /EPERM/],
        ['a capability survives', { readStatus: async () => 'CapPrm:\t00000000000000c0\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n' }, /still holds capabilities/],
    ])('stops before state, browsers or the task API when %s, and releases the sockets it bound', async (_label, privilege, message) => {
        const started = await rootStart(privilege)
        expect(started.outcome).toMatch(message)
        expect(await readdir(started.stateDir)).toEqual([])
        expect(started.browserRequests()).toBe(0)
        expect(await reachable({ port: started.runtimePort })).toBe(false)
        expect(await reachable({ path: join(started.dir, 'broker.sock') })).toBe(false)
        expect(await reachable({ path: join(started.dir, 'admin.sock') })).toBe(false)
    })
})

describe('browser connection at start-up', () => {
    const never = () => new Promise<void>(() => {})
    it('waits for every browser without a deadline (dedicated machine)', async () => {
        let resolveLate!: () => void
        const late = new Promise<void>((resolve) => { resolveLate = resolve })
        let done = false
        const started = connectAtStart([{ profileId: 'a' as ProfileId, connect: async () => {} }, { profileId: 'b' as ProfileId, connect: () => late }], undefined)
            .then((result) => { done = true; return result })
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(done).toBe(false)
        resolveLate()
        expect((await started).pending.size).toBe(0)
    })

    it("stops waiting at the deadline on a shared machine, so one user's browser cannot keep the others out", async () => {
        const result = await connectAtStart([{ profileId: 'a' as ProfileId, connect: async () => {} }, { profileId: 'b' as ProfileId, connect: never }], 30)
        expect([...result.pending.keys()]).toEqual(['b'])
    })
})

describe('browser readiness', () => {
    const drivers = new Map([['a', { isConnected: () => true }], ['b', { isConnected: () => false }]]) as never
    it('needs every browser on a dedicated machine', () => {
        expect(browserReadiness('dedicated', ['a', 'b'] as ProfileId[], drivers)).toEqual({ browsers: false, profileBrowsers: { a: true, b: false } })
    })
    it("reports each browser on a shared machine, so one user's broken browser does not make the Runtime unready", () => {
        expect(browserReadiness('shared', ['a', 'b'] as ProfileId[], drivers)).toEqual({ browsers: true, profileBrowsers: { a: true, b: false } })
    })
})


describe('profile resource admission', () => {
    const profileId = 'quota-profile' as ProfileId
    const resources = { version: 1, hostAvailableBytes: 16 * 1024 ** 3, memoryLimitBytes: 4 * 1024 ** 3,
        memoryUsedBytes: 256 * 1024 ** 2, cpuLimit: 4, pidsLimit: 512, pidsUsed: 10, cpuUsageUsec: 0 }
    async function fixture() {
        const { TaskStore } = await import('./taskStore')
        const { BrowserRuntime } = await import('./runtime')
        const { FakeBrowserDriver } = await import('./testing/fakeDriver')
        const { quotaPreferenceKey } = await import('./resourceQuota')
        const dir = await mkdtemp(join(tmpdir(), 'abp-quota-'))
        const store = await TaskStore.open(dir)
        cleanups.push(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
        let now = Date.now()
        const counts = { windows: 0, tabs: 0 }
        const quota = createProfileResourceQuota({ profileId, store, maxSpaces: 2, maxWindows: 6,
            counts: () => counts, now: () => now })
        const runtime = new BrowserRuntime({ store, drivers: new Map([[profileId, new FakeBrowserDriver()]]),
            sites: [{ origin: 'https://fixture.test', actions: [{ match: {}, risk: 'auto' }] }],
            resourceQuota: quota.read, spaceResourceQuota: quota.readSpaces })
        let request = 0
        const rid = () => `quota-${++request}` as import('./contracts').RequestId
        const auth = { verifiedAtMs: now, credential: { kind: 'agent-grant', grantId: 'g', principalId: 'p',
            workspaceId: 'w', machineId: 'm', agentSessionId: 's', profileId, allowedOrigins: ['https://fixture.test'],
            operations: ['createSpace', 'createTask', 'openPage', 'listSpaces'], taskSpaceIds: [], issuedAtMs: 0,
            expiresAtMs: now + 600_000 } } as unknown as import('./contracts').AuthContext
        const space = () => runtime.createSpace(auth, { profileId, requestId: rid() })
        return { store, runtime, quota, counts, auth, rid, space, tick: () => { now += 10_000 },
            ceiling: () => store.setSpaceQuota(quotaPreferenceKey(profileId, 'p'), 1, 0, () => {}) }
    }
    it('keeps ceiling=1 out of window and tab admission in one space', async () => {
        const h = await fixture(); await h.ceiling(); h.quota.observe(resources)
        const { taskSpaceId } = await h.space()
        const task = await h.runtime.createTask(h.auth, { taskSpaceId, requestId: h.rid() })
        for (let i = 0; i < 2; i++) await h.runtime.openPage(h.auth, { taskId: task.taskId, url: 'https://fixture.test/', requestId: h.rid() })
        expect(h.quota.windowLimit()).toBe(6)
        await expect(h.space()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', quotaKind: 'spaces' })
    })
    it('retains the six-window fallback after telemetry loss, independently of the two-space fallback', async () => {
        const h = await fixture(); h.quota.observe(resources); h.quota.observe(null)
        expect(h.quota.windowLimit()).toBe(6)
        expect(h.quota.read().limit).toBe(6)
        expect(h.quota.readSpaces().limit).toBe(2)
    })
    it('counts one remaining allocation as one extra space even when the existing space has three windows', async () => {
        const h = await fixture(); h.quota.observe(resources); await h.space()
        h.counts.windows = 3; h.counts.tabs = 3; h.tick()
        h.quota.observe({ ...resources, memoryUsedBytes: resources.memoryLimitBytes - 512 * 1024 ** 2 })
        const outcomes = await Promise.allSettled([h.space(), h.space()])
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(h.store.listSpaces(profileId).filter(space => !space.closed)).toHaveLength(2)
    })
    it.each(['memory', 'cpu'])('does not turn multiple windows in one space into free spaces under %s pressure', async pressure => {
        const h = await fixture(); h.quota.observe(resources); await h.space()
        h.counts.windows = 3; h.counts.tabs = 3; h.tick()
        h.quota.observe({ ...resources, ...(pressure === 'memory' ? { hostAvailableBytes: 0 } : { cpuUsageUsec: 40_000_000 }) })
        const listed = await h.runtime.listSpaces(h.auth, { profileId })
        expect(listed.quota?.limit).toBe(1)
        await expect(h.space()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', quotaKind: 'spaces' })
        h.quota.observe(null)
        await expect(h.space()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', quotaKind: 'spaces' })
    })
})

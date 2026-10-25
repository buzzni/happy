import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openLocalClientApps } from './localClientApps'
import type { AgentGrant, AuthContext } from './contracts'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function harness() {
    const stateDir = await mkdtemp(join(tmpdir(), 'client-apps-')); dirs.push(stateDir)
    let time = 1_000_000, ownerAvailable = true
    const credential = { kind: 'agent-grant', principalId: 'u', workspaceId: 'w', machineId: 'm', profileId: 'p',
        agentSessionId: 'owner', allowedOrigins: ['https://example.test'], operations: [], taskSpaceIds: [],
        grantId: 'g', issuedAtMs: time, expiresAtMs: time + 300000 } as unknown as AgentGrant
    const ended: string[] = []
    const options = { stateDir, agentKey: 'test-key', now: () => time,
        owner: async (secret: string) => { if (secret !== 'owner' || !ownerAvailable) throw new Error('unauthorized'); return { credential, verifiedAtMs: time } as AuthContext },
        recheckOwner: async () => { if (!ownerAvailable) throw new Error('unauthorized') },
        attach: async () => {}, check: async () => {}, revokeGrant: async () => {}, endSession: async (clientId: string) => { ended.push(clientId) } }
    const app = await openLocalClientApps(options)
    const scope = { profileId: 'p', taskSpaceId: 's', origins: ['https://example.test'], projectRoot: '/project', outFile: '/project/.private/app.json' }
    const c = await app.handle('register-app', 'owner', { schemaVersion: 2, requestId: 'registration', requestedAtMs: time, ...scope, name: 'Dashboard', leaseMinutes: 1440, rememberSameScope: true }) as any
    const req = { schemaVersion: 2, requestId: 'reconnect', requestedAtMs: time, ...scope, appId: c.appId, appSecret: c.appSecret, leaseMinutes: 15 }
    return { app, c, req, stateDir, options, ended, advance: (ms: number) => { time += ms }, loseOwner: () => { ownerAvailable = false } }
}
it('requires app proof and current owner, rejects changed scope and never leaks stored secrets', async () => {
    const h = await harness()
    for (const changed of [{ appSecret: 'forged' }, { taskSpaceId: 'other' }, { outFile: '/project/other.json' }])
        await expect(h.app.handle('connect-app', 'owner', { ...h.req, ...changed })).rejects.toThrow()
    await expect(h.app.handle('connect-app', 'owner', h.req)).resolves.toMatchObject({ appId: h.c.appId })
    const listed = JSON.stringify(await h.app.handle('list-apps', 'owner', { schemaVersion: 2, profileId: 'p' }))
    expect(listed).not.toContain(h.c.appSecret); expect(listed).not.toContain(h.c.clientSecret)
    expect(await readFile(join(h.stateDir, 'browser-local-apps.v2.json'), 'utf8')).not.toContain(h.c.appSecret)
    h.loseOwner(); await expect(h.app.handle('connect-app', 'owner', h.req)).rejects.toThrow()
})
it('disables future issuance separately and revokes all existing clients', async () => {
    const h = await harness(), manage = { schemaVersion: 2, profileId: 'p', appId: h.c.appId }
    await h.app.handle('disable-app', 'owner', manage)
    expect(h.app.isActive(h.c.clientSessionId)).toBe(true)
    await expect(h.app.handle('connect-app', 'owner', h.req)).rejects.toThrow()
    await h.app.handle('revoke-app', 'owner', manage)
    expect(h.app.isActive(h.c.clientSessionId)).toBe(false)
    await expect(h.app.handle('grant', h.c.clientSecret, { schemaVersion: 2 })).rejects.toThrow()
})
it('supports a day of short grants without extending the fixed lease', async () => {
    const h = await harness()
    for (let i = 0; i < 400; i++) {
        await expect(h.app.handle('grant', h.c.clientSecret, { schemaVersion: 2 })).resolves.toMatchObject({ expiresAtMs: h.c.expiresAtMs })
        h.advance(180000)
    }
    h.advance(86400000)
    expect(h.app.isActive(h.c.clientSessionId)).toBe(false)
    await expect(h.app.handle('grant', h.c.clientSecret, { schemaVersion: 2 })).rejects.toThrow()
}, 30000)
it('restores rules but requires fresh owner authentication after restart', async () => {
    const h = await harness(), restarted = await openLocalClientApps(h.options)
    await expect(restarted.handle('connect-app', 'owner', h.req)).resolves.toMatchObject({ appId: h.c.appId })
    h.loseOwner(); await expect(restarted.handle('connect-app', 'owner', h.req)).rejects.toThrow()
})

it('rejects replayed issuance and clock rollback, including after a broker restart', async () => {
    const h = await harness()
    await h.app.handle('connect-app', 'owner', h.req)
    await expect(h.app.handle('connect-app', 'owner', h.req)).rejects.toThrow('already attempted')
    h.advance(10000); await h.app.handle('status', h.c.clientSecret, { schemaVersion: 2 })
    h.advance(-5000)
    expect(h.app.isActive(h.c.clientSessionId)).toBe(false)
    const restarted = await openLocalClientApps(h.options)
    await expect(restarted.handle('grant', h.c.clientSecret, { schemaVersion: 2 })).rejects.toThrow()
})

it('replays an app tombstone after restart without the original owner being available', async () => {
    const h = await harness()
    const path = join(h.stateDir, 'browser-local-apps.v2.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.apps[0].revoked = true
    await writeFile(path, JSON.stringify(saved))
    h.loseOwner()
    const restarted = await openLocalClientApps(h.options)
    await restarted.sweep()
    expect(h.ended).toContain(h.c.clientSessionId)
    expect(JSON.parse(await readFile(join(h.stateDir, 'browser-app-clients.v2.json'), 'utf8')).clients).toEqual({})
    expect(restarted.activeCount('u')).toBe(0)
    expect(restarted.isActive(h.c.clientSessionId)).toBe(false)
})
it('removes a consent rule when its initial connection cannot be issued', async () => {
    const h = await harness()
    const { appId, appSecret, ...request } = h.req
    await expect(h.app.handle('register-app', 'owner', { ...request, requestId: 'failed-registration',
        name: 'Failed app', rememberSameScope: true, origins: ['https://outside.test'] })).rejects.toThrow()
    const listed = await h.app.handle('list-apps', 'owner', { schemaVersion: 2, profileId: 'p' }) as { apps: unknown[] }
    expect(listed.apps).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('Failed app')
})
it('bounds replay history by request validity and reclaims completed app tombstones', async () => {
    const h = await harness()
    const path = join(h.stateDir, 'browser-local-apps.v2.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.requests = Array.from({ length: 4096 }, (_, i) => ({ requestId: `expired-${i}`, expiresAtMs: h.options.now() - 1 }))
    saved.apps.push(...Array.from({ length: 255 }, (_, i) => ({ ...saved.apps[0], appId: `revoked-${i}`, revoked: true, clientIds: [] })))
    await writeFile(path, JSON.stringify(saved))
    const restarted = await openLocalClientApps(h.options)
    const { appId, appSecret, ...request } = h.req
    await expect(restarted.handle('register-app', 'owner', { ...request, requestId: 'fresh-registration', name: 'Fresh app', rememberSameScope: true })).resolves.toHaveProperty('appId')
    const persisted = JSON.parse(await readFile(path, 'utf8'))
    expect(persisted.apps).toHaveLength(2)
    expect(persisted.requests).toHaveLength(1)
    h.advance(300_000)
    await expect(restarted.handle('connect-app', 'owner', h.req)).rejects.toThrow('expired')
    await expect(restarted.handle('connect-app', 'owner', { ...h.req, requestId: 'fresh-reconnect', requestedAtMs: h.options.now() })).resolves.toHaveProperty('clientSessionId')
})
it('lists and revokes v2 connections by owner session without the private descriptor', async () => {
    const h = await harness()
    await expect(h.app.handle('list', 'owner', { schemaVersion: 2, profileId: 'p' })).resolves.toMatchObject({ clients: [{ clientSessionId: h.c.clientSessionId }] })
    await expect(h.app.handle('revoke-owned', 'owner', { schemaVersion: 2, profileId: 'p', clientSessionId: h.c.clientSessionId })).resolves.toMatchObject({ revoked: true })
    expect(h.app.isActive(h.c.clientSessionId)).toBe(false)
})

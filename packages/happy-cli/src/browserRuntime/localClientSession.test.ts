import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalClientSession } from './localClientSession'
import { handleBrowserClientCommand } from '../commands/browserClientCommand'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function setup(approved: boolean | null) {
    const cwd = await mkdtemp(join(tmpdir(), 'client-session-')); dirs.push(cwd)
    const requestPolicyApproval = vi.fn(async () => ({ approved: approved === true, policyGrant: 'once' as const }))
    const broker = vi.fn(async (_socket: string, action: string, _secret: string, _body: unknown) => action === 'register' ? {
        clientSecret: 'bounded-secret', clientSessionId: 'client-id', profileId: 'main', taskSpaceId: 'space', expiresAtMs: Date.now() + 60_000,
    } : { revoked: true })
    const client = createLocalClientSession({ cwd, socketPath: '/local/broker.sock', sessionSecret: 'parent-secret', runtimeUrl: 'http://127.0.0.1:38700',
        profileId: async () => 'main', approver: () => approved === null ? null : { requestPolicyApproval } }, { broker, command: handleBrowserClientCommand })
    return { cwd, broker, client, requestPolicyApproval, args: { taskSpaceId: 'space', origins: ['https://fixture.test'], leaseMinutes: 5, outFile: 'connection.json' } }
}
it.skipIf(process.platform !== 'linux')('uses the captured parent credential after human-only approval; returns no credential', async () => {
    const h = await setup(true)
    expect(process.env.HAPPY_BROWSER_TASK_SESSION_SECRET).toBeUndefined()
    const reply = await h.client.create(h.args)
    expect(h.requestPolicyApproval).toHaveBeenCalledWith(expect.objectContaining({ policy: expect.objectContaining({ humanOnly: true, grantOffer: 'once' }),
        args: expect.objectContaining({ taskSpaceId: 'space', origins: h.args.origins, leaseMinutes: 5, outFile: join(h.cwd, 'connection.json') }) }))
    expect(h.broker.mock.calls[0][2]).toBe('parent-secret')
    const file = join(h.cwd, 'connection.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).toContain('bounded-secret')
    expect(JSON.stringify(reply)).not.toMatch(/parent-secret|bounded-secret/)
    expect(process.env.HAPPY_BROWSER_TASK_SESSION_SECRET).toBeUndefined()
})
it('refuses missing approver, denial and paths outside the project without issuing or writing', async () => {
    for (const approved of [null, false]) {
        const h = await setup(approved)
        await expect(h.client.create(h.args)).rejects.toThrow()
        expect(h.broker).not.toHaveBeenCalled()
        await expect(stat(join(h.cwd, 'connection.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const h = await setup(true)
    await expect(h.client.create({ ...h.args, outFile: '../escape.json' })).rejects.toThrow('inside the project')
    expect(h.requestPolicyApproval).not.toHaveBeenCalled(); expect(h.broker).not.toHaveBeenCalled()
})
it('owner can inspect and revoke without the connection file, with approval for revocation', async () => {
    const h = await setup(true)
    await h.client.list(); await h.client.revoke('client-lost-file')
    expect(h.broker.mock.calls.map(c => c[1])).toEqual(['list', 'revoke-owned'])
    expect(h.broker.mock.calls[1][3]).toMatchObject({ clientSessionId: 'client-lost-file', profileId: 'main' })
    expect(h.requestPolicyApproval).toHaveBeenCalledTimes(1)
})
it.skipIf(process.platform !== 'linux')('does not follow a destination directory replaced during the approval prompt', async () => {
    const h = await setup(true)
    const { mkdir, rename, symlink } = await import('node:fs/promises')
    const parent = join(h.cwd, 'connections'), moved = join(h.cwd, 'moved')
    const outside = await mkdtemp(join(tmpdir(), 'client-outside-')); dirs.push(outside)
    await mkdir(parent)
    h.requestPolicyApproval.mockImplementation(async () => {
        await rename(parent, moved); await symlink(outside, parent)
        return { approved: true, policyGrant: 'once' }
    })
    await expect(h.client.create({ ...h.args, outFile: 'connections/connection.json' })).rejects.toThrow()
    await expect(stat(join(outside, 'connection.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.broker).not.toHaveBeenCalled()
})
it.skipIf(process.platform !== 'linux')('requires a Git-ignored destination before requesting approval in repositories', async () => {
    const h = await setup(true)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { writeFile } = await import('node:fs/promises')
    await promisify(execFile)('git', ['init', '-q', h.cwd])
    await expect(h.client.create(h.args)).rejects.toThrow('ignored by Git')
    expect(h.requestPolicyApproval).not.toHaveBeenCalled(); expect(h.broker).not.toHaveBeenCalled()
    await writeFile(join(h.cwd, '.gitignore'), 'connection.json\n')
    await expect(h.client.create(h.args)).resolves.toMatchObject({ ok: true })
})

it.skipIf(process.platform === 'linux')('refuses issuance on unsupported platforms without requesting approval', async () => {
    const h = await setup(true)
    await expect(h.client.create(h.args)).rejects.toThrow('requires Linux')
    expect(h.requestPolicyApproval).not.toHaveBeenCalled()
    expect(h.broker).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'linux')('v2 writes private app proof only after an explicit duration choice and reconnects without exposing it', async () => {
    const h = await setup(true)
    h.requestPolicyApproval.mockResolvedValue({ approved: true, policyGrant: 'once', browserClientConsent: { leaseMinutes: 1440, rememberSameScope: true } } as any)
    h.broker.mockImplementation(async (_socket, action, _secret, body) => {
        if (action === 'v2:register-app') {
            expect(body).toMatchObject({ leaseMinutes: 1440, rememberSameScope: true, projectRoot: h.cwd })
            return { clientSecret: 'bounded-secret', clientSessionId: 'client-id', profileId: 'main', taskSpaceId: 'space', expiresAtMs: Date.now() + 86400000, appId: 'app-test', appSecret: 'a'.repeat(43) } as any
        }
        if (action === 'v2:connect-app') {
            expect(body).toMatchObject({ appSecret: 'a'.repeat(43), leaseMinutes: 60, outFile: join(h.cwd, 'connection.json') })
            return { clientSecret: 'replacement-secret', clientSessionId: 'client-next', expiresAtMs: Date.now() + 3600000 } as any
        }
        return { revoked: true } as any
    })
    const reply = await h.client.create({ ...h.args, appName: 'Dashboard' })
    expect(JSON.stringify(reply)).not.toMatch(/bounded-secret|aaaaaaa/)
    const reconnected = await h.client.reconnect('connection.json', 60)
    expect(JSON.stringify(reconnected)).not.toContain('replacement-secret')
    expect((await stat(join(h.cwd, 'connection.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(h.cwd, 'connection.json'), 'utf8')).clientSecret).toBe('replacement-secret')
    expect(h.requestPolicyApproval).toHaveBeenCalledTimes(1)
})
it.skipIf(process.platform !== 'linux')('v2 refuses old yes-only approval without creating credentials', async () => {
    const h = await setup(true)
    await expect(h.client.create({ ...h.args, appName: 'Dashboard' })).rejects.toThrow('explicit browser app consent')
    expect(h.broker).not.toHaveBeenCalled()
})

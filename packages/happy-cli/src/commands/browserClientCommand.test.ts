import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { handleBrowserClientCommand } from './browserClientCommand'
const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'client-cli-')); dirs.push(dir)
    const file = join(dir, 'connection.json'), output: unknown[] = []
    const broker = vi.fn(async (_socket: string, action: string) => action === 'register'
        ? { schemaVersion: 1, clientSecret: 'client-secret', clientSessionId: 'client-one', profileId: 'main', taskSpaceId: 's', expiresAtMs: Date.now() + 60000 }
        : action === 'grant' ? { token: 'short-token' } : { revoked: true })
    const runtime = vi.fn(async (_url: string, _token: string, op: string) =>
        op === 'createTask' ? { taskId: 'task' } : op === 'openPage' ? { tabId: 'tab' } : op === 'observe' ? { text: 'private report' } : op === 'getTask' ? { stateVersion: 3 } : op === 'closePage' ? { closed: true } : {})
    const env = { HAPPY_BROWSER_TASK_SESSION_SECRET: 'owner-secret', HAPPY_BROWSER_TASK_BROKER_SOCKET: '/test/broker.sock', HAPPY_BROWSER_TASK_RUNTIME_URL: 'http://127.0.0.1:38700' }
    return { file, output, broker, runtime, deps: { allowCreate: true, env, broker, runtime, output: (v: unknown) => output.push(v) } }
}
it('creates a private connection without printing credentials; collect ends its own task', async () => {
    const h = await setup()
    expect(await handleBrowserClientCommand(['create', '--space', 's', '--profile', 'main', '--origin', 'https://fixture.test', '--out', h.file], h.deps)).toBe(0)
    expect((await stat(h.file)).mode & 0o777).toBe(0o600)
    expect(await readFile(h.file, 'utf8')).toContain('client-secret')
    expect(JSON.stringify(h.output)).not.toMatch(/owner-secret|client-secret|short-token/)
    expect(await handleBrowserClientCommand(['collect', '--file', h.file, '--url', 'https://fixture.test'], h.deps)).toBe(0)
    expect(h.runtime.mock.calls.map(c => c[2])).toEqual(['createTask', 'openPage', 'observe', 'getTask', 'finishTask', 'closePage'])
    expect(h.output.at(-1)).toMatchObject({ ok: true, result: { text: 'private report' } })
})
it('does not overwrite files or send a credential to a non-loopback endpoint', async () => {
    const h = await setup(); await writeFile(h.file, 'existing')
    expect(await handleBrowserClientCommand(['create', '--space', 's', '--profile', 'main', '--origin', 'https://fixture.test', '--out', h.file], h.deps)).toBe(3)
    expect(h.broker).not.toHaveBeenCalled(); expect(await readFile(h.file, 'utf8')).toBe('existing')
    h.deps.env.HAPPY_BROWSER_TASK_RUNTIME_URL = 'http://outside.test'
    expect(await handleBrowserClientCommand(['create', '--space', 's', '--profile', 'main', '--origin', 'https://fixture.test', '--out', h.file + '2'], h.deps)).toBe(3)
    expect(h.broker).not.toHaveBeenCalled()
})
it('rejects readable-by-others descriptors and cancels on collection failure without leaking the error', async () => {
    const h = await setup()
    await handleBrowserClientCommand(['create', '--space', 's', '--profile', 'main', '--origin', 'https://fixture.test', '--out', h.file], h.deps)
    await chmod(h.file, 0o644)
    expect(await handleBrowserClientCommand(['status', '--file', h.file], h.deps)).toBe(3)
    await chmod(h.file, 0o600)
    h.runtime.mockImplementation(async (_url, _token, op) => { if (op === 'createTask') return { taskId: 'task' }; if (op === 'openPage') throw new Error('secret-token'); return {} })
    expect(await handleBrowserClientCommand(['collect', '--file', h.file, '--url', 'https://fixture.test'], h.deps)).toBe(3)
    expect(h.runtime.mock.calls.at(-1)?.[2]).toBe('cancel')
    expect(JSON.stringify(h.output)).not.toContain('secret-token')
})

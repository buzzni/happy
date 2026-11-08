/**
 * Saycode Desktop extension-session-and-worktree-hooks — `launchMcpServers` on spawn and resume.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/ui/logger'
import {
    LAUNCH_MCP_SERVERS_ENV,
    RESERVED_LAUNCH_MCP_SERVER_NAMES,
    claudeLaunchMcpServers,
    codexLaunchMcpServers,
    consumeLaunchMcpServersSeed,
    launchMcpDroppedWithoutLaunch,
    launchMcpServersBeside,
    parseLaunchMcpServers,
    prepareLaunchMcpServers,
} from './launchMcpServers'

const stdio = (extra: Record<string, unknown> = {}) => ({ transport: 'stdio', command: 'node', args: ['server.js'], env: { A: 'b' }, ...extra })
const http = (extra: Record<string, unknown> = {}) => ({ transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' }, ...extra })

afterEach(() => {
    vi.restoreAllMocks()
})

describe('parseLaunchMcpServers', () => {
    it('reads an absent field as absent — today\'s behaviour', () => {
        expect(parseLaunchMcpServers(undefined)).toBeUndefined()
    })

    it('keeps valid stdio and http entries and only their contract fields', () => {
        const parsed = parseLaunchMcpServers({
            files: stdio({ extra: 'ignored' }),
            docs: http(),
            local: http({ url: 'http://127.0.0.1:4100/mcp', headers: undefined }),
            local2: http({ url: 'http://localhost:4100/mcp' }),
            bare: { transport: 'stdio', command: '/usr/bin/mcp' },
        })
        expect(parsed).toEqual({
            servers: {
                files: { transport: 'stdio', command: 'node', args: ['server.js'], env: { A: 'b' } },
                docs: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
                local: { transport: 'http', url: 'http://127.0.0.1:4100/mcp' },
                local2: { transport: 'http', url: 'http://localhost:4100/mcp', headers: { Authorization: 'Bearer x' } },
                bare: { transport: 'stdio', command: '/usr/bin/mcp' },
            },
            dropped: [],
        })
    })

    it.each([
        ['an upper-case name', 'Files', stdio()],
        ['a name starting with a digit', '1files', stdio()],
        ['a name longer than 32 characters', `a${'b'.repeat(32)}`, stdio()],
        ['an unknown transport', 'files', { transport: 'sse', url: 'https://x' }],
        ['an empty command', 'files', stdio({ command: '' })],
        ['a command with NUL', 'files', stdio({ command: 'no\0de' })],
        ['an argument with NUL', 'files', stdio({ args: ['a\0b'] })],
        ['33 arguments', 'files', stdio({ args: Array.from({ length: 33 }, () => 'x') })],
        ['a non-string argument', 'files', stdio({ args: [1] })],
        ['a non-string env value', 'files', stdio({ env: { A: 1 } })],
        ['an env key with =', 'files', stdio({ env: { 'A=B': 'c' } })],
        ['plain http to a remote host', 'docs', http({ url: 'http://mcp.example.com/mcp' })],
        ['a non-http scheme', 'docs', http({ url: 'file:///etc/passwd' })],
        ['an unparsable url', 'docs', http({ url: 'not a url' })],
        ['a non-string header value', 'docs', http({ headers: { X: 1 } })],
        ['a header value with a newline', 'docs', http({ headers: { X: 'a\r\nb' } })],
        ['a non-object entry', 'files', 'node server.js'],
    ])('drops %s as invalid', (_label, name, entry) => {
        expect(parseLaunchMcpServers({ [name]: entry, ok: stdio() })).toEqual({
            servers: { ok: expect.any(Object) },
            dropped: [{ name, reason: 'invalid' }],
        })
    })

    it('accepts at most 8 entries and drops the rest as invalid', () => {
        const raw = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, stdio()]))
        const parsed = parseLaunchMcpServers(raw)!
        expect(Object.keys(parsed.servers)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])
        expect(parsed.dropped).toEqual([{ name: 's8', reason: 'invalid' }, { name: 's9', reason: 'invalid' }])
    })

    it('reads a malformed field (not an object) as nothing to launch', () => {
        for (const raw of [null, 'x', 1, [stdio()]]) {
            expect(parseLaunchMcpServers(raw)).toEqual({ servers: {}, dropped: [] })
        }
    })
})

describe('prepareLaunchMcpServers', () => {
    const request = () => parseLaunchMcpServers({ happy: stdio(), files: stdio(), docs: http(), broken: { transport: 'stdio' } })!

    it('does nothing when the field was absent', async () => {
        const lookup = vi.fn()
        const prepared = prepareLaunchMcpServers({ request: undefined, agent: 'claude', lookupServerNames: lookup })
        expect(prepared.environment).toEqual({})
        expect(await prepared.report()).toBeUndefined()
        expect(lookup).not.toHaveBeenCalled()
    })

    it('drops every entry for an agent without MCP injection', async () => {
        const lookup = vi.fn()
        const prepared = prepareLaunchMcpServers({ request: request(), agent: 'gemini', lookupServerNames: lookup })
        expect(prepared.environment).toEqual({})
        expect(await prepared.report()).toEqual([
            { name: 'broken', reason: 'invalid' },
            { name: 'happy', reason: 'unsupported-agent' },
            { name: 'files', reason: 'unsupported-agent' },
            { name: 'docs', reason: 'unsupported-agent' },
        ])
        expect(lookup).not.toHaveBeenCalled()
    })

    it('drops internal names and names the server already provides; the existing server wins', async () => {
        const prepared = prepareLaunchMcpServers({ request: request(), agent: 'codex', lookupServerNames: async () => ['docs', 'github'] })
        // The session process gets every candidate except the internal names: it applies the same server-wins rule.
        expect(JSON.parse(prepared.environment[LAUNCH_MCP_SERVERS_ENV])).toEqual({
            files: { transport: 'stdio', command: 'node', args: ['server.js'], env: { A: 'b' } },
            docs: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
        })
        expect(await prepared.report()).toEqual([
            { name: 'broken', reason: 'invalid' },
            { name: 'happy', reason: 'name-conflict' },
            { name: 'docs', reason: 'name-conflict' },
        ])
    })

    it('reports what it knows when the server names cannot be read', async () => {
        const prepared = prepareLaunchMcpServers({ request: request(), agent: 'claude', lookupServerNames: async () => { throw new Error('down') } })
        expect(await prepared.report()).toEqual([
            { name: 'broken', reason: 'invalid' },
            { name: 'happy', reason: 'name-conflict' },
        ])
    })

    it('omits an empty report', async () => {
        const prepared = prepareLaunchMcpServers({ request: parseLaunchMcpServers({ files: stdio() }), agent: 'claude', lookupServerNames: async () => null })
        expect(await prepared.report()).toBeUndefined()
    })

    it('starts the server lookup only when there is something to check', async () => {
        const lookup = vi.fn(async () => [])
        prepareLaunchMcpServers({ request: parseLaunchMcpServers({ happy: stdio() }), agent: 'claude', lookupServerNames: lookup })
        expect(lookup).not.toHaveBeenCalled()
    })
})

describe('launchMcpDroppedWithoutLaunch', () => {
    // Review #1185: a resume that reuses a live child or joins another resume starts no process to read a seed.
    it('drops every requested name when no process is started', () => {
        const request = parseLaunchMcpServers({ files: stdio(), docs: http(), broken: { transport: 'stdio' } })
        expect(launchMcpDroppedWithoutLaunch(request)).toEqual([
            { name: 'broken', reason: 'invalid' },
            { name: 'files', reason: 'session-live' },
            { name: 'docs', reason: 'session-live' },
        ])
    })

    it('omits the answer when the field was absent or empty', () => {
        expect(launchMcpDroppedWithoutLaunch(undefined)).toBeUndefined()
        expect(launchMcpDroppedWithoutLaunch(parseLaunchMcpServers({}))).toBeUndefined()
    })
})

describe('session process side', () => {
    it('reads the seed once and removes it from the environment', () => {
        const prepared = prepareLaunchMcpServers({ request: parseLaunchMcpServers({ files: stdio() }), agent: 'claude', lookupServerNames: async () => null })
        const env: NodeJS.ProcessEnv = { ...prepared.environment }
        expect(consumeLaunchMcpServersSeed(env)).toEqual({ files: { transport: 'stdio', command: 'node', args: ['server.js'], env: { A: 'b' } } })
        expect(env[LAUNCH_MCP_SERVERS_ENV]).toBeUndefined()
        expect(consumeLaunchMcpServersSeed(env)).toEqual({})
    })

    it('reads a seed that no longer parses as nothing', () => {
        const env: NodeJS.ProcessEnv = { [LAUNCH_MCP_SERVERS_ENV]: '{not json' }
        expect(consumeLaunchMcpServersSeed(env)).toEqual({})
        expect(env[LAUNCH_MCP_SERVERS_ENV]).toBeUndefined()
    })

    it('keeps injected servers out of names already taken', () => {
        const servers = parseLaunchMcpServers({ files: stdio(), docs: http(), happy: stdio() })!.servers
        expect(Object.keys(launchMcpServersBeside(servers, ['docs']))).toEqual(['files'])
        expect(RESERVED_LAUNCH_MCP_SERVER_NAMES).toEqual(['happy', 'cua-driver'])
    })

    it('builds Claude MCP entries', () => {
        const servers = parseLaunchMcpServers({ files: stdio(), docs: http() })!.servers
        expect(claudeLaunchMcpServers(servers)).toEqual({
            files: { type: 'stdio', command: 'node', args: ['server.js'], env: { A: 'b' } },
            docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
        })
    })

    it('builds Codex MCP entries, http through the same bridge as organization servers', () => {
        const servers = parseLaunchMcpServers({ files: stdio(), docs: http() })!.servers
        const bridge = vi.fn((http: Record<string, { url: string }>) => Object.fromEntries(Object.entries(http).map(([name, entry]) => [name, { command: 'bridge', args: ['--url', entry.url] }])))
        expect(codexLaunchMcpServers(servers, bridge)).toEqual({
            files: { command: 'node', args: ['server.js'], env: { A: 'b' } },
            docs: { command: 'bridge', args: ['--url', 'https://mcp.example.com/mcp'] },
        })
        expect(bridge).toHaveBeenCalledWith({ docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } } })
    })
})

describe('secrets in launch MCP servers', () => {
    it('never reach a log line, the report or the persisted session environment', async () => {
        const { captureSaycodeAgentEnvironment } = await import('@/daemon/sessionEnv')
        const SECRET = 'sentinel-launch-mcp-7f3c1e9a'
        const lines: string[] = []
        const record = (...args: unknown[]) => { lines.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')) }
        for (const level of ['debug', 'info', 'warn', 'infoDeveloper'] as const) vi.spyOn(logger, level).mockImplementation(record)

        const request = parseLaunchMcpServers({
            files: stdio({ args: [`--token=${SECRET}`], env: { TOKEN: SECRET } }),
            docs: http({ headers: { Authorization: `Bearer ${SECRET}` } }),
            taken: http({ headers: { Authorization: `Bearer ${SECRET}` } }),
            bad: stdio({ command: '', env: { TOKEN: SECRET } }),
        })
        const prepared = prepareLaunchMcpServers({ request, agent: 'claude', lookupServerNames: async () => ['taken'] })
        const report = await prepared.report()
        const env: NodeJS.ProcessEnv = { ...prepared.environment, HAPPY_PROJECT_SANDBOX_CONFIG: '{}' }
        const persisted = captureSaycodeAgentEnvironment(env)
        const servers = consumeLaunchMcpServersSeed(env)
        claudeLaunchMcpServers(launchMcpServersBeside(servers, ['taken']))

        expect(Object.keys(servers)).toEqual(['files', 'docs', 'taken'])
        expect(lines.length).toBeGreaterThan(0)
        expect(lines.join('\n')).not.toContain(SECRET)
        expect(JSON.stringify(report)).not.toContain(SECRET)
        expect(JSON.stringify(persisted)).not.toContain(SECRET)
        expect(JSON.stringify(env)).not.toContain(SECRET)
    })
})

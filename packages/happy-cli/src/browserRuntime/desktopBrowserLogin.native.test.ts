/** Actual signed Chrome + production runtime, isolated HOME and synthetic Desktop login.
 * Never uses a real login, an organization pin, or the installed daemon. */
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { readPersonalBrowserRuntime } from '../daemon/personalBrowserRuntime'
import { createBrokerGrantSource, createNativeBrokerRequest, brokerRequest } from './brokerGrantSource'
import { personalRuntimePaths } from './personalDesktopRuntime'
import { RuntimeClient } from './runtimeClient'

it.skipIf(process.platform !== 'darwin')('opens a page without device enrollment and rejects cached grants after logout, a new login and app loss', async () => {
    const home = await mkdtemp('/tmp/dbl-native-'), paths = personalRuntimePaths('darwin', {}, home)
    const issuer = generateKeyPairSync('ed25519'), bundle = join(home, 'bundle')
    await mkdir(join(bundle, 'native', `darwin-${process.arch}`), { recursive: true })
    execFileSync(process.execPath, [resolve('scripts/browser-poc/build-runtime.mjs'), join(bundle, 'dist/runtime.mjs')], { stdio: 'ignore' })
    await copyFile(process.env.SAYCODE_NATIVE_TEST_ADDON ?? resolve(`native/darwin-${process.arch}/browser-host.node`), join(bundle, 'native', `darwin-${process.arch}`, 'browser-host.node'))
    let loggedIn = true
    let descriptor = { protocol: 1 as const, machineId: 'm', workspaceId: 'company', principalId: 'u', profileId: 'p',
        socketPath: join(home, 'issuer.sock'), secret: randomBytes(32).toString('base64url'), loginId: randomBytes(32).toString('base64url') }
    const relay = createServer(async (req, res) => {
        if (!loggedIn || req.headers['x-saycode-browser-login'] !== descriptor.secret) { res.writeHead(403); res.end('{}'); return }
        let raw = ''; for await (const chunk of req) raw += chunk
        const input = JSON.parse(raw)
        if (input.operation === 'check') { res.end(JSON.stringify(descriptor)); return }
        const command = input.command, issuedAtMs = Date.now(), expiresAtMs = issuedAtMs + 60000
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'test', typ: 'abp-native-command' })).toString('base64url')
        const claims = { kind: 'native-command', iss: 'saycode-server', aud: 'm', machineId: 'm', workspaceId: 'company', principalId: 'u',
            generation: command.generation, requestId: randomUUID(), method: command.method, path: command.path,
            bodySha256: createHash('sha256').update(command.body).digest('hex'), issuedAtMs, expiresAtMs }
        const content = `abp2.${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
        res.end(JSON.stringify({ token: `${content}.${sign(null, Buffer.from(content), issuer.privateKey).toString('base64url')}`, expiresAtMs }))
    })
    const site = createServer((_req, res) => { res.end('<title>Desktop Login Acceptance</title><p>No enrollment required</p>') })
    await new Promise<void>(r => relay.listen(descriptor.socketPath, r))
    await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
    const portProbe = createServer(); await new Promise<void>(r => portProbe.listen(0, '127.0.0.1', r))
    const port = (portProbe.address() as { port: number }).port; await new Promise<void>(r => portProbe.close(() => r()))
    await mkdir(paths.root, { recursive: true, mode: 0o700 })
    await writeFile(paths.configFile, JSON.stringify({ schemaVersion: 2, authMode: 'production', machineId: 'm', workspaceId: 'company',
        runtimeHost: '127.0.0.1', runtimePort: port, sites: [{ origin: '*' }], profiles: [{ profileId: 'p', principalId: 'u', assignmentId: 'a'.repeat(32) }],
        trustedIssuers: [{ kid: 'test', publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
        personalDesktop: { platform: 'darwin', browserExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } }), { mode: 0o600 })
    let ownedRuntime: ReturnType<NonNullable<ReturnType<typeof readPersonalBrowserRuntime>>['start']> | undefined
    let log = ''
    const start = async () => {
        log = ''
        let stderr = ''
        const runtime = readPersonalBrowserRuntime({ platform: 'darwin', home, env: { HOME: home, TMPDIR: '/tmp' }, machineId: 'm', studioOrigin: 'https://synthetic.invalid',
            desktopLogin: () => descriptor, token: () => { throw Error('daemon organization token must never be used') },
            spawnImpl: ((file: string, args: string[], options: SpawnOptions) => { const child = spawn(file, args, options); child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk }); return child }) as typeof spawn,
            runtimeEntry: join(bundle, 'dist/runtime.mjs'), log: line => { log += line } })!
        ownedRuntime = runtime.start()
        for (const end = Date.now() + 30000; !log.includes('listening api=') && Date.now() < end;) await new Promise(r => setTimeout(r, 100))
        expect(log + stderr, 'runtime readiness').toContain('listening api=')
        return runtime
    }
    const register = async (runtime: NonNullable<ReturnType<typeof readPersonalBrowserRuntime>>, sessionId: string) => {
        const call = createNativeBrokerRequest(runtime.native)
        const registered = await call(paths.brokerSocket, 'POST', '/v1/sessions/register', {}, { schemaVersion: 1 })
        expect(registered.status).toBe(200)
        const { registrationId, sessionSecret } = registered.body.result as { registrationId: string; sessionSecret: string }
        expect((await call(paths.brokerSocket, 'POST', '/v1/sessions/bind', {}, { schemaVersion: 1, registrationId, agentSessionId: sessionId })).status).toBe(200)
        const grant = createBrokerGrantSource({ socketPath: paths.brokerSocket, sessionSecret, profileId: 'p', agentSessionId: () => sessionId, retryDelaysMs: [] })
        return { grant, sessionSecret }
    }
    const client = (token: string | (() => Promise<string>)) => new RuntimeClient({ baseUrl: `http://127.0.0.1:${port}`, token })
    try {
        const runtime = await start(), registered = await register(runtime, 's1'), api = client(registered.grant)
        const space = await api.createSpace({ profileId: 'p', requestId: randomUUID() } as any)
        const task = await api.createTask({ taskSpaceId: space.taskSpaceId, requestId: randomUUID() } as any)
        const page = await api.openPage({ taskId: task.taskId, url: `http://127.0.0.1:${(site.address() as { port: number }).port}`, requestId: randomUUID() } as any)
        expect(JSON.stringify(await api.observe({ taskId: task.taskId, tabId: page.tabId } as any))).toContain('Desktop Login Acceptance')
        const cached = await registered.grant()
        await writeFile(join(paths.profileDir, 'profile-preserved'), 'keep')
        loggedIn = false
        await expect(client(cached).createSpace({ profileId: 'p', requestId: randomUUID() } as any)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
        await ownedRuntime!.stop(); ownedRuntime = undefined
        expect(await readFile(join(paths.profileDir, 'profile-preserved'), 'utf8')).toBe('keep')
        loggedIn = true; descriptor = { ...descriptor, secret: randomBytes(32).toString('base64url'), loginId: randomBytes(32).toString('base64url') }
        const next = await start()
        expect((await brokerRequest(paths.brokerSocket, 'POST', '/v1/agent-grants', { 'x-abp-session-secret': registered.sessionSecret }, { schemaVersion: 1, profileId: 'p', agentSessionId: 's1' })).status).toBeGreaterThanOrEqual(400)
        await expect(client(cached).createSpace({ profileId: 'p', requestId: randomUUID() } as any)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
        const fresh = await register(next, 's2'), freshToken = await fresh.grant()
        await client(freshToken).createSpace({ profileId: 'p', requestId: randomUUID() } as any)
        await new Promise<void>(r => relay.close(() => r()))
        await expect(client(freshToken).createSpace({ profileId: 'p', requestId: randomUUID() } as any)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    } finally {
        await ownedRuntime?.stop()
        if (relay.listening) await new Promise<void>(r => relay.close(() => r()))
        await new Promise<void>(r => site.close(() => r()))
        await rm(home, { recursive: true, force: true })
    }
}, 120000)

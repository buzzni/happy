/** Real macOS acceptance of the personal desktop runtime: signed Google Chrome, a temporary
 * user directory (HOME), the bundled runtime process and its owned browser lifetime. */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brokerRequest } from './brokerGrantSource'
import { parseRuntimeConfig } from './runtimeConfig'
import { bootstrapPersonalDesktopRuntime, personalRuntimePaths } from './personalDesktopRuntime'
import { launchPersonalBrowser } from './personalBrowserProcess'

const run = promisify(execFile)
const CHROME = process.env.SAYCODE_NATIVE_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CANARY = 'personal-runtime-secret-canary'
const publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const configJson = (port: number) => ({ schemaVersion: 2, authMode: 'production', machineId: 'machine-personal', workspaceId: 'personal:user-1',
    runtimeHost: '127.0.0.1', runtimePort: port, sites: [{ origin: '*' }],
    profiles: [{ profileId: 'profile-1', principalId: 'user-1', assignmentId: '0123456789abcdef0123456789abcdef' }],
    trustedIssuers: [{ kid: 'k1', publicKeyPem }], personalDesktop: { platform: 'darwin', browserExecutable: CHROME } })

/** Processes whose command line names this profile directory, with their process group. */
function profileProcesses(profileDir: string): Array<{ pid: number; pgid: number }> {
    const lines = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' }).split('\n')
    return lines.filter(line => line.includes(`--user-data-dir=${profileDir}`))
        .map(line => line.trim().split(/\s+/)).map(([pid, pgid]) => ({ pid: Number(pid), pgid: Number(pgid) }))
}
async function until(check: () => boolean, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) if (check()) return true
    return check()
}
async function freePort(): Promise<number> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    await new Promise<void>(resolve => server.close(() => resolve()))
    return port
}

describe.skipIf(process.platform !== 'darwin')('personal desktop runtime on macOS', () => {
    let home: string, bundle: string
    beforeAll(async () => {
        // A short home: macOS binds unix sockets only on paths up to 103 bytes.
        home = await mkdtemp('/tmp/abp-p-')
        bundle = join(home, 'bundle')
        mkdirSync(join(bundle, 'native', `darwin-${process.arch}`), { recursive: true })
        execFileSync(process.execPath, [resolve('scripts/browser-poc/build-runtime.mjs'), join(bundle, 'dist/runtime.mjs')], { stdio: 'ignore' })
        copyFileSync(resolve(`native/darwin-${process.arch}/browser-host.node`), join(bundle, 'native', `darwin-${process.arch}`, 'browser-host.node'))
    }, 60_000)
    afterAll(async () => { await rm(home, { recursive: true, force: true }) })

    it('opens pages in the dedicated profile over pipes with no listening port, then ends the whole tree', async () => {
        const paths = personalRuntimePaths('darwin', {}, home)
        const site = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Personal</title><p>Personal mode canary</p>') })
        await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
        const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`
        const env = { HOME: home, TMPDIR: process.env.TMPDIR, ABP_CONFIG_FILE: paths.configFile, HAPPY_ACCESS_KEY: CANARY, ANTHROPIC_API_KEY: CANARY }
        const runtime = await bootstrapPersonalDesktopRuntime(parseRuntimeConfig(configJson(1)), paths.stateDir, { env, home, parent: new PassThrough() })
        try {
            const processes = profileProcesses(paths.profileDir)
            expect(processes.length).toBeGreaterThan(1)
            const pgid = processes[0].pgid
            expect(processes.every(entry => entry.pgid === pgid)).toBe(true)
            const listening = await run('/usr/sbin/lsof', ['-nP', '-a', '-g', String(pgid), '-iTCP', '-sTCP:LISTEN']).then(result => result.stdout, () => '')
            expect(listening).toBe('')

            const tab = await runtime.session.driver.openTab(origin, [origin], { timeoutMs: 10000 })
            expect(JSON.stringify(await runtime.session.driver.observe(tab.tabId, [origin], { timeoutMs: 10000 }))).toContain('Personal mode canary')
            await runtime.close()
            expect(profileProcesses(paths.profileDir)).toEqual([])
        } finally {
            await runtime.close().catch(() => undefined)
            await new Promise<void>(resolve => site.close(() => resolve()))
        }
    }, 40_000)

    it('starts the browser executable with only the allow-listed environment', async () => {
        // A stand-in executable reports what it received over the CDP output pipe (fd 4).
        const probe = join(home, 'env-probe.sh')
        writeFileSync(probe, '#!/bin/sh\n/usr/bin/env >&4\n', { mode: 0o700 })
        const browser = await launchPersonalBrowser({ platform: 'darwin', executable: probe, profileDir: join(home, 'probe-profile'),
            env: { HOME: home, TMPDIR: '/tmp', PATH: '/opt/evil', HAPPY_ACCESS_KEY: CANARY, NODE_OPTIONS: '--require /tmp/x.js' } })
        let received = ''
        browser.output.on('data', chunk => { received += chunk })
        await new Promise(resolve => browser.output.once('end', resolve))
        await browser.terminate()
        // /bin/sh itself adds PWD, SHLVL and _.
        const variables = received.trim().split('\n').filter(line => !/^(PWD|SHLVL|_)=/.test(line)).sort()
        expect(variables).toEqual([`HOME=${home}`, 'PATH=/usr/bin:/bin', 'TMPDIR=/tmp'])
    })

    it('runs as the daemon child: signed broker only, one runtime per user, and no browser outlives the runtime', async () => {
        const paths = personalRuntimePaths('darwin', {}, home)
        mkdirSync(paths.root, { recursive: true, mode: 0o700 })
        writeFileSync(paths.configFile, JSON.stringify(configJson(await freePort())), { mode: 0o600 })
        const start = () => {
            const child = spawn(process.execPath, [join(bundle, 'dist/runtime.mjs')], {
                env: { HOME: home, TMPDIR: process.env.TMPDIR, ABP_CONFIG_FILE: paths.configFile, ABP_STATE_DIR: paths.stateDir, HAPPY_ACCESS_KEY: CANARY },
                stdio: ['pipe', 'ignore', 'pipe'] })
            let log = ''
            child.stderr!.on('data', chunk => { log += chunk })
            const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
            return { child, exited, log: () => log }
        }
        const listening = (runtime: { log: () => string }) => until(() => runtime.log().includes('listening api='), 30000)
        const first = start()
        let second: ReturnType<typeof start> | undefined
        try {
            expect(await listening(first)).toBe(true)
            const challenge = await brokerRequest(paths.brokerSocket, 'GET', '/v1/native/challenge', {})
            expect(challenge).toMatchObject({ status: 200, body: { ok: true, result: { machineId: 'machine-personal', workspaceId: 'personal:user-1' } } })
            const unsigned = await brokerRequest(paths.brokerSocket, 'POST', '/v1/sessions/register', {}, {})
            expect(unsigned.status).toBe(401)

            second = start()
            expect(await second.exited).toBe(1)
            expect(second.log()).toMatch(/fatal/)
            expect(profileProcesses(paths.profileDir).length).toBeGreaterThan(0)

            // The daemon's end (its pipe closes) ends the runtime and its browser.
            first.child.stdin!.end()
            expect(await first.exited).toBe(0)
            expect(await until(() => profileProcesses(paths.profileDir).length === 0, 10000)).toBe(true)

            // A killed runtime cannot keep a browser: Chrome quits at the pipe EOF.
            const killed = start()
            expect(await listening(killed)).toBe(true)
            expect(profileProcesses(paths.profileDir).length).toBeGreaterThan(0)
            killed.child.kill('SIGKILL')
            await killed.exited
            expect(await until(() => profileProcesses(paths.profileDir).length === 0, 10000)).toBe(true)
        } finally {
            for (const runtime of [first, second] as Array<ReturnType<typeof start> | undefined>) {
                const child: ChildProcess | undefined = runtime?.child
                if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            }
        }
    }, 120_000)
})

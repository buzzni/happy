// Run on the target Windows host as the signed-in user:
//   node windows-personal-runtime.check.mjs <bundle dir>
// The bundle dir holds dist/runtime.mjs, dist/personal-runtime-diagnostic.mjs and
// native/win32-<arch>/browser-host.node. Uses a disposable LOCALAPPDATA, the installed
// Google Chrome and loopback only; never installs a service or touches the user's profile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bundle = resolve(process.argv[2] ?? '.')
const chrome = process.env.SAYCODE_NATIVE_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CANARY = 'personal-runtime-secret-canary'
const localAppData = mkdtempSync(join(tmpdir(), 'abp-p-'))
const root = join(localAppData, 'Saycode', 'browser-runtime')
const pipe = `\\\\.\\pipe\\saycode-browser-runtime-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16)}`
const paths = { configFile: join(root, 'runtime.json'), stateDir: join(root, 'state'), profileDir: join(root, 'profile'), broker: `${pipe}-broker` }
const check = (name, work) => test(name, { skip: process.platform !== 'win32', timeout: 120000 }, work)

async function freePort() {
    const server = createServer()
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const { port } = server.address()
    await new Promise(done => server.close(done))
    return port
}
const env = () => ({ SystemRoot: process.env.SystemRoot, windir: process.env.windir, USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP, TMP: process.env.TMP, LOCALAPPDATA: localAppData, APPDATA: process.env.APPDATA, USERNAME: process.env.USERNAME,
    ProgramFiles: process.env.ProgramFiles, 'ProgramFiles(x86)': process.env['ProgramFiles(x86)'], PATH: process.env.PATH,
    ABP_CONFIG_FILE: paths.configFile, ABP_STATE_DIR: paths.stateDir, HAPPY_ACCESS_KEY: CANARY, ANTHROPIC_API_KEY: CANARY })
function powershell(script) {
    const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}
/** Process ids whose command line names the disposable profile. */
const browserPids = () => powershell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${paths.profileDir.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`)
    .split(/\s+/).filter(Boolean).map(Number)
async function until(probe, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(done => setTimeout(done, 250))) if (probe()) return true
    return probe()
}
function brokerGet(path) {
    return new Promise((done, fail) => {
        const req = request({ socketPath: paths.broker, method: path === '/v1/native/challenge' ? 'GET' : 'POST', path, timeout: 10000, headers: { 'content-type': 'application/json' } }, res => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', chunk => { body += chunk })
            res.on('end', () => done({ status: res.statusCode, body: body ? JSON.parse(body) : {} }))
        })
        req.on('error', fail)
        req.end(path === '/v1/native/challenge' ? undefined : '{}')
    })
}
function startRuntime() {
    const child = spawn(process.execPath, [join(bundle, 'dist/runtime.mjs')], { env: env(), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    let log = ''
    child.stderr.on('data', chunk => { log += chunk })
    const exited = new Promise(done => child.once('exit', code => done(code)))
    return { child, exited, log: () => log }
}

const publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
mkdirSync(root, { recursive: true })
writeFileSync(paths.configFile, JSON.stringify({ schemaVersion: 2, authMode: 'production', machineId: 'machine-personal', workspaceId: 'personal:user-1',
    runtimeHost: '127.0.0.1', runtimePort: await freePort(), sites: [{ origin: '*' }],
    profiles: [{ profileId: 'profile-1', principalId: 'user-1', assignmentId: '0123456789abcdef0123456789abcdef' }],
    trustedIssuers: [{ kid: 'k1', publicKeyPem }], personalDesktop: { platform: 'win32', browserExecutable: chrome } }))

check('opens a page in the dedicated profile and leaves no job member after close', () => {
    const result = spawnSync(process.execPath, [join(bundle, 'dist/personal-runtime-diagnostic.mjs')], { env: env(), encoding: 'utf8', timeout: 90000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout.trim().split('\n').pop())
    assert.equal(report.observed, true)
    assert.ok(report.membersWhileOpen > 0)
    assert.equal(report.closed, true, report.closeError)
    assert.equal(report.membersAfterClose, 0)
    assert.deepEqual(browserPids(), [])
})

check('runs as the daemon child with signed broker commands and owns the browser lifetime', async () => {
    const first = startRuntime()
    let second
    try {
        assert.ok(await until(() => first.log().includes('listening api='), 60000), first.log())
        const challenge = await brokerGet('/v1/native/challenge')
        assert.equal(challenge.status, 200)
        assert.equal(challenge.body.result.machineId, 'machine-personal')
        assert.equal((await brokerGet('/v1/sessions/register')).status, 401)
        const pids = browserPids()
        assert.ok(pids.length > 0)
        const listening = powershell(`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${pids.join(',')}) -contains $_.OwningProcess } | Measure-Object | ForEach-Object Count`)
        assert.equal(listening, '0')

        second = startRuntime()
        assert.equal(await second.exited, 1)

        first.child.stdin.end()
        assert.equal(await first.exited, 0, first.log())
        assert.ok(await until(() => browserPids().length === 0, 15000))

        // A forcibly killed runtime closes its job handle: the kernel ends the browser tree.
        const killed = startRuntime()
        assert.ok(await until(() => killed.log().includes('listening api='), 60000), killed.log())
        assert.ok(browserPids().length > 0)
        spawnSync('taskkill', ['/F', '/PID', String(killed.child.pid)])
        await killed.exited
        assert.ok(await until(() => browserPids().length === 0, 15000))
    } finally {
        for (const runtime of [first, second]) if (runtime && runtime.child.exitCode === null) runtime.child.kill()
    }
})

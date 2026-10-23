/**
 * Opt-in, root-only live check of the Mac egress fence. Does NOT grant installed authority.
 *
 * Loads the pf anchor for an unused uid (no account is created), runs system tools and Chrome
 * as that uid, and records what reached the network. Every exit path flushes the anchor and
 * releases this run's pf enable reference. Run from packages/happy-cli:
 *
 *   sudo "$(command -v node)" --import tsx scripts/agent-browser/native/macEgressFence.live.check.ts <evidence.json>
 *
 * Manual recovery if the process is killed: sudo pfctl -a com.apple/050.SaycodeNativeH -F all
 * then sudo pfctl -X <token printed at start>.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chown, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from '../../../src/browserRuntime/drivers/cdpConnection'
import { createNativeEgressProxy, type NativeEgressDecision } from '../../../src/browserRuntime/nativeEgressProxy'
import { MAC_EGRESS_ANCHOR, macEgressChromeArgs, renderMacEgressAnchor, verifyMacEgressAnchor, verifyPfEnabled } from '../../../src/browserRuntime/nativeMacEgressFence'

// Optional real-account mode: SAYCODE_FENCE_ACCOUNT=<name> SAYCODE_FENCE_UID=<uid> (set by macEgressFence.account.sh).
const FENCED_ACCOUNT = process.env.SAYCODE_FENCE_ACCOUNT
const FENCED_UID = Number(process.env.SAYCODE_FENCE_UID ?? 471)
const PFCTL = '/sbin/pfctl'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ALLOWED_PAGE = 'https://example.com/'
const DENIED_PUBLIC = 'https://www.iana.org'
const CHROME_BASE = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--password-store=basic', '--use-mock-keychain']

type Run = { status: number | null; stdout: string; stderr: string }
function run(command: string, args: string[], options: { uid?: number; gid?: number; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Run {
    const result = spawnSync(command, args, { uid: options.uid, gid: options.gid, input: options.input, timeout: options.timeoutMs ?? 15_000, encoding: 'utf8', env: options.env ?? { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, killSignal: 'SIGKILL' })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function runAsync(command: string, args: string[], options: { uid?: number; gid?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
    // The proxy and ledger servers live in this process: probes must never block its event loop.
    return new Promise((resolve) => {
        const child = spawn(command, args, { uid: options.uid, gid: options.gid, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
        let stdout = '', stderr = ''
        child.stdout.on('data', (d) => { stdout += d }); child.stderr.on('data', (d) => { stderr += d })
        const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } }, options.timeoutMs ?? 15_000)
        child.once('error', () => { clearTimeout(timer); resolve({ status: null, stdout, stderr }) })
        child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    })
}
const pf = (...args: string[]) => run(PFCTL, args)

async function listen(server: Server, host: string): Promise<number> {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
    return (server.address() as { port: number }).port
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms) })]) } finally { clearTimeout(timer) }
}

async function main() {
    const outPath = process.argv[2]
    assert(outPath, 'usage: macEgressFence.live.check.ts <evidence.json>')
    assert.equal(process.platform, 'darwin')
    assert.equal(process.getuid?.(), 0, 'run with sudo')
    // Operator ids: argv[3]/argv[4] win over sudo's environment so wrappers can pass them explicitly.
    const operatorUid = Number(process.argv[3] ?? process.env.SUDO_UID), operatorGid = Number(process.argv[4] ?? process.env.SUDO_GID)
    assert(Number.isInteger(operatorUid) && operatorUid >= 501 && Number.isInteger(operatorGid), `invoking user ids required (uid=${operatorUid}, gid=${operatorGid}, argv=${process.argv.slice(3).join(',')}, env=${process.env.SUDO_UID}/${process.env.SUDO_GID})`)
    const owner = run('/usr/bin/dscl', ['.', '-search', '/Users', 'UniqueID', String(FENCED_UID)]).stdout.trim()
    if (FENCED_ACCOUNT) assert(owner.startsWith(`${FENCED_ACCOUNT}\t`) && /^_saycodetest\d*$/.test(FENCED_ACCOUNT), `uid ${FENCED_UID} is not the temporary test account`)
    else assert.equal(owner, '', `uid ${FENCED_UID} belongs to an account`)
    assert(!run('/bin/ps', ['-axo', 'uid=']).stdout.split('\n').some((line) => Number(line) === FENCED_UID), `uid ${FENCED_UID} has processes`)
    const info = pf('-s', 'info')
    assert.equal(info.status, 0, 'pfctl unavailable')
    // An absent anchor may be reported as an error; only existing rules block the run.
    assert.equal(pf('-a', MAC_EGRESS_ANCHOR, '-s', 'rules').stdout.trim(), '', 'anchor is not empty; refusing to overwrite unknown rules')
    const pfEnabledBefore = verifyPfEnabled(info.stdout)

    const evidence: Record<string, unknown> = {
        kind: 'mac-egress-fence-live', nativeReady: false, gnAccepted: false, fencedUid: FENCED_UID, accountCreated: Boolean(FENCED_ACCOUNT), fencedAccount: FENCED_ACCOUNT ?? null,
        startedAt: new Date().toISOString(), macos: run('/usr/bin/sw_vers', ['-productVersion']).stdout.trim(),
        arch: process.arch, node: process.version, chrome: run(CHROME, ['--version']).stdout.trim(), pfEnabledBefore,
        proxyRunsAs: 'root (in this check; production runs it as an unfenced non-root service account)',
    }
    const decisions: NativeEgressDecision[] = []
    let ledgerHits = 0
    const ledger = createServer((_req, res) => { ledgerHits++; res.end('ledger') })
    const ledger6 = createServer((_req, res) => { ledgerHits++; res.end('ledger') })
    const proxy = createNativeEgressProxy({ onDecision: (decision) => decisions.push(decision) })
    proxy.setAllowedOrigins([new URL(ALLOWED_PAGE).origin])
    const home = await mkdtemp('/private/tmp/saycode-egress-')
    await chown(home, FENCED_UID, FENCED_UID)
    let token: string | undefined
    let anchorLoaded = false
    const cleanup: Record<string, unknown> = {}
    const chromeGroups = new Set<number>()
    try {
        const [ledgerPort, ledger6Port, proxyPort] = [await listen(ledger, '127.0.0.1'), await listen(ledger6, '::1'), await listen(proxy.server, '127.0.0.1')]
        const fence = { browserUid: FENCED_UID, proxyPort }
        anchorLoaded = true
        const load = run(PFCTL, ['-a', MAC_EGRESS_ANCHOR, '-f', '-'], { input: renderMacEgressAnchor(fence) })
        assert.equal(load.status, 0, `anchor load failed: ${load.stderr}`)
        const enable = pf('-E')
        token = /Token : (\d+)/.exec(enable.stderr + enable.stdout)?.[1]
        assert(token, 'pf enable token missing')
        process.stderr.write(`pf enable token: ${token}\n`)
        const shown = pf('-a', MAC_EGRESS_ANCHOR, '-s', 'rules').stdout
        evidence.anchorRules = shown
        evidence.anchorVerified = verifyMacEgressAnchor(shown, fence)
        evidence.pfEnabledVerified = verifyPfEnabled(pf('-s', 'info').stdout)
        assert(evidence.anchorVerified && evidence.pfEnabledVerified, 'fence not verified')

        const env = { PATH: '/usr/bin:/bin', HOME: home }
        const as = (uid: number, gid: number) => (command: string, args: string[]) => runAsync(command, args, { uid, gid, env })
        const operator = as(operatorUid, operatorGid), fenced = as(FENCED_UID, FENCED_UID)
        const ledgerDelta = async (probe: () => Promise<Run>) => { const start = ledgerHits; const result = await probe(); return { result, ledgerHits: ledgerHits - start } }
        const socks = ['--socks5-hostname', `127.0.0.1:${proxyPort}`]
        const curl = (url: string, extra: string[] = []) => ['-sS', '--max-time', '10', '-o', '/dev/null', '-w', '%{http_code}', ...extra, url]
        const probes: Record<string, unknown> = {}
        const pair = async (name: string, command: string, args: string[], passed: (r: Run) => boolean) => {
            const control = await operator(command, args), blocked = await fenced(command, args)
            probes[name] = { controlStatus: control.status, controlPassed: passed(control), fencedStatus: blocked.status, fencedPassed: passed(blocked) }
        }
        await pair('tcp-direct-public-ipv4', '/usr/bin/nc', ['-z', '-G', '3', '-w', '3', '1.1.1.1', '443'], (r) => r.status === 0)
        await pair('tcp-direct-public-ipv6', '/usr/bin/nc', ['-6', '-z', '-G', '3', '-w', '3', '2606:4700:4700::1111', '443'], (r) => r.status === 0)
        await pair('udp-direct-dns', '/usr/bin/dig', ['@1.1.1.1', 'example.com', 'A', '+time=2', '+tries=1', '+short'], (r) => /^\d+\.\d+\.\d+\.\d+$/m.test(r.stdout))
        await pair('https-direct', '/usr/bin/curl', curl(ALLOWED_PAGE), (r) => r.stdout === '200')
        const loop4c = await ledgerDelta(() => operator('/usr/bin/nc', ['-z', '-G', '3', '-w', '3', '127.0.0.1', String(ledgerPort)]))
        const loop4f = await ledgerDelta(() => fenced('/usr/bin/nc', ['-z', '-G', '3', '-w', '3', '127.0.0.1', String(ledgerPort)]))
        // nc -z only completes the TCP handshake, so a ledger hit is not expected either way; the connect status is the signal.
        probes['tcp-loopback-ipv4'] = { controlStatus: loop4c.result.status, fencedStatus: loop4f.result.status, fencedLedgerHits: loop4f.ledgerHits }
        const loop6c = await ledgerDelta(() => operator('/usr/bin/nc', ['-6', '-z', '-G', '3', '-w', '3', '::1', String(ledger6Port)]))
        const loop6f = await ledgerDelta(() => fenced('/usr/bin/nc', ['-6', '-z', '-G', '3', '-w', '3', '::1', String(ledger6Port)]))
        probes['tcp-loopback-ipv6'] = { controlStatus: loop6c.result.status, fencedStatus: loop6f.result.status, fencedLedgerHits: loop6f.ledgerHits }
        const proxied = await fenced('/usr/bin/curl', curl(ALLOWED_PAGE, socks))
        probes['proxy-allowed-origin'] = { fencedStatus: proxied.status, httpCode: proxied.stdout }
        const deniedPublic = await fenced('/usr/bin/curl', curl(`${DENIED_PUBLIC}/`, socks))
        probes['proxy-denied-public'] = { fencedStatus: deniedPublic.status, httpCode: deniedPublic.stdout }
        const deniedLoop = await ledgerDelta(() => fenced('/usr/bin/curl', curl(`http://127.0.0.1:${ledgerPort}/`, socks)))
        probes['proxy-denied-loopback'] = { fencedStatus: deniedLoop.result.status, fencedLedgerHits: deniedLoop.ledgerHits }

        const skipChrome = process.env.SAYCODE_FENCE_SKIP_CHROME === '1'
        const dumpDom = async (url: string, args: string[]) => {
            const profile = `${home}/dump-${Math.random().toString(16).slice(2)}`
            const result = await runAsync(CHROME, [...CHROME_BASE, ...args, `--user-data-dir=${profile}`, '--timeout=8000', '--dump-dom', url], { uid: FENCED_UID, gid: FENCED_UID, env: { HOME: home, PATH: '/usr/bin:/bin' }, timeoutMs: 120_000 })
            return { status: result.status, exampleDomain: result.stdout.includes('Example Domain'), domBytes: result.stdout.length, html: result.stdout.includes('<html') }
        }
        const chrome: Record<string, unknown> = {}
        if (skipChrome) chrome.skipped = 'Chrome does not render under launchd for the test account (see account-launchd-chrome.txt)'
        else {
            chrome['pf-only-allowed-page'] = await dumpDom(ALLOWED_PAGE, [])
            const dumpLedger = async (args: string[]) => { const start = ledgerHits; const result = await dumpDom(`http://127.0.0.1:${ledgerPort}/`, args); return { ...result, ledgerHits: ledgerHits - start } }
            chrome['pf-only-loopback'] = await dumpLedger([])
            chrome['proxied-allowed-page'] = await dumpDom(ALLOWED_PAGE, macEgressChromeArgs(proxyPort))
            chrome['proxied-loopback'] = await dumpLedger(macEgressChromeArgs(proxyPort))
            for (const mode of ['detach', 'disable', 'disconnect'] as const) {
                const start = decisions.length
                try {
                    chrome[`cdp-paused-${mode}`] = { ...(await pausedRequest(mode, home, proxyPort, chromeGroups)), decisions: decisions.slice(start) }
                } catch (error) {
                    chrome[`cdp-paused-${mode}`] = { error: error instanceof Error ? error.message : 'unknown', decisions: decisions.slice(start) }
                }
            }
        }
        evidence.probes = probes
        evidence.chrome = chrome
        evidence.anchorCounters = pf('-a', MAC_EGRESS_ANCHOR, '-v', '-s', 'rules').stdout
        evidence.decisions = decisions
    } finally {
        for (const group of chromeGroups) try { process.kill(-group, 'SIGKILL') } catch { /* already gone */ }
        if (anchorLoaded) {
            const flush = pf('-a', MAC_EGRESS_ANCHOR, '-F', 'rules')
            cleanup.anchorFlushStatus = flush.status
            cleanup.anchorEmptyAfter = pf('-a', MAC_EGRESS_ANCHOR, '-s', 'rules').stdout.trim() === ''
        }
        if (token) cleanup.pfReleaseStatus = pf('-X', token).status
        cleanup.pfEnabledAfter = verifyPfEnabled(pf('-s', 'info').stdout)
        cleanup.pfStateMatchesBefore = cleanup.pfEnabledAfter === pfEnabledBefore
        proxy.setAllowedOrigins([])
        ledger.closeAllConnections()
        ledger6.closeAllConnections()
        for (const server of [ledger, ledger6, proxy.server]) {
            if (server.listening) await bounded(new Promise<void>((resolve) => server.close(() => resolve())), 5000).catch(() => { cleanup.serverCloseTimeout = true })
        }
        await rm(home, { recursive: true, force: true }).then(() => { cleanup.homeRemoved = true }, () => { cleanup.homeRemoved = false })
        cleanup.fencedUidProcessesAfter = run('/bin/ps', ['-axo', 'uid=']).stdout.split('\n').filter((line) => Number(line) === FENCED_UID).length
        evidence.cleanup = cleanup
        evidence.finishedAt = new Date().toISOString()
        await writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 })
        await chown(outPath, operatorUid, operatorGid)
    }
}

/**
 * E119's fail-open scenario under the fence: pause a denied cross-origin fetch with Fetch
 * interception, then detach / disable / drop the pipe. Chrome resends it; the fence must stop it.
 */
async function pausedRequest(mode: 'detach' | 'disable' | 'disconnect', home: string, proxyPort: number, groups: Set<number>) {
    const child = spawn(CHROME, [...CHROME_BASE, ...macEgressChromeArgs(proxyPort), '--remote-debugging-pipe', `--user-data-dir=${home}/cdp-${mode}`, 'about:blank'], { uid: FENCED_UID, gid: FENCED_UID, env: { HOME: home, PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    assert(child.pid)
    groups.add(child.pid)
    const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
    // A dedicated account's Chrome takes ~18-27s to start (LaunchServices seeding, E125 diag), so allow 60s per command.
    const conn = CdpConnection.fromPipe(child.stdio[3] as Writable, child.stdio[4] as Readable, { timeoutMs: 60_000 })
    try {
        const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
        await conn.send('Page.enable', {}, sessionId)
        const loaded = new Promise<void>((resolve) => { const off = conn.on('Page.loadEventFired', (_p, session) => { if (session === sessionId) { off(); resolve() } }) })
        await conn.send('Page.navigate', { url: ALLOWED_PAGE }, sessionId)
        await bounded(loaded, 15_000)
        await conn.send('Fetch.enable', { patterns: [{ urlPattern: `${DENIED_PUBLIC}/*` }] }, sessionId)
        const paused = new Promise<string>((resolve) => conn.on('Fetch.requestPaused', (params, session) => { if (session === sessionId && params.request.url.startsWith(DENIED_PUBLIC)) resolve(params.requestId) }))
        await conn.send('Runtime.evaluate', { expression: `void fetch(${JSON.stringify(`${DENIED_PUBLIC}/saycode-egress-sink`)}, { mode: 'no-cors', method: 'POST', body: 'synthetic', keepalive: true }).catch(() => {})` }, sessionId)
        await bounded(paused, 5000)
        if (mode === 'detach') await conn.send('Target.detachFromTarget', { sessionId })
        if (mode === 'disable') await conn.send('Fetch.disable', {}, sessionId)
        if (mode === 'disconnect') conn.close()
        await sleep(3000)
        return { mode, pausedBeforeAction: true, observationMs: 3000 }
    } finally {
        conn.close()
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
        await bounded(exited, 10_000).catch(() => undefined)
        groups.delete(child.pid)
    }
}

void main().catch((error) => { process.stderr.write(`mac-egress-fence-live:${error instanceof Error ? error.message : 'unknown'}\n`); process.exitCode = 1 })

/**
 * Opt-in, root-only live check: does a fenced-profile Chrome running as a dedicated account leak DNS
 * through the system resolver, or reach this Mac's own LAN address, with and without the proxy flags?
 * Does NOT grant installed authority. Creates a temporary hidden account and ALWAYS deletes it.
 *
 *   sudo "$(command -v node)" --import tsx scripts/agent-browser/native/macBrowserDnsLan.live.check.ts <evidence.json>
 *
 * Manual recovery: sudo pkill -9 -U 471; sudo pkill -f "tcpdump -i any -n -l -A port 53";
 * sudo dscl . -delete /Users/_saycodetest; sudo dscl . -delete /Groups/_saycodetest;
 * sudo rm -rf /private/var/tmp/saycode-dnslan
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chownSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createNativeEgressProxy, type NativeEgressDecision } from '../../../src/browserRuntime/nativeEgressProxy'
import { macEgressChromeArgs } from '../../../src/browserRuntime/nativeMacEgressFence'

const NAME = '_saycodetest', ID = 471, WORK = '/private/var/tmp/saycode-dnslan'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--password-store=basic', '--use-mock-keychain']

const sh = (command: string, args: string[]) => spawnSync(command, args, { encoding: 'utf8' })
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Runs Chrome as the account without blocking this process (the proxy and ledger live here). */
function chrome(args: string[], url: string, profile: string): Promise<{ status: number | null; dom: number; text: string }> {
    return new Promise((resolve) => {
        const child = spawn(CHROME, [...BASE, ...args, `--user-data-dir=${profile}`, '--timeout=8000', '--dump-dom', url],
            { uid: ID, gid: ID, env: { HOME: `${WORK}/home`, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
        let out = ''
        child.stdout!.on('data', (d) => { out += d })
        const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } }, 90_000)
        child.on('close', (status) => { clearTimeout(timer); resolve({ status, dom: out.length, text: out.slice(0, 2000) }) })
    })
}

async function main() {
    const outPath = process.argv[2]
    assert(outPath, 'usage: macBrowserDnsLan.live.check.ts <evidence.json>')
    assert.equal(process.getuid?.(), 0, 'run with sudo')
    const operatorUid = Number(process.env.SUDO_UID), operatorGid = Number(process.env.SUDO_GID)
    assert(Number.isInteger(operatorUid) && operatorUid >= 501, 'run via sudo from your user')
    assert.notEqual(sh('/usr/bin/dscl', ['.', '-read', `/Users/${NAME}`]).status, 0, `${NAME} already exists`)
    assert.equal(sh('/usr/bin/dscl', ['.', '-search', '/Users', 'UniqueID', String(ID)]).stdout.trim(), '', `uid ${ID} in use`)
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address
    assert(lan, 'no LAN IPv4 address')

    const evidence: Record<string, unknown> = { kind: 'mac-browser-dns-lan-live', nativeReady: false, startedAt: new Date().toISOString(), lan, account: NAME, uid: ID, pfLoaded: false }
    const cleanup: Record<string, unknown> = {}
    let tcpdump: ChildProcess | undefined
    const ledgerHits: string[] = []
    const ledger = createServer((req, res) => { ledgerHits.push(String(req.socket.localAddress)); res.end('ledger') })
    const decisions: NativeEgressDecision[] = []
    const proxy = createNativeEgressProxy({ onDecision: (d) => decisions.push(d) })
    proxy.setAllowedOrigins(['https://example.com'])
    try {
        for (const args of [['-create', `/Groups/${NAME}`, 'PrimaryGroupID', String(ID)]]) assert.equal(sh('/usr/bin/dscl', ['.', ...args]).status, 0)
        for (const [k, v] of [['UniqueID', String(ID)], ['PrimaryGroupID', String(ID)], ['UserShell', '/usr/bin/false'], ['NFSHomeDirectory', `${WORK}/home`], ['IsHidden', '1']]) {
            assert.equal(sh('/usr/bin/dscl', ['.', '-create', `/Users/${NAME}`, k, v]).status, 0)
        }
        mkdirSync(`${WORK}/home`, { recursive: true, mode: 0o700 }); chownSync(WORK, ID, ID); chownSync(`${WORK}/home`, ID, ID)
        await new Promise<void>((r) => ledger.listen(0, '0.0.0.0', r))
        await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', r))
        const L = (ledger.address() as { port: number }).port, P = (proxy.server.address() as { port: number }).port
        let dns = ''
        tcpdump = spawn('/usr/sbin/tcpdump', ['-i', 'any', '-n', '-l', '-A', 'port 53 or port 5353'], { stdio: ['ignore', 'pipe', 'ignore'] })
        tcpdump.stdout!.on('data', (d) => { dns += d })
        await sleep(1500)
        const label = () => `saycode-dnsprobe-${randomBytes(5).toString('hex')}`
        const cases: Record<string, unknown> = {}
        let n = 0
        const run = async (name: string, args: string[], url: string, probeLabel?: string) => {
            const hitsBefore = ledgerHits.length, decisionsBefore = decisions.length
            const result = await chrome(args, url, `${WORK}/home/p${n++}`)
            await sleep(1500)
            cases[name] = {
                url: probeLabel ? url.replace(probeLabel, '<label>') : url, chromeExit: result.status, domBytes: result.dom,
                exampleDomain: result.text.includes('Example Domain'), ledgerHits: ledgerHits.length - hitsBefore,
                dnsLabelOnWire: probeLabel ? dns.split(probeLabel).length - 1 : undefined,
                decisions: decisions.slice(decisionsBefore).filter((d) => !/google|gstatic/.test(d.endpoint)),
            }
        }
        const proxied = macEgressChromeArgs(P)
        await run('proxied-allowed-page', proxied, 'https://example.com/')
        const l1 = label(); await run('proxied-denied-host-dns', proxied, `https://${l1}.example.org/`, l1)
        await run('proxied-own-lan-address', proxied, `http://${lan}:${L}/`)
        const l2 = label(); await run('unproxied-denied-host-dns', [], `https://${l2}.example.org/`, l2)
        await run('unproxied-own-lan-address', [], `http://${lan}:${L}/`)
        evidence.cases = cases
    } finally {
        try { tcpdump?.kill('SIGTERM') } catch { /* gone */ }
        proxy.setAllowedOrigins([]); ledger.closeAllConnections()
        await new Promise<void>((r) => ledger.close(() => r())); await new Promise<void>((r) => proxy.server.close(() => r()))
        for (let i = 0; i < 50 && sh('/bin/ps', ['-axo', 'uid=']).stdout.split('\n').some((l) => Number(l) === ID); i++) {
            sh('/usr/bin/pkill', ['-9', '-U', String(ID)]); await sleep(200)
        }
        sh('/bin/launchctl', ['bootout', `user/${ID}`]); sh('/usr/bin/pkill', ['-9', '-U', String(ID)])
        sh('/usr/bin/dscl', ['.', '-delete', `/Users/${NAME}`]); sh('/usr/bin/dscl', ['.', '-delete', `/Groups/${NAME}`])
        rmSync(WORK, { recursive: true, force: true })
        cleanup.userGone = sh('/usr/bin/dscl', ['.', '-read', `/Users/${NAME}`]).status !== 0
        cleanup.groupGone = sh('/usr/bin/dscl', ['.', '-read', `/Groups/${NAME}`]).status !== 0
        cleanup.uidProcesses = sh('/bin/ps', ['-axo', 'uid=']).stdout.split('\n').filter((l) => Number(l) === ID).length
        evidence.cleanup = cleanup
        evidence.finishedAt = new Date().toISOString()
        writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`); chownSync(outPath, operatorUid, operatorGid)
    }
}

void main().catch((error) => { process.stderr.write(`mac-browser-dns-lan:${error instanceof Error ? error.message : 'unknown'}\n`); process.exitCode = 1 })

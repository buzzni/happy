import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import { createMacNativeBrowserProtection } from './macNativeBrowserProtection'
import { openNativeBrowserSession, type NativeBrowserSession } from './nativeBrowserSession'
import { readNativeSessionOwner, verifyMacPrivateDirectory, verifyMacServiceExecutable } from './nativeHostPrimitives'
import { macEgressChromeArgs } from './nativeMacEgressFence'

const root = '/Library/Application Support/SaycodeNative'
const guardian = `${root}/bin/browser-guardian`
const chrome = `${root}/browser/Google Chrome.app/Contents/MacOS/Google Chrome`
const profile = `${root}/browser-profile`
const exec = promisify(execFile)

/** Called only during the service's privileged bootstrap. Does not read a single
 * CDP response until connect() confirms the distinct, dropped runtime identity. */
export async function prepareMacNativeBrowser(options: {
    browserUid: number; browserGid: number; runtimeUid: number; policyEpoch: number; proxyPort: number
}) {
    const { browserUid, browserGid, runtimeUid, policyEpoch, proxyPort } = options
    if (process.platform !== 'darwin' || process.getuid?.() !== 0 || process.geteuid?.() !== 0 ||
        [browserUid, browserGid, runtimeUid].some(id => !Number.isSafeInteger(id) || id < 200 || id > 0x7fffffff) || browserUid === runtimeUid)
        throw new Error('NATIVE_SERVICE_IDENTITY_REQUIRED')
    const protection = createMacNativeBrowserProtection({ browserUid, epoch: policyEpoch })
    await verifyMacServiceExecutable(guardian)
    await verifyMacServiceExecutable(chrome)
    await verifyMacPrivateDirectory(profile, browserUid)
    for (const [path, requirement] of [[guardian, '=anchor apple generic and certificate leaf[subject.OU] = "36C77K9BJ2" and identifier "com.saycode.nativeh.browser-guardian"'],
        [chrome, '=anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV" and identifier "com.google.Chrome"']]) {
        await exec('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, path], { timeout: 10000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } })
    }
    const baseline = JSON.stringify(await protection.snapshot())
    const child = spawn(guardian, [String(browserUid), String(browserGid), profile, `${root}/guardian-state`, chrome,
        '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
        '--disable-crash-reporter', '--disable-breakpad', `--crash-dumps-dir=${profile}/crashes`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--disable-background-networking', '--disable-sync', '--disable-component-update',
        '--password-store=basic', '--use-mock-keychain', ...macEgressChromeArgs(proxyPort), 'about:blank',
    ], { env: { PATH: '/usr/bin:/bin', HOME: profile, LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'] })
    child.stdin!.on('error', () => {}) // EOF/exit is reconciled through the guardian's exit status.
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
    let guardianGone = false, session: NativeBrowserSession | undefined
    // Losing the owner is fatal even if Chrome inherited the other pipe ends and
    // keeps speaking CDP. Its continued replies cannot prove it can be terminated.
    const lost = () => { guardianGone = true; void session?.close() }
    void exited.then(lost, lost)
    let closing: Promise<void> | undefined
    const terminate = () => closing ??= (async () => {
        child.stdin!.destroy()
        let timer!: ReturnType<typeof setTimeout>
        try {
            const code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('NATIVE_TERMINATION_UNKNOWN')), 8000) })])
            if (code !== 0) throw new Error('NATIVE_TERMINATION_UNKNOWN')
        } finally { clearTimeout(timer) }
    })()
    try {
        const pid = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('NATIVE_START_TIMEOUT')), 10000)
            let buffer = ''
            child.stdout!.on('data', chunk => {
                buffer += chunk.toString('utf8')
                if (buffer.length > 512) { clearTimeout(timer); reject(new Error('NATIVE_RECEIPT_INVALID')); return }
                if (!buffer.includes('\n')) return
                clearTimeout(timer)
                try {
                    const row = JSON.parse(buffer)
                    if (Object.keys(row).sort().join(',') !== 'pid,uid,version' || row.version !== 1 || row.uid !== browserUid || !Number.isSafeInteger(row.pid) || row.pid <= 0) throw new Error()
                    resolve(row.pid)
                } catch { reject(new Error('NATIVE_RECEIPT_INVALID')) }
            })
            void exited.then(() => { clearTimeout(timer); reject(new Error('NATIVE_BROWSER_EXITED')) }, error => { clearTimeout(timer); reject(error) })
        })
        const owner = readNativeSessionOwner(pid)
        if (!owner) throw new Error('NATIVE_BROWSER_EXITED')
        let consumed = false
        return {
            owner, terminate,
            async connect(driverOptions: { setAllowedOrigins: (origins: readonly string[]) => void; maxAgentWindows: number }) {
                if (consumed || guardianGone || process.getuid?.() !== runtimeUid || process.geteuid?.() !== runtimeUid) {
                    await terminate(); throw new Error('NATIVE_SERVICE_IDENTITY_REQUIRED')
                }
                consumed = true
                session = await openNativeBrowserSession({ ...driverOptions, owner, input: child.stdio[3] as Writable, output: child.stdio[4] as Readable, terminate,
                    protection: { ...protection, snapshot: async () => {
                        if (guardianGone) throw new Error('NATIVE_OWNER_LOST')
                        const current = await protection.snapshot()
                        if (guardianGone || JSON.stringify(current) !== baseline) throw new Error('NATIVE_PROTECTION_CHANGED')
                        return current
                    } }, checkTimeoutMs: 10000 })
                if (guardianGone) { await session.close(); throw new Error('NATIVE_OWNER_LOST') }
                return session
            },
        }
    } catch (error) {
        await terminate()
        throw error
    }
}

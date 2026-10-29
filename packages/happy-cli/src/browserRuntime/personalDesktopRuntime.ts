import { execFile } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import type { RuntimeConfig } from './runtimeConfig'
import { acquireNativeWriterLock, readNativeSessionOwner } from './nativeHostPrimitives'
import { openNativeBrowserSession, type NativeBrowserSession } from './nativeBrowserSession'
import { launchPersonalBrowser, type PersonalBrowser } from './personalBrowserProcess'

const exec = promisify(execFile)
/** Unix socket paths longer than this do not bind on macOS. */
const DARWIN_SOCKET_PATH_MAX = 103
const GOOGLE_CHROME_REQUIREMENT = '=anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV" and identifier "com.google.Chrome"'

export interface PersonalRuntimePaths {
    root: string
    configFile: string
    stateDir: string
    profileDir: string
    writerLock: string
    runDir: string
    brokerSocket: string
    adminSocket: string
}

/** The one place a personal runtime keeps its files, for the runtime and the daemon alike. */
export function personalRuntimePaths(platform: 'darwin' | 'win32', env: NodeJS.ProcessEnv = process.env, home = homedir()): PersonalRuntimePaths {
    const path = platform === 'win32' ? win32 : posix
    const base = platform === 'win32' ? env.LOCALAPPDATA : path.join(home, 'Library', 'Application Support')
    if (!base || !path.isAbsolute(base)) throw new Error('ABP personal runtime has no user application directory')
    const root = path.join(base, 'Saycode', 'browser-runtime'), runDir = path.join(root, 'run')
    return { root, runDir, configFile: path.join(root, 'runtime.json'), stateDir: path.join(root, 'state'),
        profileDir: path.join(root, 'profile'), writerLock: path.join(root, 'writer.lock'),
        brokerSocket: path.join(runDir, 'broker.sock'), adminSocket: path.join(runDir, 'admin.sock') }
}

/** Creates the user's private directory (0700) or refuses one that is not plainly ours. */
async function privateDirectory(path: string, uid: number): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
        throw new Error('ABP personal runtime directory is not private to this user')
}

export async function verifyPersonalBrowserExecutable(platform: 'darwin' | 'win32', executable: string): Promise<void> {
    if (platform !== 'darwin') throw new Error('PERSONAL_BROWSER_UNSUPPORTED')
    try {
        // No --strict: a user-installed Chrome carries Finder/provenance attributes it rejects.
        // The code seal and Google's signing requirement are still verified.
        await exec('/usr/bin/codesign', ['--verify', '-R', GOOGLE_CHROME_REQUIREMENT, executable], { timeout: 15000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } })
    } catch {
        throw new Error('ABP personal browser is not a signed Google Chrome')
    }
}

export interface PersonalDesktopRuntimeDependencies {
    platform?: NodeJS.Platform
    uid?: number
    env?: NodeJS.ProcessEnv
    home?: string
    /** The daemon's pipe: its end (daemon exit or crash) ends this runtime. */
    parent?: Readable
    prepareDirectory?: (path: string, uid: number) => Promise<void>
    lock?: typeof acquireNativeWriterLock
    verifyExecutable?: typeof verifyPersonalBrowserExecutable
    launch?: typeof launchPersonalBrowser
    readOwner?: typeof readNativeSessionOwner
    openSession?: typeof openNativeBrowserSession
}

export interface PersonalDesktopRuntime {
    session: NativeBrowserSession
    sockets: { broker: string; admin: string }
    onParentLost(listener: () => void): void
    close(): Promise<void>
}

/** Same-user runtime for a single-user PC. No root, service identity or network guard:
 * the dedicated profile, the allow-listed browser environment, pipes instead of a port and
 * owned termination are what it keeps. It never adopts a protected installation's files. */
export async function bootstrapPersonalDesktopRuntime(config: RuntimeConfig, stateDir: string, dependencies: PersonalDesktopRuntimeDependencies = {}): Promise<PersonalDesktopRuntime> {
    const personal = config.personalDesktop
    const platform = dependencies.platform ?? process.platform, env = dependencies.env ?? process.env
    const uid = dependencies.uid ?? process.getuid?.() ?? -1
    if (!personal || personal.platform !== platform || platform !== 'darwin' || uid <= 0) throw new Error('ABP personal runtime requires the signed-in user on its own platform')
    const paths = personalRuntimePaths(platform, env, dependencies.home)
    if (env.ABP_CONFIG_FILE !== paths.configFile || stateDir !== paths.stateDir ||
        env.ABP_KEYS_FILE || env.ABP_PROFILES || env.ABP_VNC_PASSWORD || env.ABP_VNC_PASSWORD_FILE || env.ABP_WRITER_FLOCK)
        throw new Error('ABP personal runtime requires its fixed user configuration')
    if (Buffer.byteLength(paths.brokerSocket) > DARWIN_SOCKET_PATH_MAX || Buffer.byteLength(paths.adminSocket) > DARWIN_SOCKET_PATH_MAX)
        throw new Error('ABP personal runtime socket path is too long for this user directory')
    const prepare = dependencies.prepareDirectory ?? privateDirectory
    for (const directory of [paths.root, paths.stateDir, paths.profileDir, paths.runDir]) await prepare(directory, uid)
    await (dependencies.verifyExecutable ?? verifyPersonalBrowserExecutable)(platform, personal.browserExecutable)

    const lock = await (dependencies.lock ?? acquireNativeWriterLock)(paths.writerLock)
    let browser: PersonalBrowser | undefined
    try {
        browser = await (dependencies.launch ?? launchPersonalBrowser)({ platform, executable: personal.browserExecutable, profileDir: paths.profileDir, env })
        const owner = (dependencies.readOwner ?? readNativeSessionOwner)(browser.pid)
        if (!owner) throw new Error('PERSONAL_BROWSER_EXITED')
        const session = await (dependencies.openSession ?? openNativeBrowserSession)({ input: browser.input, output: browser.output, owner,
            protection: { mode: 'basic', identity: String(uid) }, terminate: browser.terminate, maxAgentWindows: config.maxAgentWindows })
        let closing: Promise<void> | undefined
        const parentListeners: Array<() => void> = []
        const parent = dependencies.parent ?? process.stdin
        let parentLost = false
        const lose = () => { if (parentLost) return; parentLost = true; for (const listener of parentListeners) listener() }
        parent.once('end', lose)
        parent.once('close', lose)
        parent.once('error', lose)
        parent.resume()
        return { session, sockets: { broker: paths.brokerSocket, admin: paths.adminSocket },
            onParentLost(listener) { if (parentLost) listener(); else parentListeners.push(listener) },
            close: () => closing ??= (async () => {
                const result = await session.close()
                await lock.close()
                if (!result.terminated) throw new Error('ABP personal browser termination is unconfirmed')
            })(),
        }
    } catch (error) {
        // Startup failure is fatal; never fall back to the user's own Chrome or a debugging port.
        const cleanup = await Promise.allSettled([browser?.terminate(), lock.close()])
        if (cleanup.some(result => result.status === 'rejected')) throw new Error('ABP personal startup cleanup is unconfirmed')
        throw error
    }
}

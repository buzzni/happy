import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { enterNativeOwnedJob, type NativeOwnedJob } from './nativeHostPrimitives'

/** Variables the browser may see. Everything else (Saycode credentials, provider keys,
 * NODE_OPTIONS, proxies) stays with the runtime; values are copied, never invented. */
const DARWIN_ENV = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'] as const
const WIN32_ENV = ['SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP',
    'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'PUBLIC', 'PATHEXT', 'ComSpec'] as const

export function personalBrowserEnv(platform: 'darwin' | 'win32', source: NodeJS.ProcessEnv): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of platform === 'win32' ? WIN32_ENV : DARWIN_ENV) {
        const value = source[name]
        if (value && !value.includes('\0')) env[name] = value
    }
    env.PATH = platform === 'win32' ? `${env.SystemRoot ?? 'C:\\Windows'}\\System32;${env.SystemRoot ?? 'C:\\Windows'}` : '/usr/bin:/bin'
    return env
}

/** A visible window on the user's desktop: the user signs in to sites there. */
export function personalBrowserArgs(platform: 'darwin' | 'win32', profileDir: string): string[] {
    return ['--remote-debugging-pipe', `--user-data-dir=${profileDir}`,
        '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
        ...platform === 'darwin' ? ['--password-store=basic', '--use-mock-keychain'] : [],
        'about:blank']
}

export interface PersonalProcessTree {
    /** Signals every process of the tree; ESRCH-equivalent is not an error. */
    signal(signal: 'SIGTERM' | 'SIGKILL'): void
    /** True while any process of the tree exists; throws when that cannot be determined. */
    alive(): boolean
}

/** macOS: the browser leads a new process group (detached spawn). The group id cannot be
 * reused while any member lives, so an empty group proves the whole tree is gone. The leader
 * is checked through its own reaped exit first: Darwin answers EPERM, not ESRCH, for a group
 * whose only member is an unreaped zombie. Any answer other than ESRCH counts as alive. */
export function processGroupTree(pgid: number, leaderExited: () => boolean, kill: typeof process.kill = process.kill): PersonalProcessTree {
    if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error('PERSONAL_BROWSER_EXITED')
    return {
        signal(signal) {
            try { kill(-pgid, signal) } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code !== 'ESRCH' && code !== 'EPERM') throw error
            }
        },
        alive() {
            if (!leaderExited()) return true
            try { kill(-pgid, 0); return true } catch (error) {
                return (error as NodeJS.ErrnoException).code !== 'ESRCH'
            }
        },
    }
}

/** Windows: the runtime's own kill-on-close job holds the browser tree. The browser is ended
 * through libuv's original process handle, then the remaining members still in the job. */
export function ownedJobTree(child: Pick<ChildProcess, 'kill' | 'exitCode' | 'signalCode'>, job: NativeOwnedJob): PersonalProcessTree {
    return {
        signal(signal) {
            if (child.exitCode === null && child.signalCode === null) child.kill()
            if (signal === 'SIGKILL') job.terminateMembers()
        },
        alive: () => job.members().length > 0,
    }
}

export interface PersonalBrowserLaunchOptions {
    platform: 'darwin' | 'win32'
    executable: string
    profileDir: string
    env: NodeJS.ProcessEnv
    /** Grace after the pipe EOF and SIGTERM before the tree is killed, and after that kill. */
    termGraceMs?: number
    killGraceMs?: number
}

export interface PersonalBrowserLaunchDependencies {
    spawn?: typeof spawnProcess
    /** Windows: joined before the browser starts so the browser is born inside it. */
    job?: () => NativeOwnedJob
    tree?: (child: ChildProcess) => PersonalProcessTree
    pollMs?: number
}

export interface PersonalBrowser {
    pid: number
    input: Writable
    output: Readable
    /** Resolves only once no process of the tree remains; rejects when that is unconfirmed. */
    terminate(): Promise<void>
}

/** Starts the dedicated-profile browser as the signed-in user with CDP on inherited pipes
 * (fd 3 in, fd 4 out) and no listening port. The browser quits on its own at pipe EOF,
 * including when the runtime is killed. */
export async function launchPersonalBrowser(options: PersonalBrowserLaunchOptions, dependencies: PersonalBrowserLaunchDependencies = {}): Promise<PersonalBrowser> {
    const { platform, executable, profileDir } = options
    const job = platform === 'win32' ? (dependencies.job ?? enterNativeOwnedJob)() : undefined
    const termGrace = options.termGraceMs ?? 5000, killGrace = options.killGraceMs ?? 3000, poll = dependencies.pollMs ?? 100
    const child = (dependencies.spawn ?? spawnProcess)(executable, personalBrowserArgs(platform, profileDir), {
        // macOS: a new process group. Windows: the inherited job, not a detached console group.
        detached: platform === 'darwin', env: personalBrowserEnv(platform, options.env), stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    })
    const started = new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
    })
    await started
    const pid = child.pid
    if (!pid) throw new Error('PERSONAL_BROWSER_EXITED')
    let leaderExited = false
    child.once('exit', () => { leaderExited = true })
    const tree = (dependencies.tree ?? (() => job ? ownedJobTree(child, job) : processGroupTree(pid, () => leaderExited)))(child)
    const input = child.stdio[3] as Writable, output = child.stdio[4] as Readable
    input.on('error', () => {}) // Pipe loss is observed by the session as EOF.
    const settled = async (ms: number) => {
        for (const until = Date.now() + ms; ; await new Promise(resolve => setTimeout(resolve, poll))) {
            if (!tree.alive()) return true
            if (Date.now() >= until) return false
        }
    }
    let closing: Promise<void> | undefined
    const terminate = () => closing ??= (async () => {
        input.destroy()
        output.destroy()
        tree.signal('SIGTERM')
        if (await settled(termGrace)) return
        tree.signal('SIGKILL')
        if (!await settled(killGrace)) throw new Error('PERSONAL_BROWSER_TERMINATION_UNKNOWN')
    })()
    return { pid, input, output, terminate }
}

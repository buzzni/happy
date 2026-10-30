/**
 * Single-user PC (macOS/Windows): the daemon owns the personal browser runtime that the
 * Desktop installer configured in the user's Saycode directory. It starts the runtime as its
 * child (the runtime ends when this daemon's pipe closes), points new sessions at it, and has
 * Studio sign every broker command with the signed-in user's token. The runtime and the
 * browser never receive that token or any other daemon credential.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBrokerRequestOptions } from '@/browserRuntime/brokerGrantSource'
import { personalRuntimePaths } from '@/browserRuntime/personalDesktopRuntime'
import { parseRuntimeConfig } from '@/browserRuntime/runtimeConfig'
import { projectPath } from '@/projectPath'

/** Variables the runtime process may see besides its own two; never credentials or HAPPY_*. */
const RUNTIME_ENV = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'LOCALAPPDATA',
    'APPDATA', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'PUBLIC', 'PATHEXT', 'ComSpec'] as const
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000, 60_000, 120_000]
/** A run this long counts as healthy and resets the restart backoff. */
const HEALTHY_RUN_MS = 5 * 60_000
const STOP_TIMEOUT_MS = 15_000

export interface PersonalBrowserRuntime {
    /** Session environment: where the runtime and its broker are. */
    sessionEnv: Record<string, string>
    native: NativeBrokerRequestOptions
    start(): PersonalBrowserRuntimeProcess
}
export interface PersonalBrowserRuntimeProcess { stop(): Promise<void> }

export interface PersonalBrowserRuntimeOptions {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    /** The user's home directory (macOS); the runtime resolves the same one from HOME. */
    home?: string
    machineId: string
    studioOrigin: string | null
    /** The signed-in user's token, read per request (it may rotate). */
    token: () => string
    log: (message: string) => void
    fetchImpl?: typeof fetch
    spawnImpl?: typeof spawn
    runtimeEntry?: string
    readConfig?: (path: string) => string
    setTimer?: (work: () => void, ms: number) => unknown
    now?: () => number
}

/** The installed personal runtime for this daemon, or undefined when there is none or it is not this machine's. */
export function readPersonalBrowserRuntime(options: PersonalBrowserRuntimeOptions): PersonalBrowserRuntime | undefined {
    const platform = options.platform ?? process.platform, env = options.env ?? process.env
    if (platform !== 'darwin' && platform !== 'win32') return undefined
    let paths: ReturnType<typeof personalRuntimePaths>
    let raw: string
    try {
        paths = personalRuntimePaths(platform, env, options.home)
        raw = (options.readConfig ?? ((path: string) => readFileSync(path, 'utf8')))(paths.configFile)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.log('[DAEMON RUN] Personal browser runtime configuration is unreadable; browser tools stay off')
        return undefined
    }
    let config: ReturnType<typeof parseRuntimeConfig>
    try { config = parseRuntimeConfig(JSON.parse(raw)) } catch {
        options.log('[DAEMON RUN] Personal browser runtime configuration is invalid; browser tools stay off')
        return undefined
    }
    if (config.personalDesktop?.platform !== platform) return undefined
    // Another machine's installation (a copied home directory) never serves this daemon.
    if (config.machineId !== options.machineId) {
        options.log('[DAEMON RUN] Personal browser runtime belongs to another machine; browser tools stay off')
        return undefined
    }
    const studioOrigin = options.studioOrigin
    if (!studioOrigin) {
        options.log('[DAEMON RUN] Personal browser runtime needs the trusted Studio origin to sign commands; browser tools stay off')
        return undefined
    }
    const fetchImpl = options.fetchImpl ?? fetch
    const issue: NativeBrokerRequestOptions['issue'] = async (command) => {
        const url = new URL(`/api/machines/${encodeURIComponent(options.machineId)}/agent-browser/native-command`, studioOrigin)
        let response: Response
        try {
            response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
                headers: { Authorization: `Bearer ${options.token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) })
        } catch { throw new Error('NATIVE_AUTHORIZATION_UNAVAILABLE') }
        if (response.status !== 200) throw new Error(response.status === 403 || response.status === 401 ? 'NATIVE_AUTHORIZATION_DENIED' : 'NATIVE_AUTHORIZATION_UNAVAILABLE')
        const body = await response.json().catch(() => undefined) as { token?: unknown; expiresAtMs?: unknown } | undefined
        if (typeof body?.token !== 'string' || typeof body.expiresAtMs !== 'number') throw new Error('NATIVE_AUTHORIZATION_UNAVAILABLE')
        return { token: body.token, expiresAtMs: body.expiresAtMs }
    }
    const runtimeEnv: Record<string, string> = {}
    for (const name of RUNTIME_ENV) { const value = env[name]; if (value) runtimeEnv[name] = value }
    if (platform === 'darwin') runtimeEnv.PATH = '/usr/bin:/bin'
    Object.assign(runtimeEnv, { ABP_CONFIG_FILE: paths.configFile, ABP_STATE_DIR: paths.stateDir })
    return {
        sessionEnv: {
            HAPPY_BROWSER_TASK_RUNTIME_URL: `http://127.0.0.1:${config.runtimePort}`,
            HAPPY_BROWSER_TASK_BROKER_SOCKET: paths.brokerSocket,
            HAPPY_BROWSER_TASK_PROFILE_ID: config.profiles[0].profileId,
            HAPPY_BROWSER_TASK_TENANCY: 'dedicated',
            HAPPY_BROWSER_TASK_HOST_MODE: 'dedicated-host',
        },
        native: { socketPath: paths.brokerSocket, machineId: config.machineId, workspaceId: config.workspaceId, issue },
        start: () => superviseRuntime(options, runtimeEnv),
    }
}

/** Keeps one runtime child running with bounded backoff; a crash loop gives up instead of spinning. */
function superviseRuntime(options: PersonalBrowserRuntimeOptions, env: Record<string, string>): PersonalBrowserRuntimeProcess {
    const spawnImpl = options.spawnImpl ?? spawn, now = options.now ?? Date.now
    const setTimer = options.setTimer ?? ((work: () => void, ms: number) => setTimeout(work, ms).unref())
    const entry = options.runtimeEntry ?? join(projectPath(), 'dist', 'browserRuntime', 'runtimeMain.mjs')
    let child: ChildProcess | undefined, stopping = false, failures = 0
    let exited: Promise<void> = Promise.resolve()
    const launch = () => {
        if (stopping) return
        const startedAt = now()
        const current = spawnImpl(process.execPath, [entry], { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
        child = current
        current.stdin?.on('error', () => {})
        current.stderr?.setEncoding('utf8')
        current.stderr?.on('data', (chunk: string) => {
            for (const line of chunk.split('\n')) if (line.includes('fatal') || line.includes('listening')) options.log(`[browser-runtime] ${line.trim().slice(0, 300)}`)
        })
        exited = new Promise<void>(resolve => {
            current.once('error', () => resolve())
            current.once('exit', (code) => {
                resolve()
                if (child === current) child = undefined
                if (stopping) return
                failures = now() - startedAt >= HEALTHY_RUN_MS ? 0 : failures + 1
                if (failures > RESTART_DELAYS_MS.length) {
                    options.log(`[DAEMON RUN] Personal browser runtime keeps exiting (code ${code}); browser tools are unavailable until the daemon restarts`)
                    return
                }
                const delay = RESTART_DELAYS_MS[Math.max(0, failures - 1)]
                options.log(`[DAEMON RUN] Personal browser runtime exited (code ${code}); restarting in ${delay} ms`)
                setTimer(launch, delay)
            })
        })
    }
    launch()
    return {
        async stop() {
            stopping = true
            const current = child
            if (!current) return
            // The runtime shuts down at its pipe's end and confirms the browser is gone.
            current.stdin?.end()
            const timeout = new Promise<'timeout'>(resolve => setTimer(() => resolve('timeout'), STOP_TIMEOUT_MS))
            if (await Promise.race([exited.then(() => 'exited' as const), timeout]) === 'timeout') {
                options.log('[DAEMON RUN] Personal browser runtime did not stop in time; ending it')
                current.kill()
                await exited
            }
        },
    }
}

/**
 * Desktop writes the installation after sign-in, while this daemon already runs: check for it
 * until it appears, then hand it to `activate` once and supervise its runtime. A repeated
 * diagnostic is logged once, not every check.
 */
export function watchPersonalBrowserRuntime(options: PersonalBrowserRuntimeOptions & {
    intervalMs?: number
    /** Returns false when the daemon cannot use it (the broker failed); the check continues. */
    activate(runtime: PersonalBrowserRuntime): boolean
}): { stop(): Promise<void> } {
    let lastMessage: string | undefined
    const log = (message: string) => { if (message !== lastMessage) options.log(message); lastMessage = message }
    let running: PersonalBrowserRuntimeProcess | undefined, stopped = false
    let timer: ReturnType<typeof setInterval> | undefined
    const check = () => {
        if (stopped || running) return
        const runtime = readPersonalBrowserRuntime({ ...options, log })
        if (!runtime || !options.activate(runtime)) return
        running = runtime.start()
        if (timer) clearInterval(timer)
    }
    check()
    if (!running) { timer = setInterval(check, options.intervalMs ?? 10_000); timer.unref?.() }
    return {
        async stop() {
            stopped = true
            if (timer) clearInterval(timer)
            await running?.stop()
        },
    }
}

/**
 * Single-user PC (macOS/Windows): the daemon owns the personal browser runtime that the
 * Desktop installer configured in the user's Saycode directory. It starts the runtime as its
 * child (the runtime ends when this daemon's pipe closes), points new sessions at it, and has
 * Studio sign every broker command with user authentication or an approved organization device proof. The runtime and the
 * browser never receive that token or any other daemon credential.
 */
import { createDesktopBrowserLoginClient, type DesktopBrowserLoginDescriptor } from '@/browserRuntime/desktopBrowserLogin'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBrokerRequestOptions } from '@/browserRuntime/brokerGrantSource'
import { openServerEnvelope } from '@/browserRuntime/auth'
import { PERSONAL_RUNTIME_INSTANCE_ENV, personalRuntimePaths } from '@/browserRuntime/personalDesktopRuntime'
import { parseRuntimeConfig } from '@/browserRuntime/runtimeConfig'
import { projectPath } from '@/projectPath'
import type { BrowserNativeDeviceSigner } from './browserNativeDeviceProof'

/** Variables the runtime process may see besides its own two; never credentials or HAPPY_*. */
const RUNTIME_ENV = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'LOCALAPPDATA',
    'APPDATA', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'PUBLIC', 'PATHEXT', 'ComSpec',
    // The runtime resolves its own directory, so it must see the daemon's instance.
    PERSONAL_RUNTIME_INSTANCE_ENV] as const
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000, 60_000, 120_000]
/** A run this long counts as healthy and resets the restart backoff. */
const HEALTHY_RUN_MS = 5 * 60_000
const STOP_TIMEOUT_MS = 15_000
/** Same bound as browser credentials; this schedules dispatch, never relaxes broker admission. */
const MAX_NATIVE_CLOCK_WAIT_MS = 30_000

export interface PersonalBrowserRuntime {
    loginScope: { machineId: string; workspaceId: string; principalId: string; profileId: string }
    /** Session environment: where the runtime and its broker are. */
    sessionEnv: Record<string, string>
    native: NativeBrokerRequestOptions
    /** The runtime's 0600 admin socket (Desktop cookie import, ADR-087). */
    adminSocket: string
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
    /** The daemon's user/company bearer, read per request (it may rotate). */
    token: () => string
    deviceProof?: BrowserNativeDeviceSigner
    desktopLogin?: () => DesktopBrowserLoginDescriptor | undefined
    log: (message: string) => void
    fetchImpl?: typeof fetch
    spawnImpl?: typeof spawn
    runtimeEntry?: string
    readConfig?: (path: string) => string
    setTimer?: (work: () => void, ms: number) => unknown
    now?: () => number
}

/** Every variable `sessionEnv` below can set; activation copies them into the daemon's own environment. */
const PERSONAL_SESSION_ENV = ['HAPPY_BROWSER_TASK_DESKTOP_LOGIN', 'HAPPY_BROWSER_TASK_RUNTIME_URL', 'HAPPY_BROWSER_TASK_BROKER_SOCKET',
    'HAPPY_BROWSER_TASK_PROFILE_ID', 'HAPPY_BROWSER_TASK_TENANCY', 'HAPPY_BROWSER_TASK_HOST_MODE', 'HAPPY_BROWSER_TASK_SEALED_CONSOLE'] as const

/**
 * A daemon started by the previous daemon's handoff, or by one of its sessions, inherits the
 * personal runtime's session variables. Left in place they read as an installer-managed host and
 * keep this daemon from starting the personal runtime, so its browser grants stay disabled.
 * Only variables pointing at this user's personal runtime broker are removed.
 */
export function forgetInheritedPersonalBrowserEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home?: string): boolean {
    if (platform !== 'darwin' && platform !== 'win32') return false
    let brokerSocket: string
    try { brokerSocket = personalRuntimePaths(platform, env, home).brokerSocket } catch { return false }
    if (env.HAPPY_BROWSER_TASK_BROKER_SOCKET !== brokerSocket) return false
    for (const name of PERSONAL_SESSION_ENV) delete env[name]
    return true
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
    const issue: NativeBrokerRequestOptions['issue'] = async (command, signal) => {
        signal?.throwIfAborted()
        const url = new URL(`/api/machines/${encodeURIComponent(options.machineId)}/agent-browser/native-command`, studioOrigin)
        const body = JSON.stringify(command)
        const send = async (proof?: string): Promise<Response> => {
            try {
                signal?.throwIfAborted()
                const timeout = AbortSignal.timeout(10_000)
                return await fetchImpl(url, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                    headers: { Authorization: `Bearer ${options.token()}`, 'Content-Type': 'application/json',
                        ...(proof ? { 'X-Saycode-Browser-Device-Proof': proof } : {}) }, body })
            } catch { signal?.throwIfAborted(); throw new Error('NATIVE_AUTHORIZATION_UNAVAILABLE') }
        }
        // A personal bearer remains valid even for a company workspace. Only an explicit
        // authorization refusal tries machine/device authentication; no command was issued yet.
        const desktopLogin = options.desktopLogin?.()
        const relay = desktopLogin ? createDesktopBrowserLoginClient(desktopLogin, {
            machineId: config.machineId, workspaceId: config.workspaceId, principalId: config.profiles[0].principalId,
            profileId: config.profiles[0].profileId,
        }) : undefined
        let response = relay
            ? new Response(JSON.stringify(await relay.issue(command, signal)), { status: 200 })
            : await send()
        if ((response.status === 401 || response.status === 403) && !config.workspaceId.startsWith('personal:')) {
            if (!options.deviceProof) throw new Error('NATIVE_DEVICE_APPROVAL_REQUIRED')
            const proof = await options.deviceProof({ studioOrigin, machineId: config.machineId,
                workspaceId: config.workspaceId, path: url.pathname, body })
            response = await send(proof)
        }
        if (response.status !== 200) throw new Error(response.status === 403 || response.status === 401 ? 'NATIVE_AUTHORIZATION_DENIED' : 'NATIVE_AUTHORIZATION_UNAVAILABLE')
        const result = await response.json().catch(() => undefined) as { token?: unknown; expiresAtMs?: unknown } | undefined
        if (typeof result?.token !== 'string' || typeof result.expiresAtMs !== 'number') throw new Error('NATIVE_AUTHORIZATION_UNAVAILABLE')
        let claims: { issuedAtMs?: unknown; expiresAtMs?: unknown }
        try { claims = openServerEnvelope(result.token.split('.'), 'abp-native-command', config.trustedIssuers) }
        catch { throw new Error('NATIVE_AUTHORIZATION_UNAVAILABLE') }
        if (!claims || typeof claims.issuedAtMs !== 'number' || !Number.isSafeInteger(claims.issuedAtMs) || claims.issuedAtMs < 0 ||
            claims.expiresAtMs !== result.expiresAtMs) throw new Error('NATIVE_AUTHORIZATION_UNAVAILABLE')
        const now = options.now ?? Date.now
        const waitMs = claims.issuedAtMs - now()
        if (waitMs > MAX_NATIVE_CLOCK_WAIT_MS) throw new Error('NATIVE_AUTHORIZATION_UNAVAILABLE')
        // An issuer a few milliseconds ahead otherwise produces an immediate local 401.
        // Wait before the first dispatch: the signed bytes and one-use authorization stay unchanged.
        signal?.throwIfAborted()
        if (waitMs > 0) await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, waitMs + 1)
            const cancel = () => { clearTimeout(timer); reject(signal?.reason) }
            signal?.addEventListener('abort', cancel, { once: true })
        })
        signal?.throwIfAborted()
        if (claims.issuedAtMs > now()) throw new Error('NATIVE_AUTHORIZATION_UNAVAILABLE')
        return { token: result.token, expiresAtMs: result.expiresAtMs }
    }
    const runtimeEnv: Record<string, string> = {}
    for (const name of RUNTIME_ENV) { const value = env[name]; if (value) runtimeEnv[name] = value }
    if (platform === 'darwin') runtimeEnv.PATH = '/usr/bin:/bin'
    Object.assign(runtimeEnv, { ABP_CONFIG_FILE: paths.configFile, ABP_STATE_DIR: paths.stateDir })
    return {
        loginScope: { machineId: config.machineId, workspaceId: config.workspaceId,
            principalId: config.profiles[0].principalId, profileId: config.profiles[0].profileId },
        sessionEnv: {
            ...(options.desktopLogin?.() ? { HAPPY_BROWSER_TASK_DESKTOP_LOGIN: '1' } : {}),
            HAPPY_BROWSER_TASK_RUNTIME_URL: `http://127.0.0.1:${config.runtimePort}`,
            HAPPY_BROWSER_TASK_BROKER_SOCKET: paths.brokerSocket,
            HAPPY_BROWSER_TASK_PROFILE_ID: config.profiles[0].profileId,
            HAPPY_BROWSER_TASK_TENANCY: 'dedicated',
            HAPPY_BROWSER_TASK_HOST_MODE: 'dedicated-host',
            // Its console serves the remote page view, so it is reachable over the customer-key RPC (desktop ADR-085).
            HAPPY_BROWSER_TASK_SEALED_CONSOLE: '1',
        },
        native: { socketPath: paths.brokerSocket, machineId: config.machineId, workspaceId: config.workspaceId, issue },
        adminSocket: paths.adminSocket,
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
        const desktopLogin = options.desktopLogin?.()
        const current = spawnImpl(process.execPath, [entry], {
            env: { ...env, ...(desktopLogin ? { ABP_DESKTOP_BROWSER_LOGIN_FD: '3' } : {}) },
            stdio: desktopLogin ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'], windowsHide: true,
        })
        if (desktopLogin) {
            const channel = current.stdio[3] as import('node:stream').Writable
            channel.on('error', () => {})
            channel.end(JSON.stringify(desktopLogin))
        }
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
}): { stop(): Promise<void>; refresh(): Promise<void> } {
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
    let refreshing: Promise<void> = Promise.resolve()
    return {
        refresh() {
            refreshing = refreshing.catch(() => {}).then(async () => {
                if (stopped) return
                const previous = running; running = undefined
                await previous?.stop()
                check()
            })
            return refreshing
        },
        async stop() {
            stopped = true
            if (timer) clearInterval(timer)
            await refreshing.catch(() => {})
            await running?.stop()
        },
    }
}

/**
 * Machine-side pieces of the remote browser screen (noVNC over the preview
 * relay), so a user can open an arbitrary site and log in by hand — 2FA and
 * captcha included — without an SSH tunnel.
 *
 * Why noVNC and not Chrome's own DevTools screencast: the bridge's `click` /
 * `fill` are ref-based (they need a `snapshot` ref, not coordinates), so a
 * home-grown screenshot viewer cannot drive a captcha. A real interactive
 * screen is required, and noVNC keeps raw CDP unexposed while giving the
 * user a browser with an address bar. See specs/browser-remote-login/.
 */

import { spawn } from 'node:child_process'

/** Binaries the remote screen needs, in the order a user should install them. */
export const VIEWER_TOOLS = ['Xvfb', 'x11vnc', 'websockify'] as const
export type ViewerTool = (typeof VIEWER_TOOLS)[number]

/** apt package that provides each binary — they do not all match by name. */
const APT_PACKAGE: Record<string, string> = {
    Xvfb: 'xvfb',
    x11vnc: 'x11vnc',
    websockify: 'websockify',
    novnc: 'novnc',
}

export function buildXvfbArgs({ display, width, height }: {
    display: string
    width: number
    height: number
}): string[] {
    return [display, '-screen', '0', `${width}x${height}x24`]
}

export function buildX11vncArgs({ display, vncPort }: { display: string; vncPort: number }): string[] {
    return [
        '-display', display,
        '-rfbport', String(vncPort),
        // Loopback only: VNC here carries no authentication of its own, so
        // the daemon relay must be the only thing that can reach it.
        '-localhost',
        // Survive the viewer closing its tab — otherwise the next attempt
        // finds nothing listening and looks like a broken feature.
        '-forever',
        '-shared',
        '-nopw',
        '-quiet',
    ]
}

export function buildWebsockifyArgs({ webPort, vncPort, webRoot }: {
    webPort: number
    vncPort: number
    webRoot: string
}): string[] {
    return ['--web', webRoot, `127.0.0.1:${webPort}`, `127.0.0.1:${vncPort}`]
}

export type ViewerInstallPlan =
    | { action: 'already-installed'; command?: undefined; reason?: undefined }
    | { action: 'run'; command: string; reason?: undefined }
    | { action: 'manual'; command: string; reason: string }

function installCommandFor(missing: string[]): string {
    // novnc ships the web assets websockify serves; pull it whenever anything
    // is missing so the client page exists.
    const packages = [...new Set([...missing.map((tool) => APT_PACKAGE[tool] ?? tool), 'novnc'])]
    // `apt-get update` first: unlike Chrome's install (a .deb fetched
    // directly), these come from the apt repo, so a machine whose package
    // list was never refreshed fails every install with "Unable to locate
    // package" — observed live on coder-ceb52f63 (2026-08-17).
    return `sudo apt-get update -qq && sudo apt-get install -y ${packages.join(' ')}`
}

/**
 * Same honesty rule as planChromeInstall: these are system packages, so
 * without root there is no unattended path and pretending otherwise would
 * leave the user hunting for a screen that was never set up.
 */
export function planViewerInstall({ missing, canSudo, platform = process.platform }: {
    missing: string[]
    canSudo: boolean
    platform?: NodeJS.Platform
}): ViewerInstallPlan {
    if (missing.length === 0) {
        return { action: 'already-installed' }
    }
    if (platform !== 'linux') {
        return {
            action: 'manual',
            command: '',
            reason: '원격 화면은 터미널 전용 Linux 머신을 위한 기능입니다. 데스크톱에서는 그 컴퓨터의 Chrome 을 그대로 쓰세요.',
        }
    }
    const command = installCommandFor(missing)
    if (canSudo) {
        return { action: 'run', command }
    }
    return {
        action: 'manual',
        command,
        reason: '원격 화면에 필요한 패키지는 시스템 패키지라 root 없이 설치할 수 없습니다. 이 명령을 서버에서 한 번 실행해 주세요.',
    }
}

/**
 * The viewer web ports we bind, in the order the start path tries them.
 *
 * Shared so the adoption scan and pickFreePort cannot drift: a port added to
 * only one of them would never be adopted, and a duplicate stack would be
 * spawned next to the one already serving it.
 */
export const VIEWER_WEB_PORTS = [6080, 6081, 6082] as const

/** VNC ports paired with VIEWER_WEB_PORTS, same ordering. */
export const VIEWER_VNC_PORTS = [5900, 5901, 5902] as const

export type ViewerStackDecision =
    | { action: 'reuse'; webPort: number }
    | { action: 'adopt'; webPort: number }
    | { action: 'start'; webPort?: undefined }

/**
 * What `browser-viewer:start` should do, given what is actually alive.
 *
 * Two failures this replaces, both from trusting the in-memory cache:
 *
 * - The cache was assign-only and never probed, so a crashed stack kept
 *   reporting `ready: true` and every retry handed back the same dead port.
 *   Nothing short of a daemon restart recovered it.
 * - The stack is spawned detached, so it outlives the daemon. After a restart
 *   the cache is empty but the processes are still holding their ports, and
 *   starting again leaks a second full stack. A few restarts exhaust the
 *   candidate ports and the feature fails with "포트를 찾지 못했습니다".
 *
 * `adoptable` must come from a probe that the port really serves noVNC, not
 * merely that something is listening — otherwise an unrelated service on
 * 6080 would be handed to the user as their browser screen.
 */
export function decideViewerStackAction(input: {
    cached: { webPort: number } | null
    cachedAlive: boolean
    adoptable: { webPort: number } | null
}): ViewerStackDecision {
    if (input.cached && input.cachedAlive) {
        return { action: 'reuse', webPort: input.cached.webPort }
    }
    if (input.adoptable) {
        return { action: 'adopt', webPort: input.adoptable.webPort }
    }
    return { action: 'start' }
}

export type ViewerBrowserDecision =
    | { action: 'reuse'; cdpPort: number }
    | { action: 'launch'; cdpPort?: undefined }
    | { action: 'defer'; cdpPort?: undefined }

/**
 * Whether the viewer display still needs a browser put on it.
 *
 * Xvfb by itself renders nothing, so a viewer started without a browser is a
 * black screen — which is exactly what the "원격 브라우저 화면 열기" button
 * produced: the open flow brought up Xvfb/x11vnc/websockify and never
 * launched Chrome onto the display.
 *
 * `liveCdpPort` must come from probing our own CDP candidate ports, so a
 * browser that outlived the daemon is reused rather than stacked on top of.
 */
export function decideViewerBrowserAction(input: {
    liveCdpPort: number | null
    callerWillLaunchBrowser: boolean
}): ViewerBrowserDecision {
    if (input.callerWillLaunchBrowser) {
        return { action: 'defer' }
    }
    if (input.liveCdpPort !== null) {
        return { action: 'reuse', cdpPort: input.liveCdpPort }
    }
    return { action: 'launch' }
}

export type ViewerBrowserSummary =
    | { browserReady: true; cdpPort: number; reason?: undefined }
    | { browserReady: false; reason: 'chrome-not-installed' | 'browser-failed'; cdpPort?: undefined }

/**
 * What `browser-viewer:start` should tell the caller about the screen.
 *
 * The viewer stack coming up is not the same as the screen being usable: a
 * machine with Xvfb/x11vnc/websockify but no Chrome serves a perfectly
 * healthy connection to an empty display, which the user sees as a black
 * screen with nothing explaining it (observed on a dev machine 2026-08-15).
 * So the reason travels up instead of being swallowed.
 */
export function summariseViewerBrowser(input: {
    chromeInstalled: boolean
    cdpPort: number | null
}): ViewerBrowserSummary {
    if (!input.chromeInstalled) return { browserReady: false, reason: 'chrome-not-installed' }
    if (input.cdpPort === null) return { browserReady: false, reason: 'browser-failed' }
    return { browserReady: true, cdpPort: input.cdpPort }
}

/** Reads DISPLAY from a NUL-separated `/proc/<pid>/environ` block. */
export function readDisplayFromEnviron(environ: string): string | null {
    for (const entry of environ.split('\0')) {
        if (!entry.startsWith('DISPLAY=')) continue
        return entry.slice('DISPLAY='.length) || null
    }
    return null
}

/** Reads an exact `--flag=value` argument from `/proc/<pid>/cmdline`. */
export function readFlagFromCmdline(cmdline: string, flag: string): string | null {
    const prefix = `${flag}=`
    const nulSeparatedArgs = cmdline.split('\0').filter(Boolean)
    const args = nulSeparatedArgs.length === 1
        ? nulSeparatedArgs[0].trim().split(/\s+/)
        : nulSeparatedArgs
    for (const arg of args) {
        if (!arg.startsWith(prefix)) continue
        return arg.slice(prefix.length) || null
    }
    return null
}

function which(binary: string): Promise<string | null> {
    return new Promise((resolve) => {
        const child = spawn('which', [binary], { stdio: ['ignore', 'pipe', 'ignore'] })
        let out = ''
        child.stdout?.on('data', (chunk) => { out += String(chunk) })
        child.on('error', () => resolve(null))
        child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null))
    })
}

/** Which viewer binaries are absent on this machine. */
export async function detectMissingViewerTools(): Promise<string[]> {
    const missing: string[] = []
    for (const tool of VIEWER_TOOLS) {
        if (!(await which(tool))) missing.push(tool)
    }
    return missing
}

/**
 * Whether that port is actually serving noVNC's client page.
 *
 * Deliberately stricter than "something is listening": the result decides
 * whether we hand this port to the user as their browser screen, and an
 * unrelated service that happens to hold 6080 must not qualify.
 */
export async function isViewerServing(webPort: number): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${webPort}/vnc.html`, {
            signal: AbortSignal.timeout(1500),
        })
        return response.ok
    } catch {
        return false
    }
}

/** Spawns a long-lived viewer process detached so it outlives the daemon. */
export function spawnDetached(command: string, args: string[], env?: NodeJS.ProcessEnv): { pid: number | undefined } {
    const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        env: env ? { ...process.env, ...env } : process.env,
    })
    child.unref()
    return { pid: child.pid }
}

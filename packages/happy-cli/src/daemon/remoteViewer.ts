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
import { join } from 'node:path'

import type { ViewerResizeMode } from './viewerWebRoot'

/** apt package that provides each binary — they do not all match by name. */
const APT_PACKAGE: Record<string, string> = {
    Xvfb: 'xvfb',
    Xvnc: 'tigervnc-standalone-server',
    vncconfig: 'tigervnc-common',
    x11vnc: 'x11vnc',
    openbox: 'openbox',
    websockify: 'websockify',
    novnc: 'novnc',
}

/** What this machine can actually run for the remote screen. */
export type ViewerCapabilities = {
    hasXvnc: boolean
    hasXvfb: boolean
    hasX11vnc: boolean
    hasWebsockify: boolean
    hasWindowManager: boolean
    /**
     * TigerVNC's clipboard helper — see {@link buildVncConfigArgs}.
     *
     * Required rather than optional on purpose: a caller that leaves it out
     * would lose pasting into the remote screen and nothing would say so.
     */
    hasVncConfig: boolean
}

export type ViewerBackend = {
    kind: 'xvnc' | 'xvfb-x11vnc'
    resizeMode: ViewerResizeMode
    windowManager: boolean
}

/**
 * Which display server to run, and what the client may ask it for.
 *
 * `remote` resize — the client asking the server to match its window, which
 * is the only way to fill a browser window exactly — needs two things at
 * once, and both are checked here rather than assumed:
 *
 * - a server that implements `SetDesktopSize`. x11vnc has no such hook at
 *   all (no `setDesktopSizeHook` in its source), so the request is silently
 *   dropped and the screen stays clipped. TigerVNC's Xvnc implements it.
 * - something that re-fits the browser window afterwards. The viewer display
 *   has no window manager of its own, and Chrome's window is final once
 *   opened (measured 2026-09-14), so a resized desktop without a WM leaves
 *   the browser covering only part of it — worse than scaling.
 */
export function selectViewerBackend(capabilities: ViewerCapabilities): ViewerBackend | null {
    if (!capabilities.hasWebsockify) return null
    if (capabilities.hasXvnc) {
        return {
            kind: 'xvnc',
            resizeMode: capabilities.hasWindowManager ? 'remote' : 'scale',
            windowManager: capabilities.hasWindowManager,
        }
    }
    if (capabilities.hasXvfb && capabilities.hasX11vnc) {
        return { kind: 'xvfb-x11vnc', resizeMode: 'scale', windowManager: capabilities.hasWindowManager }
    }
    return null
}

/**
 * What the screen cannot open without.
 *
 * Deliberately not the same list as {@link desiredViewerTools}: a machine
 * whose Xvfb/x11vnc screen already works must not be told it is broken
 * because it lacks the newer server.
 */
export function missingViewerTools(capabilities: ViewerCapabilities): string[] {
    const missing: string[] = []
    if (!capabilities.hasXvnc && !(capabilities.hasXvfb && capabilities.hasX11vnc)) {
        missing.push('Xvnc')
    }
    if (!capabilities.hasWebsockify) missing.push('websockify')
    return missing
}

/**
 * What an explicit install should put on the machine — the blockers plus
 * whatever is still missing for an exact fill. Installing is the moment the
 * user has already accepted a package change, so it is also the moment to
 * close the gap; nothing here is installed behind their back.
 */
export function desiredViewerTools(capabilities: ViewerCapabilities): string[] {
    const desired = missingViewerTools(capabilities)
    if (!capabilities.hasXvnc && !desired.includes('Xvnc')) desired.push('Xvnc')
    if (!capabilities.hasWindowManager) desired.push('openbox')
    // Normally arrives with Xvnc's own package, so this only fires on a
    // machine that lost it — where pasting is broken and nothing else in
    // this list would bring it back.
    if (!capabilities.hasVncConfig) desired.push('vncconfig')
    return desired
}

/**
 * The size the remote screen starts at.
 *
 * Read by both the display server and the browser window, because without a
 * window manager nothing can maximize or resize a window after the fact, so
 * a browser that does not open at the screen's own size leaves dead black
 * space the user cannot reclaim.
 *
 * Only a starting point on the Xvnc backend: the viewer resizes the desktop
 * to its own window as soon as it connects, and openbox refits the browser.
 */
export const VIEWER_SCREEN = { width: 1920, height: 1080 } as const

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

/**
 * TigerVNC's Xvnc: an X server and a VNC server in one process, replacing
 * the Xvfb + x11vnc pair. Taken for one property the pair cannot offer —
 * it accepts `SetDesktopSize`, so the remote screen becomes exactly the
 * size of the viewer's window instead of being letterboxed into it.
 */
export function buildXvncArgs({ display, vncPort, width, height }: {
    display: string
    vncPort: number
    width: number
    height: number
}): string[] {
    return [
        display,
        '-geometry', `${width}x${height}`,
        '-depth', '24',
        '-rfbport', String(vncPort),
        // Same posture as the x11vnc path: no authentication of its own, so
        // loopback only and the daemon relay is the only way in.
        '-localhost',
        '-SecurityTypes=None',
        '-AlwaysShared=1',
        '-AcceptSetDesktopSize=1',
        '-desktop', 'Saycode remote browser',
    ]
}

/**
 * TigerVNC hands the VNC clipboard to X through a helper, not from inside
 * Xvnc: without `vncconfig` running on the display, nothing takes ownership
 * of the X CLIPBOARD selection and a paste from the viewer lands nowhere
 * (measured — with the helper the selection carries the text and offers
 * UTF8_STRING, without it there is no selection owner at all).
 *
 * `-nowin` keeps it headless: the helper's own window would otherwise sit on
 * the screen the user is looking at.
 */
export function buildVncConfigArgs(): string[] {
    return ['-nowin']
}

/**
 * Openbox exists here for exactly one behaviour: on an RandR screen change
 * it reconfigures every client (`screen_resize()` → `client_reconfigure()`),
 * which is what re-fits the browser to a desktop the viewer just resized.
 *
 * Every window is forced maximized and undecorated so the browser covers the
 * screen with no title bar of its own — this display has one application and
 * no user sitting at it to arrange windows.
 */
export function buildOpenboxConfig(): string {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<openbox_config xmlns="http://openbox.org/3.4/rc">',
        '  <applications>',
        '    <application class="*">',
        '      <decor>no</decor>',
        '      <maximized>yes</maximized>',
        '    </application>',
        '  </applications>',
        '</openbox_config>',
        '',
    ].join('\n')
}

export function buildOpenboxArgs({ configPath }: { configPath: string }): string[] {
    // --sm-disable: no session manager on this display, and openbox otherwise
    // waits on one at startup.
    return ['--sm-disable', '--config-file', configPath]
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
export const VIEWER_SLOTS = [
    { slot: 0, display: ':99', vncPort: 5900, webPort: 6080 },
    { slot: 1, display: ':100', vncPort: 5901, webPort: 6081 },
    { slot: 2, display: ':101', vncPort: 5902, webPort: 6082 },
] as const

export type ViewerSlot = (typeof VIEWER_SLOTS)[number]

export const VIEWER_WEB_PORTS = VIEWER_SLOTS.map(({ webPort }) => webPort)

/** VNC ports paired with VIEWER_WEB_PORTS, same ordering. */
export const VIEWER_VNC_PORTS = VIEWER_SLOTS.map(({ vncPort }) => vncPort)

const VIEWER_KEY_RE = /^bv1_[A-Za-z0-9_-]{32}$/

export function validateViewerKey(viewerKey: string): boolean {
    return VIEWER_KEY_RE.test(viewerKey)
}

export function selectViewerSlot(occupiedSlots: ReadonlySet<number>): ViewerSlot | null {
    return VIEWER_SLOTS.find(({ slot }) => !occupiedSlots.has(slot)) ?? null
}

export function resolveViewerProfileDir(happyHomeDir: string, viewerKey: string): string {
    if (!validateViewerKey(viewerKey)) throw new Error('invalid viewerKey')
    return join(happyHomeDir, 'browser-viewers', viewerKey, 'chrome-profile')
}

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

export function viewerProcessMatchesLease(
    kind: 'xvfb' | 'xvnc' | 'x11vnc' | 'websockify',
    cmdline: string,
    lease: { display: string; vncPort: number; webPort: number },
): boolean {
    const nulSeparated = cmdline.split('\0').filter(Boolean)
    const args = nulSeparated.length === 1
        ? nulSeparated[0].trim().split(/\s+/)
        : nulSeparated
    const hasExecutable = args.some((arg) => arg.split('/').pop()?.toLowerCase() === kind)
    if (!hasExecutable) return false
    if (kind === 'xvfb') return args.includes(lease.display)
    if (kind === 'xvnc') {
        // Xvnc is both the X server and the VNC server, so its own cmdline
        // carries the two facts that identify the slot.
        const portAt = args.indexOf('-rfbport')
        return args.includes(lease.display) && args[portAt + 1] === String(lease.vncPort)
    }
    if (kind === 'x11vnc') {
        const displayAt = args.indexOf('-display')
        const portAt = args.indexOf('-rfbport')
        return args[displayAt + 1] === lease.display && args[portAt + 1] === String(lease.vncPort)
    }
    return args.includes(`127.0.0.1:${lease.webPort}`)
        && args.includes(`127.0.0.1:${lease.vncPort}`)
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

/** What this machine has installed, as {@link selectViewerBackend} reads it. */
export async function detectViewerCapabilities(): Promise<ViewerCapabilities> {
    const [xvnc, xvfb, x11vnc, websockify, openbox, vncconfig] = await Promise.all([
        which('Xvnc'),
        which('Xvfb'),
        which('x11vnc'),
        which('websockify'),
        which('openbox'),
        which('vncconfig'),
    ])
    return {
        hasXvnc: xvnc !== null,
        hasXvfb: xvfb !== null,
        hasX11vnc: x11vnc !== null,
        hasWebsockify: websockify !== null,
        hasWindowManager: openbox !== null,
        hasVncConfig: vncconfig !== null,
    }
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

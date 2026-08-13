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
    return `sudo apt-get install -y ${packages.join(' ')}`
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

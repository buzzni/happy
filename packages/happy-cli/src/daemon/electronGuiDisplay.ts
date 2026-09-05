/**
 * Host-mode (legacy / no docker) display planning for `electron-gui` previews.
 *
 * The screen itself is streamed by the CDP screencast bridge that the daemon
 * preloads into the Electron main process (src/electronGuiPreload.ts), so the
 * only OS-specific need is "can Electron open a window here at all":
 *
 * - Linux without a desktop needs a virtual X display — Xvfb only. No
 *   x11vnc/websockify/noVNC: those belong to the container (noVNC) provider.
 * - macOS draws through WindowServer, so Xvfb is meaningless; what matters is
 *   that the daemon runs inside a logged-in GUI session (`launchctl
 *   managername` == "Aqua"). A daemon started over SSH cannot create windows,
 *   and pretending otherwise yields a silent black stream.
 *
 * aplus-dev-studio specs/electron-gui-preview-cross-platform Phase 3.
 */

/**
 * Dedicated display for Electron previews. Apps' windows are captured through
 * their own webContents, not the X framebuffer, so every preview on the
 * machine can share this one display. Deliberately outside the browser
 * viewer slots (:99–:101, remoteViewer.ts) so the two features never race
 * for a display number.
 */
export const ELECTRON_GUI_DISPLAY = ':120'

export type ElectronGuiInstallPlan =
    | { action: 'run'; command: string; reason?: undefined }
    | { action: 'manual'; command: string; reason: string }

export type ElectronGuiDisplayPlan =
    | { ok: true; display: string | null; needsXvfb: boolean }
    | { ok: false; reason: 'xvfb-missing'; install: ElectronGuiInstallPlan }
    | { ok: false; reason: 'no-gui-session'; message: string }

const XVFB_INSTALL_COMMAND = 'sudo apt-get update -qq && sudo apt-get install -y xvfb'

export function planElectronGuiDisplay(input: {
    platform: NodeJS.Platform
    xvfbInstalled: boolean
    canSudo: boolean
    /** `launchctl managername` output on macOS; null elsewhere or when unknown. */
    guiSession: string | null
}): ElectronGuiDisplayPlan {
    if (input.platform === 'linux') {
        if (input.xvfbInstalled) return { ok: true, display: ELECTRON_GUI_DISPLAY, needsXvfb: true }
        const install: ElectronGuiInstallPlan = input.canSudo
            ? { action: 'run', command: XVFB_INSTALL_COMMAND }
            : {
                action: 'manual',
                command: XVFB_INSTALL_COMMAND,
                reason: 'Electron 미리보기에 필요한 가상 디스플레이(Xvfb)는 시스템 패키지라 root 없이 설치할 수 없습니다. 이 명령을 서버에서 한 번 실행해 주세요.',
            }
        return { ok: false, reason: 'xvfb-missing', install }
    }
    if (input.platform === 'darwin') {
        if (input.guiSession === 'Aqua') return { ok: true, display: null, needsXvfb: false }
        return {
            ok: false,
            reason: 'no-gui-session',
            message: '이 Mac 에 로그인된 화면 세션이 없어 Electron 창을 만들 수 없습니다. 데스크톱 앱이나 로그인된 터미널에서 데몬을 시작해 주세요.',
        }
    }
    return { ok: true, display: null, needsXvfb: false }
}

// ---------------------------------------------------------------------------
// Runtime side (daemon RPC `gui-display:ensure`)
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnDetached, buildXvfbArgs } from './remoteViewer'

export type ElectronGuiDisplayEnsureResult =
    | { ok: true; provider: 'cdp-screencast'; display: string | null; env: Record<string, string> }
    | { ok: false; reason: 'xvfb-missing'; install: ElectronGuiInstallPlan; message: string }
    | { ok: false; reason: 'no-gui-session' | 'xvfb-failed' | 'preload-missing' | 'invalid-port'; message: string }

function run(command: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(command, args, { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
            resolve(error ? null : String(stdout))
        })
    })
}

async function commandExists(name: string): Promise<boolean> {
    return (await run('which', [name])) !== null
}

/** `launchctl managername` prints "Aqua" inside a logged-in macOS GUI session. */
async function macGuiSessionManager(): Promise<string | null> {
    const output = await run('launchctl', ['managername'])
    return output ? output.trim() : null
}

function xSocketPath(display: string): string {
    return `/tmp/.X11-unix/X${display.slice(1)}`
}

async function ensureXvfb(display: string): Promise<boolean> {
    const socket = xSocketPath(display)
    if (existsSync(socket)) return true
    spawnDetached('Xvfb', buildXvfbArgs({ display, width: 1280, height: 800 }))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
        if (existsSync(socket)) return true
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
}

/**
 * NODE_OPTIONS value that loads the preload into every Node process of the
 * dev command. Kept separate so the caller can merge it with an existing
 * NODE_OPTIONS; quoted only when the path needs it (Node honours double
 * quotes inside NODE_OPTIONS).
 */
export function preloadNodeOption(preloadPath: string): string {
    return /\s/.test(preloadPath) ? `--require "${preloadPath}"` : `--require ${preloadPath}`
}

export async function ensureElectronGuiDisplay(input: {
    streamPort: unknown
    packageRoot: string
    platform?: NodeJS.Platform
    canSudo: () => Promise<boolean>
}): Promise<ElectronGuiDisplayEnsureResult> {
    const streamPort = Number(input.streamPort)
    if (!Number.isInteger(streamPort) || streamPort <= 0 || streamPort > 65535) {
        return { ok: false, reason: 'invalid-port', message: 'streamPort is required' }
    }
    const preloadPath = join(input.packageRoot, 'dist', 'electronGuiPreload.cjs')
    if (!existsSync(preloadPath)) {
        return { ok: false, reason: 'preload-missing', message: `Electron 미리보기 브리지 파일이 없습니다: ${preloadPath} (happy-cli 를 업데이트해 주세요)` }
    }
    const platform = input.platform ?? process.platform
    const plan = planElectronGuiDisplay({
        platform,
        xvfbInstalled: platform === 'linux' ? await commandExists('Xvfb') : false,
        canSudo: platform === 'linux' ? await input.canSudo() : false,
        guiSession: platform === 'darwin' ? await macGuiSessionManager() : null,
    })
    if (!plan.ok) {
        if (plan.reason === 'xvfb-missing') {
            return { ok: false, reason: plan.reason, install: plan.install, message: plan.install.reason ?? 'Electron 미리보기에 필요한 가상 디스플레이(Xvfb)가 없습니다.' }
        }
        return { ok: false, reason: plan.reason, message: plan.message }
    }
    if (plan.needsXvfb && plan.display && !(await ensureXvfb(plan.display))) {
        return { ok: false, reason: 'xvfb-failed', message: `가상 디스플레이 ${plan.display} 를 띄우지 못했습니다.` }
    }
    const env: Record<string, string> = {
        APLUS_GUI_STREAM_PORT: String(streamPort),
        APLUS_GUI_PROVIDER: 'cdp-screencast',
        NODE_OPTIONS: preloadNodeOption(preloadPath),
        ...(plan.display ? { DISPLAY: plan.display } : {}),
    }
    return { ok: true, provider: 'cdp-screencast', display: plan.display, env }
}

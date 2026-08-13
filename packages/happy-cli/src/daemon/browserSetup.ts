/**
 * Machine-side primitives behind the app's browser setup buttons.
 *
 * Splits the parts worth testing (which flags, which directory, whether an
 * install can honestly run) away from the parts that only spawn processes,
 * so the flag list that silently breaks pairing when wrong has a regression
 * test around it.
 *
 * See specs/browser-setup-gui/.
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Binaries that ship Chrome's CDP + extension support, most preferred first. */
export const CHROME_BINARIES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']

export interface ChromeLaunchOptions {
    userDataDir: string
    cdpPort: number
    /** Omitted means headful — the caller decides based on DISPLAY. */
    headless?: boolean
}

export function buildChromeLaunchArgs({ userDataDir, cdpPort, headless }: ChromeLaunchOptions): string[] {
    const args = [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        // Chrome 137+ ignores --load-extension; `happy browser pair` injects
        // the extension over CDP instead, and Chrome only allows that call
        // when this flag is present. Dropping it breaks pairing outright.
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
    ]
    if (headless) {
        // `--headless=new` specifically: bare --headless is --headless=old,
        // which supports no extensions at all.
        args.push('--headless=new')
    }
    return args
}

/**
 * Per-profile Chrome directory. Distinct directories are what let two
 * profiles hold two different logins at once.
 */
export function resolveProfileUserDataDir(root: string, profile: string): string {
    const dir = resolve(join(root, profile))
    const rootPrefix = resolve(root) + sep
    if (!dir.startsWith(rootPrefix)) {
        throw new Error(`profile name escapes the profile root: ${profile}`)
    }
    return dir
}

export type ChromeInstallPlan =
    | { action: 'already-installed'; command?: undefined; reason?: undefined }
    | { action: 'run'; command: string; reason?: undefined }
    | { action: 'manual'; command: string; reason: string }

const INSTALL_COMMAND = [
    'wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb',
    'sudo apt-get install -y /tmp/google-chrome.deb',
].join(' && ')

/**
 * Decides whether the install button can act on its own.
 *
 * There is no unattended no-root path: Chrome links against system shared
 * libraries (libnss3, libgbm1, libatk-1.0, ...) that only a package manager
 * can place. Unpacking the .deb into $HOME yields a binary that cannot start.
 * So when sudo is unavailable this returns the exact command to paste rather
 * than pretending the install happened.
 */
export function planChromeInstall({ chromePath, canSudo, platform = process.platform }: {
    chromePath: string | null
    canSudo: boolean
    platform?: NodeJS.Platform
}): ChromeInstallPlan {
    if (chromePath) {
        return { action: 'already-installed' }
    }
    if (platform !== 'linux') {
        // This flow exists for terminal-only Linux boxes. On a desktop OS
        // Chrome is installed the normal way and simply is not on PATH, so
        // an apt command here would be actively wrong.
        return {
            action: 'manual',
            command: '',
            reason: '이 기능은 터미널 전용 Linux 머신을 위한 것입니다. 데스크톱에서는 Chrome을 평소처럼 설치하고 `happy browser`가 안내하는 링크를 여세요.',
        }
    }
    if (canSudo) {
        return { action: 'run', command: INSTALL_COMMAND }
    }
    return {
        action: 'manual',
        command: INSTALL_COMMAND,
        reason: 'Chrome은 시스템 공유 라이브러리를 필요로 해서 root 없이 설치할 수 없습니다. 이 명령을 서버에서 한 번 실행해 주세요.',
    }
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((resolvePromise) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
        let stdout = ''
        child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
        child.on('error', () => resolvePromise({ code: 1, stdout: '' }))
        child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout: stdout.trim() }))
    })
}

/** First Chrome-family binary on PATH, or null when none is installed. */
export async function detectChrome(): Promise<{ path: string; version: string } | null> {
    for (const binary of CHROME_BINARIES) {
        const found = await run('which', [binary])
        if (found.code !== 0 || !found.stdout) continue
        const version = await run(found.stdout, ['--version'])
        return { path: found.stdout, version: version.stdout || 'unknown' }
    }
    return null
}

/**
 * Whether `sudo` can run without prompting. `-n` makes sudo fail rather than
 * block on a password prompt — a blocked prompt would hang the RPC forever
 * with no way for the user to answer it.
 */
export async function canSudoWithoutPassword(): Promise<boolean> {
    const result = await run('sudo', ['-n', 'true'])
    return result.code === 0
}

/**
 * Starts Chrome detached so it outlives the daemon that spawned it — the
 * whole point is a browser that stays logged in across restarts.
 */
export function launchChrome(chromePath: string, options: ChromeLaunchOptions): { pid: number | undefined } {
    mkdirSync(options.userDataDir, { recursive: true })
    const child = spawn(chromePath, buildChromeLaunchArgs(options), {
        detached: true,
        stdio: 'ignore',
    })
    child.unref()
    return { pid: child.pid }
}

/** Whether something answers CDP on that port — i.e. Chrome is already up. */
export async function isCdpReachable(cdpPort: number): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
            signal: AbortSignal.timeout(1500),
        })
        return response.ok
    } catch {
        return false
    }
}

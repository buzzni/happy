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

import { join, resolve, sep } from 'node:path'

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
export function planChromeInstall({ chromePath, canSudo }: { chromePath: string | null; canSudo: boolean }): ChromeInstallPlan {
    if (chromePath) {
        return { action: 'already-installed' }
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

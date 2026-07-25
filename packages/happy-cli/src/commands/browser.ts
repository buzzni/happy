/**
 * `happy browser` — pairing and status for the Chrome extension bridge
 * (specs/chrome-extension-bridge/).
 *
 * The pairing token lives in a file the user would otherwise have to know to
 * `cat`; this surfaces it along with whether an extension is actually talking
 * to the daemon, which is the question people have when it isn't working.
 */

import chalk from 'chalk'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { configuration } from '@/configuration'
import { readDaemonState } from '@/persistence'
import { projectPath } from '@/projectPath'
import { readOrCreateBrowserBridgeToken } from '@/daemon/browserBridgeToken'
import { DEFAULT_BROWSER_BRIDGE_PORT } from '@/daemon/browserBridgeServer'
import { computeChromeExtensionId } from './browserExtensionId'

/**
 * Where to point the user at the extension's source.
 *
 * An installed happy-cli has the extension bundled alongside it (built by
 * scripts/copy-browser-extension.cjs, shipped via package.json "files") —
 * that's the common case and takes priority. Running from the monorepo
 * source tree (no build step run) has no bundled copy, so fall back to the
 * sibling package. Without this fallback, dev checkouts print a path that
 * doesn't exist — which is exactly the bug that prompted this function.
 */
export function resolveExtensionDir(): string {
    const bundled = path.join(projectPath(), 'browser-extension')
    if (existsSync(path.join(bundled, 'manifest.json'))) return bundled
    return path.join(projectPath(), '..', 'happy-browser-extension')
}

/**
 * manifest.json pins a "key", which fixes the extension's id regardless of
 * which path it was loaded from — that's what lets us build a working
 * chrome-extension://<id>/... link before the extension has ever reported
 * anything back to the daemon.
 */
export function resolveExtensionId(extensionDir: string): string {
    const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')) as { key: string }
    return computeChromeExtensionId(manifest.key)
}

export interface BrowserStatusInput {
    token: string
    extensionDir: string
    extensionId: string
    bridgePort: number
    daemonRunning: boolean
    connections: Array<{ profile: string }>
    /**
     * A connection attempt was rejected recently for a bad token — typically
     * an already-paired extension whose stored token predates the daemon's
     * token file being regenerated. It retries forever and fails silently,
     * so this needs its own message: connections() alone can't tell "never
     * tried" apart from "tried and keeps getting rejected", and a healthy
     * second profile shouldn't hide a broken first one.
     */
    hasRecentAuthFailure: boolean
}

function autoConnectLink(extensionId: string, token: string, bridgePort: number): string {
    return `chrome-extension://${extensionId}/src/options.html?token=${token}&port=${bridgePort}`
}

export function formatBrowserStatus({ token, extensionDir, extensionId, bridgePort, daemonRunning, connections, hasRecentAuthFailure }: BrowserStatusInput): string {
    const lines: string[] = ['', chalk.bold('Happy Browser Bridge'), '']

    if (!daemonRunning) {
        // Everything below depends on the daemon holding the bridge socket
        // open, so lead with this rather than letting the user work through
        // the extension steps and wonder why nothing connects.
        lines.push(chalk.yellow('데몬이 실행 중이 아닙니다. 브라우저 제어는 데몬이 떠 있어야 동작합니다.'))
        lines.push(`  ${chalk.cyan('happy daemon start')}`)
        lines.push('')
    }

    lines.push(`${chalk.bold('Pairing 토큰')}  ${chalk.dim(`(포트 ${bridgePort})`)}`)
    lines.push(`  ${token}`)
    lines.push('')

    if (connections.length > 0) {
        lines.push(chalk.green(`확장 연결됨 — 프로필 ${connections.length}개`))
        for (const connection of connections) {
            lines.push(`  • ${connection.profile}`)
        }
        lines.push('')
        if (hasRecentAuthFailure) {
            lines.push(chalk.yellow('다른 확장이 예전 토큰으로 재연결을 시도하다 거부되고 있습니다.'))
            lines.push('아래 링크를 열어 재연결하세요:')
            lines.push(`  ${chalk.cyan(autoConnectLink(extensionId, token, bridgePort))}`)
            lines.push('')
        }
        return lines.join('\n')
    }

    lines.push(hasRecentAuthFailure
        ? chalk.yellow('확장이 연결을 시도했지만 예전 토큰이라 거부됐습니다. 재연결이 필요합니다.')
        : chalk.yellow('연결된 확장이 없습니다.'))
    lines.push('')
    lines.push(chalk.bold('설치 방법'))
    lines.push(`  1. Chrome에서 ${chalk.cyan('chrome://extensions')} 열기 → 개발자 모드 켜기`)
    lines.push('  2. "압축해제된 확장 프로그램을 로드" → 아래 폴더 선택')
    lines.push(`     ${extensionDir}`)
    lines.push('  3. 확장 옵션 페이지에서 위 토큰을 붙여넣고 저장')
    lines.push(`     (포트는 ${bridgePort}, 기본값 그대로면 수정 불필요)`)
    lines.push('')
    lines.push(chalk.dim('  1번 이후에는 아래 링크를 열면 2, 3번이 자동으로 끝납니다:'))
    lines.push(`  ${chalk.cyan(autoConnectLink(extensionId, token, bridgePort))}`)
    lines.push('')
    lines.push(chalk.dim('  선택: 옵션의 allowlist에 사이트를 적으면 그 사이트에서만 동작합니다.'))
    lines.push(chalk.dim('  비워 두면 모든 탭을 제어할 수 있습니다.'))
    lines.push('')

    return lines.join('\n')
}

async function fetchBridgeStatus(httpPort: number): Promise<{ connections: Array<{ profile: string }>; hasRecentAuthFailure: boolean }> {
    try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/browser/status`, {
            signal: AbortSignal.timeout(2000),
        })
        if (!response.ok) return { connections: [], hasRecentAuthFailure: false }
        const body = await response.json() as { connections?: Array<{ profile: string }>; hasRecentAuthFailure?: boolean }
        return { connections: body.connections ?? [], hasRecentAuthFailure: body.hasRecentAuthFailure ?? false }
    } catch {
        return { connections: [], hasRecentAuthFailure: false }
    }
}

export async function handleBrowserCommand(args: string[]): Promise<void> {
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
        console.log('')
        console.log('  happy browser          브라우저 브리지 상태와 pairing 토큰 표시')
        console.log('  happy browser token    토큰만 출력 (스크립트용)')
        console.log('')
        return
    }

    const token = await readOrCreateBrowserBridgeToken(configuration.browserBridgeTokenFile)

    // Bare token for piping (`happy browser token | pbcopy`) — the decorated
    // status output is unusable for that.
    if (args[0] === 'token') {
        console.log(token)
        return
    }

    const state = await readDaemonState()
    const daemonRunning = Boolean(state?.httpPort)
    const { connections, hasRecentAuthFailure } = daemonRunning
        ? await fetchBridgeStatus(state!.httpPort!)
        : { connections: [], hasRecentAuthFailure: false }

    const extensionDir = resolveExtensionDir()

    console.log(formatBrowserStatus({
        token,
        extensionDir,
        extensionId: resolveExtensionId(extensionDir),
        bridgePort: DEFAULT_BROWSER_BRIDGE_PORT,
        daemonRunning,
        connections,
        hasRecentAuthFailure,
    }))
}

/**
 * `happy browser` — pairing and status for the Chrome extension bridge
 * (specs/chrome-extension-bridge/).
 *
 * The pairing token lives in a file the user would otherwise have to know to
 * `cat`; this surfaces it along with whether an extension is actually talking
 * to the daemon, which is the question people have when it isn't working.
 */

import chalk from 'chalk'
import net from 'node:net'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { configuration } from '@/configuration'
import { readDaemonState } from '@/persistence'
import { projectPath } from '@/projectPath'
import { readOrCreateBrowserBridgeToken } from '@/daemon/browserBridgeToken'
import { fetchBrowserStatus } from '@/daemon/browserClient'
import { DEFAULT_BROWSER_BRIDGE_PORT, resolveBrowserBridgeHost } from '@/daemon/browserBridgeServer'
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
    /**
     * Whether anything is listening on the bridge port, or undefined when it
     * was not probed. Combined with `daemonRunning` it separates two silent
     * failures: another install's daemon owning the bridge (port in use while
     * ours is down — "start the daemon" would be useless, the second one
     * cannot bind), and our daemon having failed to bind it (port free while
     * ours is up — no extension can ever reach it).
     */
    bridgePortInUse?: boolean
    /**
     * What the bridge is actually bound to (resolveBrowserBridgeHost). Absent
     * means "not probed" and is treated as loopback — the safe assumption.
     */
    bridgeHost?: string
    /**
     * The address a remote user's own Chrome should dial — HAPPY_BROWSER_
     * BRIDGE_PUBLIC_HOST. Deliberately separate from bridgeHost: a bind
     * address of 0.0.0.0 says nothing about what a NAT/port-forwarding setup
     * makes reachable from outside, so this has to be given explicitly rather
     * than inferred.
     */
    publicHost?: string
}

function autoConnectLink(extensionId: string, token: string, bridgePort: number, publicHost?: string): string {
    const host = publicHost ? `&host=${encodeURIComponent(publicHost)}` : ''
    return `chrome-extension://${extensionId}/src/options.html?token=${token}&port=${bridgePort}${host}`
}

export function formatBrowserStatus({ token, extensionDir, extensionId, bridgePort, daemonRunning, connections, hasRecentAuthFailure, bridgePortInUse, bridgeHost, publicHost }: BrowserStatusInput): string {
    const lines: string[] = ['', chalk.bold('Happy Browser Bridge'), '']
    // A rejected connection is strong evidence of a stale-token extension
    // only while loopback is the sole way in. Once anyone can reach the port,
    // a passing scanner trips the same flag — and the confident wording would
    // send the user re-pairing something that was never broken.
    const portIsPublic = bridgeHost !== undefined && !['127.0.0.1', '::1', 'localhost'].includes(bridgeHost)

    if (portIsPublic) {
        lines.push(chalk.yellow(`브리지가 ${bridgeHost}에 바인드되어 있습니다 — 이 컴퓨터 밖에서도 닿을 수 있습니다.`))
        lines.push(chalk.dim('  연결은 평문 WebSocket이고 pairing 토큰이 유일한 방어선입니다. 신뢰하는 네트워크에서만 여세요.'))
        lines.push('')
    } else if (publicHost) {
        // The link below will point a remote extension at this machine, but
        // nothing answers beyond loopback — the extension dials into silence
        // and neither side ever shows a cause. This is the one place that can
        // see both halves of the mismatch.
        lines.push(chalk.yellow(`HAPPY_BROWSER_BRIDGE_PUBLIC_HOST(${publicHost})가 설정됐지만 브리지는 loopback만 듣고 있습니다.`))
        lines.push(chalk.dim('  원격 확장은 아래 링크로 접속해도 닿을 수 없습니다. 데몬을 이렇게 다시 시작하세요:'))
        lines.push(`  ${chalk.cyan('HAPPY_BROWSER_BRIDGE_HOST=0.0.0.0 happy daemon start')}`)
        lines.push('')
    }

    if (!daemonRunning && bridgePortInUse === true) {
        lines.push(chalk.yellow(`이 설치의 데몬은 떠 있지 않지만, 다른 happy 설치의 데몬이 브리지 포트 ${bridgePort}을 잡고 있습니다.`))
        lines.push(chalk.dim('  토큰은 머신 공용이라 아래 값이 맞습니다. 다만 그 데몬이 예전 빌드라면 옛 토큰을 검증할 수 있습니다.'))
        lines.push(chalk.dim('  연결이 계속 거부되면 그 데몬을 재시작하세요:'))
        lines.push(`  ${chalk.cyan('happy daemon stop && happy daemon start')}`)
        lines.push('')
    } else if (daemonRunning && bridgePortInUse === false) {
        // The daemon comes up even when the bridge fails to bind (run.ts logs
        // it to debug and moves on), so nothing else tells the user that no
        // extension can ever connect to this daemon.
        lines.push(chalk.yellow(`데몬은 실행 중이지만 브리지 포트 ${bridgePort}를 잡지 못했습니다. 확장은 이 데몬에 연결할 수 없습니다.`))
        lines.push(chalk.dim('  다른 데몬이 먼저 포트를 잡았다가 종료된 경우입니다. 재시작하면 잡습니다:'))
        lines.push(`  ${chalk.cyan('happy daemon stop && happy daemon start')}`)
        lines.push('')
    } else if (!daemonRunning) {
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
            lines.push(chalk.yellow(portIsPublic
                ? '잘못된 토큰으로 연결 시도가 거부됐습니다. 포트가 외부에 열려 있어 당신의 확장이 아닐 수도 있습니다(스캔 등).'
                : '다른 확장이 예전 토큰으로 재연결을 시도하다 거부되고 있습니다.'))
            lines.push('아래 링크를 열어 재연결하세요:')
            lines.push(`  ${chalk.cyan(autoConnectLink(extensionId, token, bridgePort, publicHost))}`)
            lines.push('')
        }
        return lines.join('\n')
    }

    // `connections` comes from *this* install's daemon. If another install
    // owns the bridge we never got to ask anyone, so an empty list is "we
    // don't know", not "nothing is connected".
    if (!daemonRunning && bridgePortInUse === true) {
        lines.push(chalk.yellow('연결 상태는 이 설치에서 확인할 수 없습니다 (브리지를 잡고 있는 데몬의 제어 포트를 모릅니다).'))
    } else {
        if (!hasRecentAuthFailure) {
            lines.push(chalk.yellow('연결된 확장이 없습니다.'))
        } else {
            lines.push(chalk.yellow(portIsPublic
                ? '연결된 확장이 없고, 잘못된 토큰으로 거부된 시도가 있었습니다. 포트가 외부에 열려 있어 당신의 확장이 아닐 수도 있습니다(스캔 등).'
                : '확장이 연결을 시도했지만 예전 토큰이라 거부됐습니다. 재연결이 필요합니다.'))
        }
    }
    lines.push('')
    lines.push(chalk.bold('설치 방법'))
    lines.push(`  1. Chrome에서 ${chalk.cyan('chrome://extensions')} 열기 → 개발자 모드 켜기`)
    lines.push('  2. "압축해제된 확장 프로그램을 로드" → 아래 폴더 선택')
    lines.push(`     ${extensionDir}`)
    lines.push('  3. 확장 옵션 페이지에서 위 토큰을 붙여넣고 저장')
    lines.push(`     (포트는 ${bridgePort}, 기본값 그대로면 수정 불필요)`)
    lines.push('')
    lines.push(chalk.dim('  1번 이후에는 아래 링크를 열면 2, 3번이 자동으로 끝납니다:'))
    lines.push(`  ${chalk.cyan(autoConnectLink(extensionId, token, bridgePort, publicHost))}`)
    lines.push('')
    lines.push(chalk.dim('  GUI가 없는 머신(SSH 전용 Linux)이라면 링크를 열 방법이 없습니다. 대신:'))
    lines.push(`  ${chalk.cyan('happy browser pair')}  ${chalk.dim('— docs/browser-bridge-headless.md')}`)
    lines.push('')
    lines.push(chalk.dim('  선택: 옵션의 allowlist에 사이트를 적으면 그 사이트에서만 동작합니다.'))
    lines.push(chalk.dim('  비워 두면 모든 탭을 제어할 수 있습니다.'))
    lines.push('')

    return lines.join('\n')
}

/**
 * Is anything holding the bridge port? Answers the "my daemon isn't running
 * but the bridge is" case (a daemon under a different HAPPY_HOME_DIR), which
 * the state file alone cannot see.
 */
/**
 * Where to knock to see whether the bridge is up.
 *
 * A wildcard bind covers loopback, so 127.0.0.1 is both valid and the safest
 * destination (connecting *to* 0.0.0.0 is platform-dependent). Anything else
 * is a specific interface that loopback does not reach — probing 127.0.0.1
 * there reports "no bridge" for a bridge that is running fine, which
 * formatBrowserStatus then turns into a restart instruction that cannot help.
 */
export function bridgeProbeHost(bridgeHost: string): string {
    return bridgeHost === '0.0.0.0' || bridgeHost === '::' ? '127.0.0.1' : bridgeHost
}

function isBridgePortInUse(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port })
        const finish = (inUse: boolean) => {
            socket.destroy()
            resolve(inUse)
        }
        socket.setTimeout(500)
        socket.once('connect', () => finish(true))
        socket.once('timeout', () => finish(false))
        socket.once('error', () => finish(false))
    })
}

export async function handleBrowserCommand(args: string[]): Promise<void> {
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
        console.log('')
        console.log('  happy browser          브라우저 브리지 상태와 pairing 토큰 표시')
        console.log('  happy browser token    토큰만 출력 (스크립트용)')
        console.log('  happy browser pair     GUI 없이 페어링 (터미널 전용 머신)')
        console.log('')
        console.log('  pair 옵션:')
        console.log('    --cdp-port <n>       Chrome --remote-debugging-port (기본 9222)')
        console.log('    --debugger           정밀 제어(디버거)도 함께 켬')
        console.log('    --no-debugger        정밀 제어를 끔')
        console.log('')
        return
    }

    // Pairing without a GUI is a different job to reporting status, so it
    // lives in its own module. Imported dynamically because browserPair.ts
    // reuses resolveExtensionDir/resolveExtensionId from this file — a static
    // import both ways is a cycle.
    if (args[0] === 'pair') {
        const { handlePairCommand } = await import('./browserPair')
        try {
            await handlePairCommand(args.slice(1))
        } catch (e) {
            console.log('')
            console.log(chalk.red(e instanceof Error ? e.message : String(e)))
            console.log('')
            process.exitCode = 1
        }
        return
    }

    const token = await readOrCreateBrowserBridgeToken(configuration.browserBridgeTokenFile, {
        migrateFrom: configuration.legacyBrowserBridgeTokenFile,
    })

    // Bare token for piping (`happy browser token | pbcopy`) — the decorated
    // status output is unusable for that.
    if (args[0] === 'token') {
        console.log(token)
        return
    }

    const state = await readDaemonState()
    const daemonRunning = Boolean(state?.httpPort && state?.controlSecret)
    const { connections, hasRecentAuthFailure } = (daemonRunning
        ? await fetchBrowserStatus(state!.httpPort!, state!.controlSecret!)
        : null) ?? { connections: [], hasRecentAuthFailure: false }

    const extensionDir = resolveExtensionDir()
    // Best-effort: reflects this process's own env, which is only the live
    // daemon's actual bind host when nothing has changed it since `happy
    // daemon start` ran. Good enough to warn — not authoritative.
    const bridgeHost = resolveBrowserBridgeHost(process.env)

    console.log(formatBrowserStatus({
        token,
        extensionDir,
        extensionId: resolveExtensionId(extensionDir),
        bridgePort: DEFAULT_BROWSER_BRIDGE_PORT,
        daemonRunning,
        connections,
        hasRecentAuthFailure,
        bridgePortInUse: await isBridgePortInUse(DEFAULT_BROWSER_BRIDGE_PORT, bridgeProbeHost(bridgeHost)),
        bridgeHost,
        publicHost: process.env.HAPPY_BROWSER_BRIDGE_PUBLIC_HOST?.trim() || undefined,
    }))
}

/**
 * `happy browser pair` — finish pairing without a GUI.
 *
 * On a desktop the flow is "open the link `happy browser` printed". On a
 * terminal-only Linux box nobody can click anything, so this drives Chrome's
 * own CDP endpoint to open that same link. options.js saves the token on load
 * (parseAutoConnectParams), so opening the page IS the pairing.
 *
 * Deliberately does not launch or install Chrome — that stays the operator's
 * job (docs/browser-bridge-headless.md). This command's only value is turning
 * three failure modes that all look like "it just doesn't connect" into three
 * different messages.
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readDaemonState } from '@/persistence'
import { readOrCreateBrowserBridgeToken } from '@/daemon/browserBridgeToken'
import { fetchBrowserStatus } from '@/daemon/browserClient'
import { DEFAULT_BROWSER_BRIDGE_PORT } from '@/daemon/browserBridgeServer'
import { resolveExtensionDir, resolveExtensionId } from './browser'

/** Chrome's conventional `--remote-debugging-port`. */
export const DEFAULT_CDP_PORT = 9222

export interface PairOptions {
    cdpPort: number
    /** Absent means "leave whatever the profile already has". */
    debuggerTier?: boolean
}

export function parsePairArgs(args: string[]): PairOptions {
    const options: PairOptions = { cdpPort: DEFAULT_CDP_PORT }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--debugger') {
            options.debuggerTier = true
        } else if (arg === '--no-debugger') {
            options.debuggerTier = false
        } else if (arg === '--cdp-port' || arg.startsWith('--cdp-port=')) {
            const raw = arg.startsWith('--cdp-port=') ? arg.slice('--cdp-port='.length) : args[++i]
            const port = Number(raw)
            if (!Number.isInteger(port) || port <= 0 || port > 65535) {
                throw new Error(`--cdp-port needs a port number, got: ${raw ?? '(nothing)'}`)
            }
            options.cdpPort = port
        } else {
            // Silently ignoring a typo would leave the user believing the flag
            // took effect — the whole point of --debugger is that they cannot
            // check the toggle themselves on a headless box.
            throw new Error(`Unknown option: ${arg}`)
        }
    }
    return options
}

export function buildPairUrl({ extensionId, token, bridgePort, debuggerTier }: {
    extensionId: string
    token: string
    bridgePort: number
    debuggerTier?: boolean
}): string {
    const params = new URLSearchParams({ token, port: String(bridgePort) })
    if (debuggerTier !== undefined) params.set('debugger', debuggerTier ? '1' : '0')
    return `chrome-extension://${extensionId}/src/options.html?${params.toString()}`
}

export interface PairOutcomeInput {
    cdpPort: number
    extensionDir: string
    daemonRunning: boolean
    /** Chrome answered on the debugging port. */
    cdpReachable: boolean
    /** A target belonging to our extension id was visible before we opened the page. */
    extensionLoaded: boolean
    connections: Array<{ profile: string }>
}

export function formatPairOutcome({ cdpPort, extensionDir, daemonRunning, cdpReachable, extensionLoaded, connections }: PairOutcomeInput): { ok: boolean; text: string } {
    // Ordered by what has to be true first: a later check failing while an
    // earlier prerequisite is missing would point at the wrong thing.
    if (!daemonRunning) {
        return {
            ok: false,
            text: [
                chalk.yellow('데몬이 실행 중이 아닙니다. 브리지 포트를 잡는 주체가 없습니다.'),
                `  ${chalk.cyan('happy daemon start')}`,
            ].join('\n'),
        }
    }

    if (!cdpReachable) {
        return {
            ok: false,
            text: [
                chalk.yellow(`Chrome이 디버깅 포트 ${cdpPort}에서 응답하지 않습니다.`),
                chalk.dim('  Chrome을 아래처럼 띄운 뒤 다시 실행하세요:'),
                `  ${chalk.cyan(`google-chrome --remote-debugging-port=${cdpPort} --user-data-dir=~/.happy-chrome \\`)}`,
                `  ${chalk.cyan(`    --disable-extensions-except=${extensionDir} --load-extension=${extensionDir}`)}`,
            ].join('\n'),
        }
    }

    if (connections.length > 0) {
        return {
            ok: true,
            text: [
                chalk.green(`페어링 완료 — 프로필 ${connections.length}개 연결됨`),
                ...connections.map((connection) => `  • ${connection.profile}`),
            ].join('\n'),
        }
    }

    if (!extensionLoaded) {
        return {
            ok: false,
            text: [
                chalk.yellow('Chrome은 응답하지만 확장이 로드되어 있지 않습니다.'),
                chalk.dim('  두 플래그는 짝으로 써야 합니다 — --load-extension만으로는 무시됩니다:'),
                `  ${chalk.cyan(`--disable-extensions-except=${extensionDir} --load-extension=${extensionDir}`)}`,
                chalk.dim('  구형 --headless는 확장을 지원하지 않습니다. --headless=new 또는 Xvfb를 쓰세요.'),
            ].join('\n'),
        }
    }

    return {
        ok: false,
        text: [
            chalk.yellow('옵션 페이지는 열었지만 확장이 데몬에 연결되지 않았습니다.'),
            chalk.dim('  확장은 붙어 있으므로 토큰이나 브리지 포트가 어긋난 경우입니다.'),
            `  ${chalk.cyan('happy browser')} 로 데몬이 검증 중인 토큰을 확인하세요.`,
        ].join('\n'),
    }
}

async function fetchCdpTargets(cdpPort: number): Promise<Array<{ url?: string }> | null> {
    try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2_000) })
        if (!response.ok) return null
        return await response.json() as Array<{ url?: string }>
    } catch {
        return null
    }
}

/**
 * Ask Chrome to open the pairing page.
 *
 * Chrome 111+ requires PUT on /json/new and answers older-style GETs with 405;
 * older builds only accept GET. Try both rather than pinning a Chrome version.
 */
async function openTab(cdpPort: number, url: string): Promise<boolean> {
    const endpoint = `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`
    for (const method of ['PUT', 'GET'] as const) {
        try {
            const response = await fetch(endpoint, { method, signal: AbortSignal.timeout(5_000) })
            if (response.ok) return true
        } catch {
            // Try the other verb before giving up.
        }
    }
    return false
}

/** The extension's own targets (service worker, options page) carry its id. */
function hasExtensionTarget(targets: Array<{ url?: string }> | null, extensionId: string): boolean {
    return (targets ?? []).some((target) => target.url?.startsWith(`chrome-extension://${extensionId}/`) === true)
}

/**
 * The extension reconnects on a storage change, so the socket lands shortly
 * after the page saves — poll rather than answering before it could have.
 */
async function waitForConnection(controlPort: number, timeoutMs: number): Promise<Array<{ profile: string }>> {
    const deadline = Date.now() + timeoutMs
    let connections: Array<{ profile: string }> = []
    while (Date.now() < deadline) {
        connections = (await fetchBrowserStatus(controlPort))?.connections ?? []
        if (connections.length > 0) return connections
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return connections
}

export async function handlePairCommand(args: string[]): Promise<void> {
    const options = parsePairArgs(args)

    const token = await readOrCreateBrowserBridgeToken(configuration.browserBridgeTokenFile, {
        migrateFrom: configuration.legacyBrowserBridgeTokenFile,
    })
    const extensionDir = resolveExtensionDir()
    const extensionId = resolveExtensionId(extensionDir)
    const state = await readDaemonState()
    const controlPort = state?.httpPort

    // Checked before opening anything: once the options page is open it has a
    // chrome-extension:// target of its own, so "is the extension loaded"
    // becomes unanswerable from the target list.
    const targetsBefore = await fetchCdpTargets(options.cdpPort)
    const cdpReachable = targetsBefore !== null
    const extensionLoaded = hasExtensionTarget(targetsBefore, extensionId)

    let connections: Array<{ profile: string }> = []
    if (controlPort && cdpReachable) {
        await openTab(options.cdpPort, buildPairUrl({
            extensionId,
            token,
            bridgePort: DEFAULT_BROWSER_BRIDGE_PORT,
            debuggerTier: options.debuggerTier,
        }))
        connections = await waitForConnection(controlPort, 10_000)
    }

    const outcome = formatPairOutcome({
        cdpPort: options.cdpPort,
        extensionDir,
        daemonRunning: Boolean(controlPort),
        cdpReachable,
        extensionLoaded,
        connections,
    })
    console.log('')
    console.log(outcome.text)
    console.log('')
    if (!outcome.ok) process.exitCode = 1
}

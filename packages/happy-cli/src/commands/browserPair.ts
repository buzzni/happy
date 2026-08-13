/**
 * `happy browser pair` — finish pairing without a GUI.
 *
 * On a desktop the flow is "open the link `happy browser` printed". On a
 * terminal-only Linux box nobody can click anything, so this drives Chrome's
 * own CDP endpoint to open that same link. options.js saves the token on load
 * (parseAutoConnectParams), so opening the page IS the pairing.
 *
 * Deliberately does not launch or install Chrome — that stays the operator's
 * job (docs/browser-bridge-headless.md). This command's only value is telling
 * apart the failures that all present as "it just doesn't connect": no daemon,
 * no CDP, CDP but no /json/new, extension never loaded, loaded but no socket,
 * and connected but the requested tier never applied.
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readDaemonState } from '@/persistence'
import { readOrCreateBrowserBridgeToken } from '@/daemon/browserBridgeToken'
import { fetchBrowserStatus, requestBrowser } from '@/daemon/browserClient'
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
    /** Chrome accepted /json/new for the pairing URL. */
    pageOpened: boolean
    connections: Array<{ profile: string }>
    /** Profiles among `connections` that were NOT connected before the page opened. */
    freshProfiles: string[]
    /** What --debugger/--no-debugger asked for; absent when neither was given. */
    debuggerTierRequested?: boolean
    /** What the extension reports now. Absent when it could not be read. */
    debuggerTierActual?: boolean
}

export function formatPairOutcome({ cdpPort, extensionDir, daemonRunning, cdpReachable, extensionLoaded, pageOpened, connections, freshProfiles, debuggerTierRequested, debuggerTierActual }: PairOutcomeInput): { ok: boolean; text: string } {
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

    if (!pageOpened) {
        return {
            ok: false,
            text: [
                chalk.yellow(`Chrome은 응답하지만 페어링 페이지를 열지 못했습니다 (/json/new 거부).`),
                chalk.dim('  --remote-debugging-address가 127.0.0.1이 아니거나, 다른 도구가'),
                chalk.dim('  같은 포트의 CDP 세션을 독점하고 있는 경우입니다.'),
            ].join('\n'),
        }
    }

    // A connection alone is not success: a profile that was already paired
    // before this run proves nothing about the Chrome we just drove. It only
    // counts when something new connected, or when the CDP Chrome at least
    // has the extension (then an unchanged connection reads as a re-pair).
    if (connections.length > 0 && (freshProfiles.length > 0 || extensionLoaded)) {
        // The connection poll can complete before the options page has loaded
        // — so a requested tier change has to be confirmed, not assumed.
        if (debuggerTierRequested !== undefined && debuggerTierActual !== debuggerTierRequested) {
            return {
                ok: false,
                text: [
                    chalk.yellow(`연결은 됐지만 정밀 제어가 요청한 상태(${debuggerTierRequested ? '켬' : '끔'})로 바뀌지 않았습니다.`),
                    chalk.dim(debuggerTierActual === undefined
                        ? '  상태를 확인하지 못했습니다 — 확장이 응답하지 않았거나, 프로필이 여럿 연결되어 어느 쪽에 적용됐는지 특정할 수 없습니다.'
                        : `  현재 상태: ${debuggerTierActual ? '켬' : '끔'}. 옵션 페이지가 아직 로드 중일 수 있습니다.`),
                    `  ${chalk.cyan('happy browser pair --debugger')} 를 다시 실행하세요.`,
                ].join('\n'),
            }
        }
        const tierLine = debuggerTierRequested === undefined
            ? []
            : [chalk.dim(`  정밀 제어: ${debuggerTierRequested ? '켬' : '끔'}`)]
        if (freshProfiles.length > 0) {
            const bystanders = connections.filter((connection) => !freshProfiles.includes(connection.profile))
            return {
                ok: true,
                text: [
                    chalk.green(`페어링 완료 — 새로 연결된 프로필: ${freshProfiles.join(', ')}`),
                    ...(bystanders.length > 0
                        ? [chalk.dim(`  기존 연결 유지: ${bystanders.map((connection) => connection.profile).join(', ')}`)]
                        : []),
                    ...tierLine,
                ].join('\n'),
            }
        }
        // Nothing new arrived, but the CDP Chrome does have the extension:
        // the honest description is "already connected", not a pairing this
        // run performed.
        return {
            ok: true,
            text: [
                chalk.green(`이미 연결되어 있습니다 — 이번 실행으로 새로 연결된 프로필은 없습니다.`),
                ...connections.map((connection) => `  • ${connection.profile}`),
                ...tierLine,
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
 *
 * Waits for a profile that was not connected before the page opened, not
 * merely for a nonempty list: a bystander profile paired long ago satisfies
 * the latter instantly, before the target Chrome could possibly have saved
 * the token. A re-pair produces no new profile and so runs out the clock —
 * accepted, since answering early would make the bystander case a false
 * success and this is a one-shot diagnostic command.
 */
async function waitForConnection(controlPort: number, timeoutMs: number, profilesBefore: string[]): Promise<Array<{ profile: string }>> {
    const deadline = Date.now() + timeoutMs
    let connections: Array<{ profile: string }> = []
    while (Date.now() < deadline) {
        connections = (await fetchBrowserStatus(controlPort))?.connections ?? []
        if (connections.some((connection) => !profilesBefore.includes(connection.profile))) return connections
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return connections
}

/**
 * Which connected profile the tier probe should ask.
 *
 * The daemon refuses a profile-less request when several profiles are
 * connected (AMBIGUOUS_PROFILE, browserBridge.ts), so the probe must name
 * one. The profile that appeared after we opened the page is the one whose
 * storage the page wrote; on a re-pair nothing new appears, but a single
 * connection can only be the target. With several connections and no new
 * arrival there is no way to tell which one the page belongs to — return
 * undefined so the caller skips the probe instead of asking a wrong profile.
 */
export function pickTierProbeProfile(profilesBefore: string[], connections: Array<{ profile: string }>): string | undefined {
    const before = new Set(profilesBefore)
    const fresh = connections.filter((connection) => !before.has(connection.profile))
    if (fresh.length === 1) return fresh[0].profile
    if (connections.length === 1) return connections[0].profile
    return undefined
}

/**
 * Read back what the extension actually stored, via the `capabilities`
 * command it already answers.
 *
 * Necessary because the connection poll can return before the options page
 * has loaded — an already-paired profile is connected the whole time — so
 * "connected" is not evidence that `--debugger` took effect.
 */
async function waitForDebuggerTier(controlPort: number, expected: boolean, profile: string): Promise<boolean | undefined> {
    const deadline = Date.now() + 5_000
    let actual: boolean | undefined
    while (Date.now() < deadline) {
        try {
            const capabilities = await requestBrowser({ port: controlPort, method: 'capabilities', timeoutMs: 3_000, profile }) as { debugger?: boolean }
            actual = capabilities?.debugger
            if (actual === expected) return actual
        } catch {
            // Mid-reconnect the daemon has no socket to relay to. Keep the
            // last reading and retry until the deadline.
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return actual
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

    let pageOpened = false
    let connections: Array<{ profile: string }> = []
    let debuggerTierActual: boolean | undefined
    let freshProfiles: string[] = []
    if (controlPort && cdpReachable) {
        // Snapshotted before the page opens so a newly-arrived profile can be
        // told apart from ones that were already there — both the success
        // verdict and the tier probe depend on that distinction.
        const profilesBefore = ((await fetchBrowserStatus(controlPort))?.connections ?? []).map((connection) => connection.profile)
        pageOpened = await openTab(options.cdpPort, buildPairUrl({
            extensionId,
            token,
            bridgePort: DEFAULT_BROWSER_BRIDGE_PORT,
            debuggerTier: options.debuggerTier,
        }))
        if (pageOpened) {
            connections = await waitForConnection(controlPort, 10_000, profilesBefore)
            freshProfiles = connections
                .map((connection) => connection.profile)
                .filter((profile) => !profilesBefore.includes(profile))
            if (connections.length > 0 && options.debuggerTier !== undefined) {
                const target = pickTierProbeProfile(profilesBefore, connections)
                if (target !== undefined) {
                    debuggerTierActual = await waitForDebuggerTier(controlPort, options.debuggerTier, target)
                }
            }
        }
    }

    const outcome = formatPairOutcome({
        cdpPort: options.cdpPort,
        extensionDir,
        daemonRunning: Boolean(controlPort),
        cdpReachable,
        extensionLoaded,
        pageOpened,
        connections,
        freshProfiles,
        debuggerTierRequested: options.debuggerTier,
        debuggerTierActual,
    })
    console.log('')
    console.log(outcome.text)
    console.log('')
    if (!outcome.ok) process.exitCode = 1
}

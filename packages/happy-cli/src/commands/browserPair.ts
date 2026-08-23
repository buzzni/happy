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
import { WebSocket } from 'ws'
import { configuration } from '@/configuration'
import { readDaemonState } from '@/persistence'
import { readOrCreateBrowserBridgeToken } from '@/daemon/browserBridgeToken'
import { fetchBrowserStatus, requestBrowser } from '@/daemon/browserClient'
import { DEFAULT_BROWSER_BRIDGE_PORT, resolveBrowserBridgeHost } from '@/daemon/browserBridgeServer'
import { resolveExtensionDir, resolveExtensionId, bridgeProbeHost } from './browser'

/** Chrome's conventional `--remote-debugging-port`. */
export const DEFAULT_CDP_PORT = 9222

export interface PairOptions {
    cdpPort: number
    /** Absent means "leave whatever the profile already has". */
    debuggerTier?: boolean
    /** Opaque per-run marker used to prove which Chrome loaded the link. */
    pairingId?: string
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

export function buildPairUrl({ extensionId, token, bridgePort, debuggerTier, pairingId, bridgeHost = '127.0.0.1' }: {
    extensionId: string
    token: string
    bridgePort: number
    debuggerTier?: boolean
    pairingId?: string
    /** What the daemon's bridge is bound to (resolveBrowserBridgeHost). */
    bridgeHost?: string
}): string {
    // host is pinned, not left to whatever the profile already had: pair
    // drives a Chrome on this machine against this machine's daemon, so a
    // remote host left over from an earlier pairing would send the extension
    // somewhere else and make this run fail with no visible cause.
    //
    // Pinned to where the daemon actually answers, though — loopback for a
    // loopback or wildcard bind, but the interface's own address for a
    // single-interface bind, where nothing listens on 127.0.0.1 and the
    // failure used to get blamed on the token.
    const params = new URLSearchParams({ token, port: String(bridgePort), host: bridgeProbeHost(bridgeHost) })
    if (debuggerTier !== undefined) params.set('debugger', debuggerTier ? '1' : '0')
    if (pairingId !== undefined) params.set('pairingId', pairingId)
    return `chrome-extension://${extensionId}/src/options.html?${params.toString()}`
}

export interface PairOutcomeInput {
    cdpPort: number
    extensionDir: string
    daemonRunning: boolean
    /** Chrome answered on the debugging port. */
    cdpReachable: boolean
    /**
     * The extension is believed present — either its target was already
     * visible, or this run loaded it over CDP.
     */
    extensionLoaded: boolean
    /** The CDP load attempt was made and Chrome refused it. */
    loadUnpackedFailed?: boolean
    /** Chrome accepted /json/new for the pairing URL. */
    pageOpened: boolean
    connections: Array<{ profile: string; pairingId?: string }>
    /** Profiles among `connections` that were NOT connected before the page opened. */
    freshProfiles: string[]
    /** Exact opaque marker assigned by this pairing run, when one was pinned. */
    targetPairingId?: string
    /** What --debugger/--no-debugger asked for; absent when neither was given. */
    debuggerTierRequested?: boolean
    /** What the extension reports now. Absent when it could not be read. */
    debuggerTierActual?: boolean
    /**
     * The daemon rejected a connection for a bad token recently. Separates
     * "the extension reached the bridge and was turned away" from "it never
     * arrived at all" — two failures with different remedies that would
     * otherwise both be reported as a guess.
     */
    authRejected?: boolean
}

export function formatPairOutcome({ cdpPort, extensionDir, daemonRunning, cdpReachable, extensionLoaded, loadUnpackedFailed, pageOpened, connections, freshProfiles, targetPairingId, debuggerTierRequested, debuggerTierActual, authRejected }: PairOutcomeInput): { ok: boolean; text: string } {
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
                chalk.dim('  Chrome을 아래처럼 띄운 뒤 다시 실행하세요 (확장은 이 명령이 직접 넣습니다):'),
                `  ${chalk.cyan(`google-chrome --headless=new --remote-debugging-port=${cdpPort} \\`)}`,
                `  ${chalk.cyan('    --user-data-dir=~/.happy-chrome --enable-unsafe-extension-debugging')}`,
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

    const targetConnected = targetPairingId === undefined
        || connections.some((connection) => connection.pairingId === targetPairingId)
    if (!targetConnected && extensionLoaded) {
        return {
            ok: false,
            text: [
                chalk.yellow(`대상 Chrome 페어링(${targetPairingId})이 브리지에 연결되지 않았습니다.`),
                chalk.dim(connections.length === 0
                    ? '  현재 연결된 프로필이 없습니다.'
                    : `  현재 연결: ${connections.map((connection) => connection.profile).join(', ')}`),
                ...(loadUnpackedFailed
                    ? [
                        chalk.dim('  현재 CLI의 확장 번들로 갱신하지 못했습니다. Chrome을 아래 플래그로 다시 띄우세요:'),
                        `  ${chalk.cyan('--enable-unsafe-extension-debugging')}`,
                    ]
                    : []),
            ].join('\n'),
        }
    }

    // A connection alone is not success: a profile that was already paired
    // before this run proves nothing about the Chrome we just drove. It only
    // counts when something new connected, or when the CDP Chrome at least
    // has the extension (then an unchanged connection reads as a re-pair).
    if (targetConnected && connections.length > 0 && (freshProfiles.length > 0 || extensionLoaded)) {
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
                chalk.yellow('확장을 Chrome에 넣지 못했습니다.'),
                chalk.dim('  Chrome 137부터 --load-extension은 무시되므로 이 명령은 CDP로 확장을 넣습니다.'),
                chalk.dim('  그 호출은 아래 플래그로 띄운 Chrome에서만 허용됩니다:'),
                `  ${chalk.cyan('--enable-unsafe-extension-debugging')}`,
                chalk.dim(`  확장 경로: ${extensionDir}`),
                chalk.dim('  구형 --headless는 확장을 지원하지 않습니다. --headless=new 또는 Xvfb를 쓰세요.'),
            ].join('\n'),
        }
    }

    // The daemon reports whether it turned a connection away, so this does
    // not have to guess between the two remaining causes.
    if (authRejected) {
        return {
            ok: false,
            text: [
                chalk.yellow('확장이 브리지에 닿았지만 토큰이 거부됐습니다.'),
                chalk.dim('  방금 저장한 토큰과 데몬이 검증하는 토큰이 다릅니다 — 보통 다른 happy'),
                chalk.dim('  설치(HAPPY_HOME_DIR이 다른 데몬)가 이 포트를 잡고 있는 경우입니다.'),
                `  ${chalk.cyan('happy browser')} 로 어느 데몬이 브리지를 쥐고 있는지 확인하세요.`,
            ].join('\n'),
        }
    }

    return {
        ok: false,
        text: [
            chalk.yellow('옵션 페이지는 열었지만 확장이 브리지에 닿지 못했습니다.'),
            chalk.dim('  거부된 시도가 없으므로 확장이 아예 도달하지 못한 것입니다 — 저장된'),
            chalk.dim('  데몬 주소/포트가 이 데몬과 다르거나, 옵션 페이지가 저장에 실패했습니다.'),
            `  ${chalk.cyan('happy browser')} 로 브리지 포트와 상태를 확인하세요.`,
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

/** Marker pairing requires the bundle that understands that marker. */
export function shouldLoadUnpackedExtension(extensionLoaded: boolean, pairingId?: string): boolean {
    return !extensionLoaded || pairingId !== undefined
}

export function extensionAvailableAfterLoad(previouslyLoaded: boolean, loadedNow: boolean): boolean {
    return previouslyLoaded || loadedNow
}

/**
 * Install the extension into the running Chrome over CDP.
 *
 * Chrome 137 stopped honouring `--load-extension` (verified on Chrome 151:
 * even a minimal probe extension does not load, and neither
 * `--enable-unsafe-extension-debugging` nor
 * `--disable-features=DisableLoadExtensionCommandLineSwitch` revives it), so
 * a terminal-only machine has no command line that gets the extension in.
 * `Extensions.loadUnpacked` does, and Chrome allows it only when started with
 * `--enable-unsafe-extension-debugging`.
 *
 * Verified that the extension outlives this CDP session — it stays loaded and
 * connected after the socket closes, which is what makes loading it from a
 * one-shot command worth doing at all.
 */
async function loadUnpackedExtension(cdpPort: number, extensionDir: string): Promise<boolean> {
    let browserSocketUrl: string
    try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2_000) })
        const body = await response.json() as { webSocketDebuggerUrl?: string }
        if (!body.webSocketDebuggerUrl) return false
        browserSocketUrl = body.webSocketDebuggerUrl
    } catch {
        return false
    }

    return new Promise<boolean>((resolve) => {
        const socket = new WebSocket(browserSocketUrl)
        const finish = (loaded: boolean) => {
            clearTimeout(timer)
            socket.close()
            resolve(loaded)
        }
        const timer = setTimeout(() => finish(false), 10_000)
        socket.on('open', () => {
            socket.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: extensionDir } }))
        })
        socket.on('message', (raw) => {
            try {
                const message = JSON.parse(raw.toString()) as { id?: number; result?: { id?: string }; error?: unknown }
                if (message.id === 1) finish(typeof message.result?.id === 'string')
            } catch {
                // Not our reply; keep waiting for one that parses.
            }
        })
        socket.on('error', () => finish(false))
        socket.on('close', () => finish(false))
    })
}

/**
 * The extension reconnects on a storage change, so the socket lands shortly
 * after the page saves — poll rather than answering before it could have.
 *
 * With an opaque target marker, only that exact reconnect ends the wait. The
 * ordinary CLI path has no marker, so it retains the older fallback of waiting
 * for a profile that was not connected before the page opened. In both cases
 * a pre-existing or newly arriving bystander must not prove target success.
 */
export function pairingConnectionArrived(
    connections: Array<{ profile: string; pairingId?: string }>,
    profilesBefore: string[],
    targetPairingId?: string,
): boolean {
    if (targetPairingId !== undefined) {
        return connections.some((connection) => connection.pairingId === targetPairingId)
    }
    return connections.some((connection) => !profilesBefore.includes(connection.profile))
}

async function waitForConnection(controlPort: number, timeoutMs: number, profilesBefore: string[], targetPairingId?: string): Promise<{ connections: Array<{ profile: string; pairingId?: string }>; authRejected: boolean }> {
    const deadline = Date.now() + timeoutMs
    let connections: Array<{ profile: string; pairingId?: string }> = []
    // Sticky: the daemon's flag expires on its own window, and a rejection
    // seen at any point during the wait is the explanation for the failure
    // even if a later poll no longer reports it.
    let authRejected = false
    while (Date.now() < deadline) {
        const status = await fetchBrowserStatus(controlPort)
        connections = status?.connections ?? []
        authRejected ||= status?.hasRecentAuthFailure === true
        if (pairingConnectionArrived(connections, profilesBefore, targetPairingId)) break
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { connections, authRejected }
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

/**
 * Everything `happy browser pair` does except deciding how to say it.
 *
 * Extracted so callers that are not a terminal — the app's pairing button,
 * which needs the facts as data rather than as text on stdout — reuse this
 * exact sequence instead of reimplementing it. See specs/browser-setup-gui/.
 */
export async function runPairing(options: PairOptions): Promise<PairOutcomeInput> {
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
    let extensionLoaded = hasExtensionTarget(targetsBefore, extensionId)

    // A dormant MV3 service worker shows no target, so "not seen" does not
    // prove "not installed" — loading again is harmless (Chrome reloads it)
    // and is the only way in on a machine with no GUI.
    let loadUnpackedFailed = false
    if (cdpReachable && shouldLoadUnpackedExtension(extensionLoaded, options.pairingId)) {
        const previouslyLoaded = extensionLoaded
        const loadedNow = await loadUnpackedExtension(options.cdpPort, extensionDir)
        loadUnpackedFailed = !loadedNow
        extensionLoaded = extensionAvailableAfterLoad(previouslyLoaded, loadedNow)
    }

    let pageOpened = false
    let connections: Array<{ profile: string; pairingId?: string }> = []
    let debuggerTierActual: boolean | undefined
    let freshProfiles: string[] = []
    let authRejected = false
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
            pairingId: options.pairingId,
            // Best-effort like `happy browser`: this process's env, which
            // matches the daemon's bind only if nothing changed it since the
            // daemon started.
            bridgeHost: resolveBrowserBridgeHost(process.env),
        }))
        if (pageOpened) {
            const waited = await waitForConnection(controlPort, 10_000, profilesBefore, options.pairingId)
            connections = waited.connections
            authRejected = waited.authRejected
            freshProfiles = connections
                .map((connection) => connection.profile)
                .filter((profile) => !profilesBefore.includes(profile))
            if (connections.length > 0 && options.debuggerTier !== undefined) {
                const target = options.pairingId === undefined
                    ? pickTierProbeProfile(profilesBefore, connections)
                    : connections.find((connection) => connection.pairingId === options.pairingId)?.profile
                if (target !== undefined) {
                    debuggerTierActual = await waitForDebuggerTier(controlPort, options.debuggerTier, target)
                }
            }
        }
    }

    return {
        cdpPort: options.cdpPort,
        extensionDir,
        daemonRunning: Boolean(controlPort),
        cdpReachable,
        extensionLoaded,
        loadUnpackedFailed,
        pageOpened,
        connections,
        freshProfiles,
        targetPairingId: options.pairingId,
        debuggerTierRequested: options.debuggerTier,
        debuggerTierActual,
        authRejected,
    }
}

export async function handlePairCommand(args: string[]): Promise<void> {
    const outcome = formatPairOutcome(await runPairing(parsePairArgs(args)))
    console.log('')
    console.log(outcome.text)
    console.log('')
    if (!outcome.ok) process.exitCode = 1
}

/**
 * Independent Mac egress fence for the dedicated browser account.
 *
 * pf drops every TCP/UDP socket the browser account opens except the loopback
 * SOCKS port of the service-owned egress proxy. The fence lives in the kernel,
 * so it survives a detached DevTools session, a lost CDP pipe or a crashed
 * Driver — exactly the cases where Fetch interception fails open.
 *
 * pf `user` matches only TCP/UDP sockets, and on macOS 26.5 it never matched
 * loopback traffic (live evidence E125: four rule shapes, zero matched packets,
 * the fenced uid connected to local listeners). So this fence covers direct
 * external TCP/UDP only. Loopback exposure, mDNSResponder resolution and ICMP
 * are NOT covered; the lo0 pass rule below is harmless but does not by itself
 * authorise the proxy. They stay release blockers until a separate control exists.
 */

/** Sub-anchor of the stock `anchor "com.apple/*"`; sorts before Apple's own anchors. */
export const MAC_EGRESS_ANCHOR = 'com.apple/050.SaycodeNativeH'

export type MacEgressFence = { browserUid: number; proxyPort: number }

const MIN_SERVICE_UID = 200
const MAX_UID = 2 ** 31 - 1

function assertPort(port: number): void {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid egress proxy port')
}

function assertFence(fence: MacEgressFence): void {
    const { browserUid } = fence
    if (typeof browserUid !== 'number' || !Number.isInteger(browserUid) || browserUid < MIN_SERVICE_UID || browserUid > MAX_UID) {
        throw new Error('invalid fenced browser uid')
    }
    assertPort(fence.proxyPort)
}

/** The anchor ruleset to load with `pfctl -a MAC_EGRESS_ANCHOR -f -`. */
export function renderMacEgressAnchor(fence: MacEgressFence): string {
    assertFence(fence)
    const { browserUid: uid, proxyPort: port } = fence
    return [
        `pass out quick on lo0 inet proto tcp from 127.0.0.1 to 127.0.0.1 port ${port} user ${uid} flags S/SA keep state`,
        `block drop out quick proto { tcp udp } user ${uid}`,
        '',
    ].join('\n')
}

/** The same rules as pfctl prints them back (`pfctl -a MAC_EGRESS_ANCHOR -s rules`). */
function shownRules(fence: MacEgressFence): string[] {
    const { browserUid: uid, proxyPort: port } = fence
    return [
        `pass out quick on lo0 inet proto tcp from 127.0.0.1 to 127.0.0.1 port = ${port} user = ${uid} flags S/SA keep state`,
        `block drop out quick proto tcp all user = ${uid}`,
        `block drop out quick proto udp all user = ${uid}`,
    ]
}

/** True only when the loaded anchor is exactly the expected ruleset, in order. */
export function verifyMacEgressAnchor(shown: string, fence: MacEgressFence): boolean {
    assertFence(fence)
    const lines = shown.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    const expected = shownRules(fence)
    return lines.length === expected.length && lines.every((line, index) => line === expected[index])
}

/** True only when `pfctl -s info` reports pf enabled. */
export function verifyPfEnabled(info: string): boolean {
    return info.split('\n').some((line) => /^Status: Enabled\b/.test(line))
}

/**
 * Chrome arguments that route every connection, including loopback, through
 * the proxy and leave no local DNS or non-proxied UDP path. pf still blocks
 * anything that ignores them.
 */
export function macEgressChromeArgs(proxyPort: number): string[] {
    assertPort(proxyPort)
    return [
        `--proxy-server=socks5://127.0.0.1:${proxyPort}`,
        '--proxy-bypass-list=<-loopback>',
        '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]
}

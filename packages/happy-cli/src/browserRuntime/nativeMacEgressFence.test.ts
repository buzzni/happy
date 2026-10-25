import { describe, expect, it } from 'vitest'
import { MAC_EGRESS_ANCHOR, macEgressChromeArgs, renderMacEgressAnchor, verifyMacEgressAnchor, verifyPfEnabled } from './nativeMacEgressFence'

const fence = { browserUid: 401, proxyPort: 47123 }

// Exactly what `pfctl -n -v` prints for the rendered rules (macOS 26, observed 2026-10-20).
const SHOWN = [
    'pass out quick on lo0 inet proto tcp from 127.0.0.1 to 127.0.0.1 port = 47123 user = 401 flags S/SA keep state',
    'block drop out quick proto tcp all user = 401',
    'block drop out quick proto udp all user = 401',
].join('\n')

describe('Mac pf egress anchor', () => {
    it('lives in an early com.apple sub-anchor so it is evaluated by the stock main ruleset', () => {
        expect(MAC_EGRESS_ANCHOR).toBe('com.apple/050.SaycodeNativeH')
    })

    it('lets the dedicated browser account reach only the loopback proxy port', () => {
        expect(renderMacEgressAnchor(fence)).toBe([
            'pass out quick on lo0 inet proto tcp from 127.0.0.1 to 127.0.0.1 port 47123 user 401 flags S/SA keep state',
            'block drop out quick proto { tcp udp } user 401',
            '',
        ].join('\n'))
    })

    it.each([
        ['root', { browserUid: 0, proxyPort: 47123 }],
        ['system range', { browserUid: 199, proxyPort: 47123 }],
        ['nobody/unsigned wrap', { browserUid: 4294967294, proxyPort: 47123 }],
        ['fractional uid', { browserUid: 401.5, proxyPort: 47123 }],
        ['privileged port', { browserUid: 401, proxyPort: 1023 }],
        ['port overflow', { browserUid: 401, proxyPort: 65536 }],
        ['string uid', { browserUid: '401' as unknown as number, proxyPort: 47123 }],
    ])('refuses to render a fence for %s', (_name, input) => {
        expect(() => renderMacEgressAnchor(input)).toThrow()
    })

    it('accepts the exact rules pfctl reports for the anchor', () => {
        expect(verifyMacEgressAnchor(SHOWN, fence)).toBe(true)
        expect(verifyMacEgressAnchor(`${SHOWN}\n`, fence)).toBe(true)
    })

    it.each([
        ['empty anchor', ''],
        ['missing udp block', SHOWN.split('\n').slice(0, 2).join('\n')],
        ['reordered (block before pass)', [...SHOWN.split('\n').slice(1), SHOWN.split('\n')[0]].join('\n')],
        ['extra pass rule', `${SHOWN}\npass out quick proto tcp all user = 401`],
        ['different uid', SHOWN.replaceAll('user = 401', 'user = 402')],
        ['different port', SHOWN.replace('port = 47123', 'port = 47124')],
        ['pfctl error text', 'pfctl: /dev/pf: Permission denied'],
    ])('rejects %s', (_name, shown) => {
        expect(verifyMacEgressAnchor(shown, fence)).toBe(false)
    })

    it('requires pf to be enabled', () => {
        expect(verifyPfEnabled('No ALTQ support in kernel\nALTQ related functions disabled\nStatus: Enabled for 0 days 00:00:03           Debug: Urgent\n')).toBe(true)
        expect(verifyPfEnabled('Status: Disabled                              Debug: Urgent\n')).toBe(false)
        expect(verifyPfEnabled('pfctl: /dev/pf: Permission denied')).toBe(false)
        expect(verifyPfEnabled('')).toBe(false)
    })
})

describe('Chrome arguments for the fenced browser', () => {
    it('sends every connection through the SOCKS proxy, including loopback, and disables local DNS and non-proxied UDP', () => {
        expect(macEgressChromeArgs(47123)).toEqual([
            '--proxy-server=socks5://127.0.0.1:47123',
            '--proxy-bypass-list=<-loopback>',
            '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ])
    })

    it('rejects an invalid proxy port', () => {
        expect(() => macEgressChromeArgs(0)).toThrow()
    })
})

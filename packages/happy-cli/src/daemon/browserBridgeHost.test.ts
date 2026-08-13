import { describe, it, expect } from 'vitest'
import { resolveBrowserBridgeHost } from './browserBridgeServer'

describe('resolveBrowserBridgeHost', () => {
    it('defaults to loopback when unset', () => {
        expect(resolveBrowserBridgeHost({})).toBe('127.0.0.1')
    })

    it('uses HAPPY_BROWSER_BRIDGE_HOST when set', () => {
        expect(resolveBrowserBridgeHost({ HAPPY_BROWSER_BRIDGE_HOST: '0.0.0.0' })).toBe('0.0.0.0')
    })

    it('falls back to loopback for a blank value rather than passing it to WebSocketServer', () => {
        expect(resolveBrowserBridgeHost({ HAPPY_BROWSER_BRIDGE_HOST: '  ' })).toBe('127.0.0.1')
    })
})

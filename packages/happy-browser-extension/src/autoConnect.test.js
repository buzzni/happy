import { describe, it, expect } from 'vitest'
import { parseAutoConnectParams } from './autoConnect.js'

describe('parseAutoConnectParams', () => {
    it('reads token and port from the query string', () => {
        expect(parseAutoConnectParams('?token=abc123&port=41777')).toEqual({
            token: 'abc123',
            port: 41777,
        })
    })

    it('defaults the port when the link omits it', () => {
        expect(parseAutoConnectParams('?token=abc123')).toEqual({
            token: 'abc123',
            port: 41777,
        })
    })

    it('returns null when there is no token — an ordinary options page visit', () => {
        expect(parseAutoConnectParams('')).toBeNull()
        expect(parseAutoConnectParams('?port=41777')).toBeNull()
    })

    it('returns null for a blank token', () => {
        expect(parseAutoConnectParams('?token=%20%20')).toBeNull()
    })
})

import { describe, expect, it } from 'vitest'
import {
    assertSecureBrokerSocket,
    parseBrowserSessionBrokerRequest,
} from './browserSessionBrokerContract'

const VIEWER_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012345'

describe('browser session broker contract', () => {
    it('accepts only bounded viewer-scoped operations', () => {
        expect(parseBrowserSessionBrokerRequest({ op: 'ensure', viewerKey: VIEWER_KEY, bridgeToken: 'scoped-token-value' }))
            .toEqual({ op: 'ensure', viewerKey: VIEWER_KEY, bridgeToken: 'scoped-token-value' })
        expect(() => parseBrowserSessionBrokerRequest({ op: 'ensure', viewerKey: '../owner', bridgeToken: 'x' }))
            .toThrow('invalid broker request')
        expect(() => parseBrowserSessionBrokerRequest({ op: 'admin-shell', viewerKey: VIEWER_KEY }))
            .toThrow('invalid broker request')
    })

    it('accepts relay activity only for a concrete web port', () => {
        expect(parseBrowserSessionBrokerRequest({ op: 'touch-port', webPort: 6080 }))
            .toEqual({ op: 'touch-port', webPort: 6080 })
        expect(() => parseBrowserSessionBrokerRequest({ op: 'touch-port', webPort: 0 }))
            .toThrow('invalid broker request')
    })

    it('requires a root-owned socket with no permissions for other users', () => {
        expect(() => assertSecureBrokerSocket({ uid: 0, mode: 0o140660, isSocket: true })).not.toThrow()
        expect(() => assertSecureBrokerSocket({ uid: 501, mode: 0o140660, isSocket: true })).toThrow('root-owned')
        expect(() => assertSecureBrokerSocket({ uid: 0, mode: 0o140666, isSocket: true })).toThrow('other-user')
        expect(() => assertSecureBrokerSocket({ uid: 0, mode: 0o140600, isSocket: true })).toThrow('0660')
        expect(() => assertSecureBrokerSocket({ uid: 0, mode: 0o140670, isSocket: true })).toThrow('0660')
        expect(() => assertSecureBrokerSocket({ uid: 0, mode: 0o100660, isSocket: false })).toThrow('Unix socket')
    })
})

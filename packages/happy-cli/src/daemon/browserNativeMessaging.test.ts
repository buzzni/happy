import { describe, expect, it } from 'vitest'
import {
    createNativePairingResponse,
    decodeNativeMessage,
    encodeNativeMessage,
    nativeHostFailureResponse,
} from './browserNativeMessaging'

describe('browser native messaging contract', () => {
    it('prefixes a UTF-8 JSON payload with its 32-bit native-message length', () => {
        const encoded = encodeNativeMessage({ type: 'pair', label: '크롬' })
        const payload = encoded.subarray(4)

        expect(encoded.readUInt32LE(0)).toBe(payload.byteLength)
        expect(JSON.parse(payload.toString('utf8'))).toEqual({ type: 'pair', label: '크롬' })
    })

    it('decodes exactly one length-prefixed JSON message', () => {
        const encoded = encodeNativeMessage({ type: 'pair' })

        expect(decodeNativeMessage(encoded)).toEqual({ type: 'pair' })
    })

    it('rejects truncated and trailing native-message bytes', () => {
        const encoded = encodeNativeMessage({ type: 'pair' })

        expect(() => decodeNativeMessage(encoded.subarray(0, -1))).toThrow('length')
        expect(() => decodeNativeMessage(Buffer.concat([encoded, Buffer.from([0])]))).toThrow('length')
    })

    it.each(['127.0.0.1', 'localhost', '::1'])(
        'returns local pairing config for loopback host %s',
        (host) => {
            expect(createNativePairingResponse({
                request: { type: 'pair' },
                token: 'secret-token',
                port: 41777,
                host,
            })).toEqual({
                ok: true,
                config: { token: 'secret-token', port: 41777, host },
            })
        },
    )

    it('does not distribute the token when the bridge is configured on a non-loopback host', () => {
        const response = createNativePairingResponse({
            request: { type: 'pair' },
            token: 'must-not-leak',
            port: 41777,
            host: '0.0.0.0',
        })

        expect(response).toEqual({
            ok: false,
            error: '자동 연결은 로컬 브리지에서만 사용할 수 있습니다.',
        })
        expect(JSON.stringify(response)).not.toContain('must-not-leak')
    })

    it('rejects unknown requests without returning pairing config', () => {
        expect(createNativePairingResponse({
            request: { type: 'unknown' },
            token: 'must-not-leak',
            port: 41777,
            host: '127.0.0.1',
        })).toEqual({
            ok: false,
            error: '지원하지 않는 Native Messaging 요청입니다.',
        })
    })

    it('uses a fixed failure response that cannot echo a secret from an exception', () => {
        const response = nativeHostFailureResponse(new Error('failed while reading must-not-leak'))

        expect(response).toEqual({
            ok: false,
            error: '로컬 Happy 연결 정보를 읽지 못했습니다.',
        })
        expect(JSON.stringify(response)).not.toContain('must-not-leak')
    })
})

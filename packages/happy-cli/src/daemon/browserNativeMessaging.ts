const NATIVE_MESSAGE_HEADER_BYTES = 4
const MAX_NATIVE_HOST_RESPONSE_BYTES = 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export type NativePairingResponse =
    | { ok: true; config: { token: string; port: number; host: string } }
    | { ok: false; error: string }

export function encodeNativeMessage(message: unknown): Buffer {
    const payload = Buffer.from(JSON.stringify(message), 'utf8')
    if (payload.byteLength > MAX_NATIVE_HOST_RESPONSE_BYTES) {
        throw new Error('Native message exceeds the 1 MiB host response limit')
    }

    const header = Buffer.alloc(NATIVE_MESSAGE_HEADER_BYTES)
    header.writeUInt32LE(payload.byteLength, 0)
    return Buffer.concat([header, payload])
}

export function decodeNativeMessage(message: Buffer): unknown {
    if (message.byteLength < NATIVE_MESSAGE_HEADER_BYTES) {
        throw new Error('Native message length header is missing')
    }

    const payloadLength = message.readUInt32LE(0)
    if (message.byteLength !== NATIVE_MESSAGE_HEADER_BYTES + payloadLength) {
        throw new Error('Native message length does not match its payload')
    }

    return JSON.parse(message.subarray(NATIVE_MESSAGE_HEADER_BYTES).toString('utf8'))
}

export function createNativePairingResponse({ request, token, port, host }: {
    request: unknown
    token: string
    port: number
    host: string
}): NativePairingResponse {
    if (!isPairRequest(request)) {
        return { ok: false, error: '지원하지 않는 Native Messaging 요청입니다.' }
    }
    if (!LOOPBACK_HOSTS.has(host)) {
        return { ok: false, error: '자동 연결은 로컬 브리지에서만 사용할 수 있습니다.' }
    }
    return { ok: true, config: { token, port, host } }
}

export function nativeHostFailureResponse(_error: unknown): NativePairingResponse {
    return { ok: false, error: '로컬 Happy 연결 정보를 읽지 못했습니다.' }
}

function isPairRequest(request: unknown): request is { type: 'pair' } {
    return typeof request === 'object' && request !== null && 'type' in request && request.type === 'pair'
}

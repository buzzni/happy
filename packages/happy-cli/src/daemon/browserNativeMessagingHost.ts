import {
    createNativePairingResponse,
    decodeNativeMessage,
    encodeNativeMessage,
    nativeHostFailureResponse,
} from './browserNativeMessaging'

const NATIVE_MESSAGE_HEADER_BYTES = 4
const MAX_NATIVE_EXTENSION_MESSAGE_BYTES = 64 * 1024 * 1024

export async function runBrowserNativeMessagingHost({
    input,
    write,
    writeError,
    readToken,
    port,
    host,
    consumeSetup,
    offerConnect,
    connect,
}: {
    input: AsyncIterable<Uint8Array>
    write: (chunk: Buffer) => void
    writeError: (message: string) => void
    readToken: () => Promise<string>
    port: number
    host: string
    consumeSetup?: (operationId: string) => Promise<unknown>
    /** Extension-started connection; both reach this user's local daemon. */
    offerConnect?: () => Promise<unknown>
    connect?: (profile: string) => Promise<unknown>
}): Promise<void> {
    try {
        const request = decodeNativeMessage(await readNativeMessageFrame(input))
        if (request && typeof request === 'object' && 'type' in request && request.type === 'setup-pair') {
            if (!('operationId' in request) || typeof request.operationId !== 'string'
                || !/^[A-Za-z0-9_-]{32}$/.test(request.operationId) || !consumeSetup) throw new Error('SETUP_UNAVAILABLE')
            write(encodeNativeMessage(await consumeSetup(request.operationId)))
            return
        }
        if (isRequestOfType(request, 'connect-offer') || isRequestOfType(request, 'connect')) {
            write(encodeNativeMessage(await relayConnect(request, offerConnect, connect)))
            return
        }
        const token = await readToken()
        const response = createNativePairingResponse({ request, token, port, host })
        write(encodeNativeMessage(response))
    } catch (error) {
        writeError('Happy Browser Native Messaging host failed.\n')
        write(encodeNativeMessage(nativeHostFailureResponse(error)))
    }
}

const CONNECT_ERRORS = new Set(['MACHINE_NOT_ELIGIBLE', 'SCOPE_UNAVAILABLE', 'INVALID_PROFILE'])

function isRequestOfType(request: unknown, type: string): request is Record<string, unknown> {
    return typeof request === 'object' && request !== null && 'type' in request && request.type === type
}

/** Passes only a success payload or a known code back to the extension; nothing else the daemon says. */
async function relayConnect(
    request: Record<string, unknown>,
    offerConnect: (() => Promise<unknown>) | undefined,
    connect: ((profile: string) => Promise<unknown>) | undefined,
): Promise<unknown> {
    const profile = request.profile
    if (request.type === 'connect' && (typeof profile !== 'string' || !profile.trim() || profile.length > 128 || /[\x00-\x1f]/.test(profile))) {
        return { ok: false, error: 'INVALID_PROFILE' }
    }
    let result: unknown
    try {
        if (!offerConnect || !connect) throw new Error('SETUP_UNAVAILABLE')
        result = request.type === 'connect' ? await connect(profile as string) : await offerConnect()
    } catch { return { ok: false, error: 'DAEMON_OFFLINE' } }
    const reply = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {}
    if (reply.ok === true && request.type === 'connect' && typeof reply.config === 'object') return { ok: true, config: reply.config }
    if (reply.ok === true && request.type !== 'connect' && typeof reply.account === 'string') return { ok: true, account: reply.account }
    return { ok: false, error: typeof reply.error === 'string' && CONNECT_ERRORS.has(reply.error) ? reply.error : 'SCOPE_UNAVAILABLE' }
}

async function readNativeMessageFrame(input: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const iterator = input[Symbol.asyncIterator]()
    let buffered = Buffer.alloc(0)
    let frameLength: number | null = null

    try {
        while (frameLength === null || buffered.byteLength < frameLength) {
            const next = await iterator.next()
            if (next.done) throw new Error('Native message ended before its declared length')
            buffered = Buffer.concat([buffered, Buffer.from(next.value)])

            if (frameLength === null && buffered.byteLength >= NATIVE_MESSAGE_HEADER_BYTES) {
                const payloadLength = buffered.readUInt32LE(0)
                if (payloadLength > MAX_NATIVE_EXTENSION_MESSAGE_BYTES) {
                    throw new Error('Native message exceeds the 64 MiB extension request limit')
                }
                frameLength = NATIVE_MESSAGE_HEADER_BYTES + payloadLength
            }
        }
        return buffered.subarray(0, frameLength)
    } finally {
        await iterator.return?.()
    }
}
